import zkapiClient, { SESSION_HEADER, ZkapiHttpError } from './services/zkapiClient.js';
import { resolveProviderFromModelId } from './services/providerRegistry.js';

const MODEL_CACHE_KEY = 'zkapi-model-catalog-v1';
const TITLE_PROMPT = 'Return a concise title of at most six words. Output only the title.';

function extractText(payload) {
    const content = payload?.choices?.[0]?.message?.content
        ?? payload?.output?.[0]?.content?.[0]?.text
        ?? payload?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(part => part?.text || part?.content || '').filter(Boolean).join('');
    }
    return '';
}

function extractReasoning(payload) {
    const message = payload?.choices?.[0]?.message;
    return message?.reasoning || message?.reasoning_content || payload?.reasoning || '';
}

function normalizeModel(model) {
    const id = typeof model === 'string' ? model : model?.id;
    if (!id) return null;
    const provider = resolveProviderFromModelId(id).displayName;
    const rawName = typeof model === 'object' ? model.name : null;
    const name = rawName && rawName !== id ? rawName : `${provider}: ${id.split('/').pop()}`;
    return {
        id,
        name,
        provider,
        category: 'Available models',
        categoryPriority: 1,
        context_length: model?.context_length || null,
        pricing: model?.pricing || null
    };
}

class ZkapiInferenceAPI {
    constructor() {
        this.models = this.loadCachedModels();
    }

    loadCachedModels() {
        try {
            const parsed = JSON.parse(localStorage.getItem(MODEL_CACHE_KEY) || '[]');
            return Array.isArray(parsed) ? parsed.map(normalizeModel).filter(Boolean) : [];
        } catch {
            return [];
        }
    }

    saveModels(models) {
        this.models = models;
        try {
            localStorage.setItem(MODEL_CACHE_KEY, JSON.stringify(models));
        } catch {
            // The catalog remains usable for this tab if persistent storage is full.
        }
    }

    getCachedModels() {
        return this.models;
    }

    async fetchModels() {
        await zkapiClient.init();
        const configured = zkapiClient.config?.funding?.models || [];
        const models = configured.map(normalizeModel).filter(Boolean);
        if (models.length === 0) {
            const response = await fetch('/v1/models', { credentials: 'same-origin' });
            if (response.ok) {
                const payload = await response.json();
                models.push(...(payload?.data || []).map(normalizeModel).filter(Boolean));
            }
        }
        if (models.length === 0) {
            models.push(normalizeModel('openai/gpt-4o-mini'));
        }
        this.saveModels(models);
        return models;
    }

    getDisplayName(modelId, fallback) {
        return this.models.find(model => model.id === modelId)?.name || fallback || modelId;
    }

    async request(path, body, sessionId, abortController = null) {
        const response = await fetch(path, {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'content-type': 'application/json',
                [SESSION_HEADER]: sessionId
            },
            body: JSON.stringify({ ...body, stream: false }),
            signal: abortController?.signal
        });
        const text = await response.text();
        let payload = {};
        try {
            payload = text ? JSON.parse(text) : {};
        } catch {
            payload = { raw: text };
        }
        if (!response.ok) {
            const details = payload?.error || {};
            const error = new ZkapiHttpError(
                details.message || payload.message || response.statusText,
                response.status,
                details.code || payload.code,
                payload
            );
            if (response.status === 402) {
                window.dispatchEvent(new CustomEvent('zkapi-payment-required', { detail: { error } }));
            }
            throw error;
        }
        return payload;
    }

    async sendCompletion(messages, modelId, sessionId) {
        return this.request('/v1/chat/completions', { model: modelId, messages }, sessionId);
    }

    async generateSessionTitle(prompt, sessionId, options = {}) {
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), options.timeoutMs || 10_000);
        try {
            const payload = await this.request('/v1/chat/completions', {
                model: options.modelId || this.models[0]?.id || 'openai/gpt-4o-mini',
                max_tokens: 24,
                temperature: 0.2,
                messages: [
                    { role: 'system', content: TITLE_PROMPT },
                    { role: 'user', content: String(prompt || '').slice(0, 1200) }
                ]
            }, sessionId, controller);
            return extractText(payload).replace(/^\s*["'`]+|["'`]+\s*$/g, '').trim();
        } finally {
            window.clearTimeout(timeout);
            void zkapiClient.refresh({ quiet: true });
        }
    }

    async streamCompletion(
        messages,
        modelId,
        sessionId,
        onChunk,
        onTokenUpdate,
        files = [],
        searchEnabled = false,
        abortController = null,
        onStreamOpen = null,
        onReasoningChunk = null,
        reasoningEnabled = true,
        reasoningEffort = 'medium'
    ) {
        let effectiveModel = modelId;
        if (searchEnabled && !effectiveModel.endsWith(':online')) {
            effectiveModel = `${effectiveModel}:online`;
        }

        let processedMessages = messages;
        if (files?.length) {
            const { filesToMultimodalContent } = await import('./services/fileUtils.js');
            const content = await filesToMultimodalContent(files);
            const last = messages[messages.length - 1];
            if (last?.role === 'user') {
                processedMessages = [
                    ...messages.slice(0, -1),
                    { ...last, content: [{ type: 'text', text: last.content }, ...content] }
                ];
            }
        }

        try {
            const payload = await this.request('/v1/chat/completions', {
                model: effectiveModel,
                messages: processedMessages,
                ...(reasoningEnabled ? { reasoning: { effort: reasoningEffort } } : {})
            }, sessionId, abortController);

            await onStreamOpen?.();
            const reasoning = extractReasoning(payload);
            if (reasoning) await onReasoningChunk?.(reasoning);
            const content = extractText(payload);
            if (content) await onChunk?.(content);

            const usage = payload?.usage || {};
            const completionTokens = usage.completion_tokens || Math.ceil(content.length / 4);
            onTokenUpdate?.({ completionTokens, isStreaming: false });
            return {
                totalTokens: usage.total_tokens || null,
                promptTokens: usage.prompt_tokens || null,
                completionTokens,
                model: payload?.model || modelId,
                reasoning: reasoning || null,
                citations: payload?.citations || null
            };
        } catch (error) {
            if (error?.name === 'AbortError') {
                error.isCancelled = true;
            }
            throw error;
        } finally {
            void zkapiClient.refresh({ quiet: true });
        }
    }
}

const zkapiInferenceAPI = new ZkapiInferenceAPI();
export default zkapiInferenceAPI;
