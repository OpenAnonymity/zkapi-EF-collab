import assert from 'node:assert/strict';
import test from 'node:test';

// Import the actual composition with a small browser shell. Network and wallet
// boundaries are replaced below; catalog formatting, caching, configuration,
// backend selection, and presentation run through their production modules.
const values = new Map();
const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
    clear: () => values.clear()
};
globalThis.window = globalThis;
globalThis.location = { hostname: 'localhost', origin: 'http://localhost', href: 'http://localhost/funding/', search: '' };
globalThis.localStorage = storage;
globalThis.sessionStorage = storage;
globalThis.addEventListener = () => {};
globalThis.dispatchEvent = () => {};
globalThis.document = {
    querySelector: () => null,
    getElementById: () => null,
    addEventListener() {},
    documentElement: { dataset: {}, classList: { contains: () => false } },
    createElement() {
        let text = '';
        return {
            set textContent(value) { text = String(value ?? ''); },
            get textContent() { return text; },
            get innerHTML() { return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }
        };
    }
};
const request = result => {
    const value = {};
    queueMicrotask(() => { value.result = result; value.onsuccess?.({ target: value }); });
    return value;
};
const settingsStore = { get: () => request(undefined), put: () => request(undefined), delete: () => request(undefined) };
globalThis.indexedDB = { open: () => request({ version: 4, close() {}, transaction: () => ({ objectStore: () => settingsStore }) }) };
globalThis.zkapiWallet = new Proxy({ ABI: [] }, {
    get: (target, key) => key in target ? target[key] : (() => null)
});

const { ZkapiAPI } = await import('./api.js');
const { default: zkapiClient } = await import('./services/zkapiClient.js');
const { createZkapiBackend } = await import('./services/inference/backends/zkapiBackend.js');
const { createPaymentModeRuntime } = await import('./services/paymentModeRuntime.js');
const { createPaymentModeUi } = await import('./ui/createPaymentModeUi.js');
const { openRouterBackend } = await import('../oa-chat/chat/publicInferenceApi.js');
const { networkProxy, loadModelCatalog, saveModelCatalog } = await import('../oa-chat/chat/publicRuntimeApi.js');
const { default: ticketApi } = await import('../oa-chat/chat/api.js');

const CATALOG = [
    { id: 'openrouter/auto', name: 'Auto Router', pricing: { prompt: '0', completion: '0' }, context_length: 128000 },
    { id: 'openai/gpt-5.3', name: 'Provider GPT 5.3', pricing: { prompt: '0.000002', completion: '0.000008' }, context_length: 200000, top_provider: { max_completion_tokens: 32000 } },
    { id: 'openai/gpt-5.3:batch', name: 'Provider GPT 5.3 Batch', pricing: { prompt: '0.000001', completion: '0.000004' }, context_length: 100000, top_provider: { max_completion_tokens: 16000 } },
    { id: 'deepseek/catalog-only-model', name: 'Catalog Only Model', pricing: { prompt: '0.0000004', completion: '0.0000008' }, context_length: 64000 },
    ...Array.from({ length: 8 }, (_, index) => ({
        id: `qwen/catalog-model-${index}`, name: `Qwen Catalog Model ${index}`,
        pricing: { prompt: '0.0000001', completion: '0.0000002' }, context_length: 32000
    }))
];
const OLD_ZK_CATALOG = [{ id: 'openai/gpt-4o-mini', name: 'Old lone zkAPI model', provider: 'OpenAI' }];
const ticketSession = { id: 'historical-ticket-chat', inferenceBackend: 'openrouter' };
const privateSession = { id: 'historical-private-chat', inferenceBackend: 'zkapi' };

function forbidWalletCatalogAccess(t) {
    const initialization = t.mock.method(zkapiClient, 'init', () => { throw new Error('Catalog browsing must not initialize a wallet'); });
    const descriptor = Object.getOwnPropertyDescriptor(zkapiClient, 'config');
    Object.defineProperty(zkapiClient, 'config', { configurable: true, get() { throw new Error('Catalog browsing must not consult the deployment allowlist'); } });
    t.after(() => Object.defineProperty(zkapiClient, 'config', descriptor));
    return initialization;
}

test.beforeEach(() => storage.clear());

test('an injected catalog owns cached models, live models and display names without wallet access', async t => {
    const initialization = forbidWalletCatalogAccess(t);
    const source = {
        getCachedModels() { assert.equal(this, source); return CATALOG; },
        async fetchModels() { assert.equal(this, source); return CATALOG; },
        getDisplayName(modelId, fallback) { assert.equal(this, source); return `${fallback}: ${modelId}`; }
    };
    const api = new ZkapiAPI({ modelCatalog: source });
    const backend = createZkapiBackend(api);
    assert.equal(api.getCachedModels(), CATALOG);
    assert.equal(await api.fetchModels(), CATALOG);
    assert.equal(await backend.fetchModels(), CATALOG);
    assert.equal(backend.getCachedModels(), CATALOG);
    assert.equal(backend.getDisplayName('deepseek/catalog-only-model', 'Shared name'), 'Shared name: deepseek/catalog-only-model');
    assert.equal(initialization.mock.callCount(), 0);
});

test('both payment modes load the same full OA catalog and ignore a stale one-model zkAPI cache', async t => {
    saveModelCatalog('zkapi', OLD_ZK_CATALOG);
    const oldCache = loadModelCatalog('zkapi');
    const initialization = forbidWalletCatalogAccess(t);
    const transport = t.mock.method(networkProxy, 'fetchWithRetryJson', async url => {
        assert.equal(url, 'https://openrouter.ai/api/v1/models');
        return { response: { ok: true, status: 200 }, data: { data: CATALOG } };
    });
    const runtime = createPaymentModeRuntime();
    const tickets = await runtime.inferenceService.fetchModels(ticketSession);
    const privateModels = await runtime.inferenceService.fetchModels(privateSession);
    assert.deepEqual(privateModels, tickets);
    assert.equal(privateModels.length, CATALOG.length);
    assert.ok(privateModels.some(model => model.id === 'deepseek/catalog-only-model'));
    assert.ok(!privateModels.some(model => model.id === OLD_ZK_CATALOG[0].id));
    for (const session of [ticketSession, privateSession]) {
        assert.deepEqual(runtime.inferenceService.getCachedModels(session), JSON.parse(JSON.stringify(tickets)));
        for (const model of tickets) {
            assert.equal(runtime.inferenceService.getDisplayName(model.id, model.name, session), openRouterBackend.getDisplayName(model.id, model.name));
        }
    }
    assert.deepEqual(loadModelCatalog('zkapi'), oldCache, 'shared mode does not read or overwrite the legacy catalog');
    assert.equal(transport.mock.callCount(), 2);
    assert.equal(initialization.mock.callCount(), 0);
});

test('a fresh runtime preserves the entire shared cached catalog in zkAPI mode during a provider outage', async t => {
    saveModelCatalog('openrouter', ticketApi.formatModels(CATALOG));
    saveModelCatalog('zkapi', OLD_ZK_CATALOG);
    storage.setItem('oa-payment-mode', 'zkapi');
    const expected = openRouterBackend.getCachedModels();
    const initialization = forbidWalletCatalogAccess(t);
    t.mock.method(networkProxy, 'fetchWithRetryJson', async () => { throw new Error('Catalog offline'); });
    t.mock.method(console, 'error', () => {});
    t.mock.method(console, 'warn', () => {});
    const runtime = createPaymentModeRuntime();
    assert.equal(runtime.getMode(), 'zkapi');
    assert.deepEqual(runtime.inferenceService.getCachedModels(), expected);
    assert.deepEqual(await runtime.inferenceService.fetchModels(), expected);
    assert.deepEqual(await runtime.inferenceService.fetchModels(ticketSession), expected);
    assert.equal(expected.length, CATALOG.length);
    assert.equal(initialization.mock.callCount(), 0);
});

test('pinned, disabled and default models follow the same OA availability update in both modes', async t => {
    const payload = {
        pinned_models: ['deepseek/catalog-only-model', 'openai/gpt-5.3', 'openai/gpt-5.3:batch'],
        disabled_models: ['openrouter/auto', 'openai/gpt-5.3'],
        updated_at: 123456
    };
    const requests = t.mock.method(globalThis, 'fetch', async url => {
        assert.ok(String(url).endsWith('/chat/pinned-models'));
        return { ok: true, json: async () => payload };
    });
    const runtime = createPaymentModeRuntime();
    let updates = 0;
    const unsubscribe = runtime.modelConfiguration.onPinnedModelsUpdate(() => { updates += 1; });
    t.after(unsubscribe);
    await runtime.modelConfiguration.initPinnedModels();
    for (const session of [ticketSession, privateSession]) {
        assert.deepEqual(runtime.modelConfiguration.getPinnedModels(session), ['deepseek/catalog-only-model', 'openai/gpt-5.3:batch']);
        assert.deepEqual(runtime.modelConfiguration.getDisabledModels(session), payload.disabled_models);
        assert.equal(runtime.modelConfiguration.getDefaultModelConfig(session).defaultModelId, 'deepseek/catalog-only-model');
        assert.equal(runtime.inferenceService.getDefaultModelId(session), 'deepseek/catalog-only-model');
    }
    assert.equal(runtime.inferenceService.getDefaultModelName(privateSession), runtime.inferenceService.getDefaultModelName(ticketSession));
    assert.equal(requests.mock.callCount(), 1);
    assert.equal(updates, 1);
});

test('exact variant prices and output limits come from the shared catalog while only zkAPI displays token prices', () => {
    saveModelCatalog('openrouter', ticketApi.formatModels(CATALOG));
    saveModelCatalog('zkapi', OLD_ZK_CATALOG);
    const api = new ZkapiAPI({ modelCatalog: openRouterBackend });
    const base = api.getModelBudgetMetadata('openai/gpt-5.3');
    const variant = api.getModelBudgetMetadata('openai/gpt-5.3:batch');
    assert.deepEqual(base.pricing, CATALOG[1].pricing);
    assert.deepEqual(variant.pricing, CATALOG[2].pricing);
    assert.equal(base.top_provider.max_completion_tokens, 32000);
    assert.equal(variant.top_provider.max_completion_tokens, 16000);
    assert.equal(variant.context_length, 100000);
    assert.deepEqual(api.getModelBudgetMetadata('openai/gpt-5.3:nitro'), base);
    assert.equal(api.getModelBudgetMetadata('missing/unknown-model'), null);

    const runtime = createPaymentModeRuntime();
    const ui = createPaymentModeUi(runtime);
    assert.equal(ui.presentation.getModelPricing(variant), null);
    runtime.inferenceService.setDefaultBackendId('zkapi');
    assert.deepEqual(ui.presentation.getModelPricing(variant), {
        label: '$1/M input · $4/M output',
        description: 'Input $0.000001/token · output $0.000004/token'
    });
    runtime.inferenceService.setDefaultBackendId('openrouter');
    assert.equal(ui.presentation.getModelPricing(variant), null);
});

test('the standalone zkAPI API retains its legacy catalog when no shared catalog is supplied', () => {
    saveModelCatalog('openrouter', ticketApi.formatModels(CATALOG));
    saveModelCatalog('zkapi', OLD_ZK_CATALOG);
    const legacy = new ZkapiAPI();
    const models = createZkapiBackend(legacy).getCachedModels();
    assert.deepEqual(models.map(model => model.id), ['openai/gpt-4o-mini']);
    assert.ok(legacy.getModelBudgetMetadata('openai/gpt-5.6-sol')?.pricing, 'the bundled pricing fallback remains available for uncached models');
});
