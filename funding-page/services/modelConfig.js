/**
 * Model Configuration Service
 *
 * Source of truth for:
 * - Pinned model IDs (from org API with local cache)
 * - Disabled model IDs (from org API with local cache)
 * - Static UI defaults (default model and display-name overrides)
 */

import { standardizeModelDisplayName } from './modelNames.js';
import { DEFAULT_MODEL_ID } from './modelPricing.mjs';

// Cache key for pinned/disabled model metadata
const MODEL_AVAILABILITY_CACHE_KEY = 'oa-model-availability-cache';

// Event target for notifying listeners of updates
const eventTarget = new EventTarget();

// Runtime model availability state (populated from cache/API)
let pinnedModels = [];
let disabledModels = [];
let updatedAt = null;

// Fallback pinned models (used when API is unavailable or returns empty)
const FALLBACK_PINNED_MODELS = [
    DEFAULT_MODEL_ID,
    'openai/gpt-4o-mini',
];

// Static configuration defaults
const DEFAULT_CONFIG = {
    // Custom display name overrides (model ID -> display name)
    displayNameOverrides: {
        [DEFAULT_MODEL_ID]: 'OpenAI: GPT-5.6 Sol',
        'openai/gpt-5.3-chat': 'OpenAI: GPT-5.3 Instant',
        'openai/gpt-5.3': 'OpenAI: GPT-5.3 Thinking',
        'openai/gpt-5.2-chat': 'OpenAI: GPT-5.2 Instant',
        'openai/gpt-5.1-chat': 'OpenAI: GPT-5.1 Instant',
        'openai/gpt-5-chat': 'OpenAI: GPT-5 Instant',
        'openai/gpt-5.2': 'OpenAI: GPT-5.2 Thinking',
        'openai/gpt-5.1': 'OpenAI: GPT-5.1 Thinking',
        'openai/gpt-5': 'OpenAI: GPT-5 Thinking',
    },
};

/**
 * Backward-compatible wrapper around the dedicated model-name standardizer.
 * Keeps default display-name overrides colocated with model config.
 */
export function getStandardizedModelDisplayName(modelReference) {
    return standardizeModelDisplayName(modelReference, {
        displayNameOverrides: DEFAULT_CONFIG.displayNameOverrides
    });
}

function normalizeModelIdList(value) {
    if (!Array.isArray(value)) return [];

    const seen = new Set();
    const normalized = [];

    for (const raw of value) {
        if (typeof raw !== 'string') continue;
        const id = raw.trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        normalized.push(id);
    }

    return normalized;
}

function normalizeUpdatedAt(value) {
    return Number.isFinite(value) ? value : null;
}

/**
 * Normalize API/cache payload and apply overlap rule:
 * - duplicates removed (order preserved)
 * - if a model is both pinned and disabled, disabled wins
 */
function normalizeAvailabilityPayload(payload, { preserveDisabledWhenMissing = false } = {}) {
    const pinned = normalizeModelIdList(payload?.pinned_models);

    const hasDisabledList = Array.isArray(payload?.disabled_models);
    const disabled = hasDisabledList
        ? normalizeModelIdList(payload.disabled_models)
        : (preserveDisabledWhenMissing ? disabledModels : []);

    const disabledSet = new Set(disabled);
    const pinnedWithoutDisabled = pinned.filter(modelId => !disabledSet.has(modelId));
    const prioritizedPinned = pinnedWithoutDisabled.includes(DEFAULT_MODEL_ID)
        ? [DEFAULT_MODEL_ID, ...pinnedWithoutDisabled.filter(modelId => modelId !== DEFAULT_MODEL_ID)]
        : pinnedWithoutDisabled;

    return {
        pinned_models: prioritizedPinned,
        disabled_models: disabled,
        updated_at: normalizeUpdatedAt(payload?.updated_at)
    };
}

function writeAvailabilityState(normalized) {
    pinnedModels = normalized.pinned_models;
    disabledModels = normalized.disabled_models;
    updatedAt = normalized.updated_at;
}

/**
 * Load cached availability data from localStorage.
 */
function loadAvailabilityCache() {
    try {
        const cache = localStorage.getItem(MODEL_AVAILABILITY_CACHE_KEY);
        if (!cache) return;

        const parsed = JSON.parse(cache);
        const normalized = normalizeAvailabilityPayload(parsed, {
            preserveDisabledWhenMissing: true
        });
        writeAvailabilityState(normalized);
    } catch (e) {
        console.warn('Failed to load model availability cache:', e);
    }
}

/**
 * Fetch pinned/disabled models from API.
 * @returns {Promise<Object|null>} Availability payload or null on error
 */
async function fetchModelAvailability() {
    try {
        let config = null;
        // Hosted browser builds expose the signed deployment manifest through
        // a same-origin rewrite. The local daemon keeps its richer legacy
        // endpoint, so retain it as a compatibility fallback.
        for (const endpoint of ['/zkapi-deployment/config.json', '/zkapi/v1/config']) {
            const response = await fetch(endpoint, { credentials: 'same-origin' });
            if (!response.ok) continue;
            config = await response.json();
            break;
        }
        if (!config) return null;
        const advertisedModels = config?.funding?.models || config?.models;
        const models = Array.isArray(advertisedModels)
            ? advertisedModels.map(model => typeof model === 'string' ? model : model?.id).filter(Boolean)
            : [];
        return {
            pinned_models: models,
            disabled_models: [],
            updated_at: Date.now()
        };
    } catch (e) {
        console.warn('Failed to fetch zkAPI model availability:', e);
        return null;
    }
}

function saveAvailabilityCache(normalized) {
    try {
        localStorage.setItem(MODEL_AVAILABILITY_CACHE_KEY, JSON.stringify(normalized));
    } catch (e) {
        console.warn('Failed to save model availability cache:', e);
    }
}

function availabilitySignature() {
    return `${pinnedModels.join(',')}|${disabledModels.join(',')}|${updatedAt ?? ''}`;
}

/**
 * Initialize model availability state.
 * Loads from cache immediately, then fetches fresh data in background.
 */
export async function initPinnedModels() {
    // Load cached data first (synchronous, fast)
    loadAvailabilityCache();

    const before = availabilitySignature();

    // Fetch fresh data in background
    const data = await fetchModelAvailability();
    if (!data) return;

    const normalized = normalizeAvailabilityPayload(data, {
        preserveDisabledWhenMissing: true
    });
    writeAvailabilityState(normalized);
    saveAvailabilityCache(normalized);

    if (availabilitySignature() !== before) {
        eventTarget.dispatchEvent(new CustomEvent('update'));
    }
}

/**
 * Add listener for pinned/disabled model updates.
 * @param {Function} callback - Called when availability data updates
 * @returns {Function} Cleanup function to remove listener
 */
export function onPinnedModelsUpdate(callback) {
    eventTarget.addEventListener('update', callback);
    return () => eventTarget.removeEventListener('update', callback);
}

/**
 * Get pinned models with fallback.
 * Uses API/cache data if available, otherwise falls back to hardcoded defaults.
 * Disabled models are always excluded.
 * @returns {string[]} Array of pinned model IDs
 */
export function getPinnedModels() {
    if (pinnedModels.length > 0) {
        return pinnedModels;
    }

    try {
        const cached = JSON.parse(localStorage.getItem('zkapi-model-catalog-v1') || '[]');
        const ids = normalizeModelIdList(cached.map(model => model?.id));
        if (ids.length > 0) return ids;
    } catch {
        // Fall through to the local-daemon default.
    }

    if (disabledModels.length === 0) {
        return FALLBACK_PINNED_MODELS;
    }

    const disabledSet = new Set(disabledModels);
    return FALLBACK_PINNED_MODELS.filter(modelId => !disabledSet.has(modelId));
}

/**
 * Get disabled models from API/cache.
 * @returns {string[]} Array of disabled model IDs
 */
export function getDisabledModels() {
    return disabledModels;
}

/**
 * Get the default model ID.
 * Prefer GPT-5.6 Sol whenever the deployment advertises it, independent of
 * manifest ordering. Fall back to the deployment's first available model.
 * @returns {string|null}
 */
export function getDefaultModelId() {
    const available = getPinnedModels();
    return available.includes(DEFAULT_MODEL_ID)
        ? DEFAULT_MODEL_ID
        : available[0] || FALLBACK_PINNED_MODELS[0] || null;
}

/**
 * Get the default model display name.
 * @returns {string}
 */
export function getDefaultModelName() {
    const modelId = getDefaultModelId();
    return getStandardizedModelDisplayName(modelId) || modelId || '';
}

/**
 * Get static defaults + current availability state.
 * @returns {Object}
 */
export function getDefaultModelConfig() {
    return {
        ...DEFAULT_CONFIG,
        defaultModelId: getDefaultModelId(),
        defaultModelName: getDefaultModelName(),
        pinnedModels: getPinnedModels(),
        disabledModels: getDisabledModels()
    };
}

// Load cache on module init (synchronous)
loadAvailabilityCache();
