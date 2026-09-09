// Product-owned model catalog and access policy; OA owns request/stream parsing.
import { OpenRouterAPI } from '../oa-chat/chat/publicInferenceApi.js';
import { modelTiers } from '../oa-chat/chat/publicRuntimeApi.js';
import networkProxy from './services/networkProxy.js';
import { loadModelCatalog, saveModelCatalog } from './services/modelCatalogCache.js';
import { normalizeOpenRouterModelProviders } from './services/providerRegistry.js';
import { getDefaultModelConfig } from './services/modelConfig.js';
import zkapiClient from './services/zkapiClient.js';
import { ensureDirectCompletionLimit } from './services/zkapiRequestCompat.mjs';
import { getModelBudget } from './services/zkapiModelBudget.mjs';
import {
    BUNDLED_MODEL_CATALOG,
    DEFAULT_MODEL_ID,
    DEFAULT_MODEL_NAME,
    baseModelId,
    enrichConfiguredModels,
    estimateTextTokens
} from './services/modelPricing.mjs';

const ZKAPI_BACKEND_ID = 'zkapi';
const TITLE_SUMMARY_MODEL_ID = 'google/gemini-3.1-flash-lite-preview';

export class ZkapiAPI extends OpenRouterAPI {
    constructor({ modelCatalog = null } = {}) {
        super({
            networkTransport: networkProxy,
            acquireRequestAccess: async (sessionId, options) => {
                const { modelId, accessModelId, reasoningEnabled = true, ...accessOptions } = options;
                await modelTiers.ensureModelTiersReady({ signal: accessOptions.signal });
                const { spendingLimitUsd } = getModelBudget(accessModelId || modelId, reasoningEnabled);
                const access = await zkapiClient.acquireInferenceAccess(sessionId, {
                    ...accessOptions,
                    spendingLimitUsd
                });
                return {
                    ...access,
                    proxyConfig: access.mode === 'daemon' ? { bypassProxy: true } : undefined
                };
            },
            prepareRequestBody: (body, { access, model }) => ensureDirectCompletionLimit(body, {
                spendingLimitUsd: access.spendingLimitUsd,
                model
            }),
            estimatePromptTokens: estimateTextTokens,
            onRequestError: error => {
                if (error?.status === 402 && typeof window !== 'undefined') {
                    window.dispatchEvent(new CustomEvent('zkapi-payment-required', { detail: { error } }));
                }
            },
            onRequestFinished: () => { void zkapiClient.refresh({ quiet: true }).catch(() => {}); }
        });
        this.modelCatalog = modelCatalog;
        if (!modelCatalog) this.displayNameOverrides = { ...getDefaultModelConfig().displayNameOverrides };
    }

    getCachedModels() {
        if (this.modelCatalog) return this.modelCatalog.getCachedModels();
        const cachedModels = loadModelCatalog(ZKAPI_BACKEND_ID);
        if (!Array.isArray(cachedModels)) {
            return [];
        }
        return normalizeOpenRouterModelProviders(cachedModels).map(model => ({
            ...model,
            name: this.getDisplayName(model.id, model.name, model.provider)
        }));
    }

    getDisplayName(modelId, fallback, provider) {
        return this.modelCatalog
            ? this.modelCatalog.getDisplayName(modelId, fallback)
            : super.getDisplayName(modelId, fallback, provider);
    }

    // Dual-mode chat shares OA's catalog, independent of wallet readiness.
    // Preserve the configured catalog for standalone/legacy daemon clients.
    async fetchModels() {
        if (this.modelCatalog) return this.modelCatalog.fetchModels();
        try {
            await zkapiClient.init();
            const configured = zkapiClient.config?.funding?.models || [];
            let rawModels = configured.map(model => (
                typeof model === 'string' ? { id: model, name: model } : model
            ));
            if (rawModels.length === 0 && !zkapiClient.browserMode) {
                const response = await fetch('/v1/models', { credentials: 'same-origin' });
                if (response.ok) {
                    const payload = await response.json();
                    rawModels = payload?.data || [];
                }
            }
            let liveModels = [];
            try {
                // Keep the public catalog behind a neutral same-origin path.
                // Some browser privacy extensions block URLs containing the
                // provider name, which otherwise leaves stale display pricing.
                const response = await fetch('/zkapi-model-catalog', {
                    credentials: 'omit',
                    signal: AbortSignal.timeout(5000)
                });
                if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
                    const payload = await response.json();
                    liveModels = Array.isArray(payload?.data) ? payload.data : [];
                }
            } catch (catalogError) {
                console.debug('Using bundled model pricing:', catalogError);
            }
            rawModels = enrichConfiguredModels(rawModels, liveModels);
            const formattedModels = this.formatModels(rawModels);
            if (formattedModels.length === 0) {
                throw new Error('The zkAPI deployment returned an empty model catalog');
            }

            saveModelCatalog(ZKAPI_BACKEND_ID, formattedModels);

            return formattedModels;
        } catch (error) {
            console.error('Error fetching zkAPI models:', error);

            const cachedModels = this.getCachedModels();
            if (cachedModels.length > 0) {
                console.warn('Using cached model catalog for zkAPI.');
                return cachedModels;
            }

            return [{
                id: DEFAULT_MODEL_ID,
                name: DEFAULT_MODEL_NAME,
                category: 'Flagship models',
                categoryPriority: 1,
                provider: 'OpenAI',
                ...BUNDLED_MODEL_CATALOG[DEFAULT_MODEL_ID]
            }];
        }
    }

    getModelBudgetMetadata(modelId) {
        return this.getCachedModels().find(model => model.id === modelId)
            || super.getModelBudgetMetadata(modelId)
            || BUNDLED_MODEL_CATALOG[baseModelId(modelId)] || null;
    }

    generateSessionTitle(prompt, sessionId, options = {}) {
        return super.generateSessionTitle(prompt, sessionId, {
            ...options,
            modelId: options.modelId || TITLE_SUMMARY_MODEL_ID
        });
    }

    // Payment failures must surface; never substitute OA's offline demo response.
    async sendCompletion(messages, modelId, sessionId) {
        return (await this.sendCompletionStrict(messages, modelId, sessionId)).content;
    }
}

const openRouterAPI = new ZkapiAPI();
if (typeof window !== 'undefined') window.openRouterAPI = openRouterAPI;
export default openRouterAPI;
