import { createInferenceService, openRouterBackend, acquireVerifiedAccess } from '../../oa-chat/chat/publicInferenceApi.js';
import { modelConfiguration as ticketModels } from '../../oa-chat/chat/publicRuntimeApi.js';
import { createZkapiChatRuntime } from './zkapiChatRuntime.js';
import zkapiBackend from './inference/backends/zkapiBackend.js';
import * as zkModels from './modelConfig.js';
import { createPaymentModeRuntimeCore, PAYMENT_MODE_PREFERENCE } from './paymentModeRuntimeCore.mjs';

export function createPaymentModeRuntime() {
    let storage = null;
    let initialMode = 'tickets';
    try {
        storage = window.localStorage;
        initialMode = storage.getItem(PAYMENT_MODE_PREFERENCE) === 'zkapi' ? 'zkapi' : 'tickets';
    } catch { /* Storage may be unavailable until OA reports its normal error. */ }
    let runtime;
    const currentModels = session => runtime?.getMode(session) === 'zkapi' ? zkModels : ticketModels;
    const modelConfiguration = {
        initPinnedModels: () => Promise.all([ticketModels.initPinnedModels(), zkModels.initPinnedModels()]),
        onPinnedModelsUpdate(callback) {
            const cleanup = [ticketModels.onPinnedModelsUpdate(callback), zkModels.onPinnedModelsUpdate(callback)];
            return () => cleanup.forEach(unsubscribe => unsubscribe?.());
        },
        getDefaultModelConfig: session => currentModels(session).getDefaultModelConfig(),
        getDisabledModels: session => currentModels(session).getDisabledModels(),
        getPinnedModels: session => currentModels(session).getPinnedModels()
    };
    const inferenceService = createInferenceService({
        backends: [openRouterBackend, zkapiBackend],
        defaultBackendId: initialMode === 'zkapi' ? 'zkapi' : 'openrouter',
        legacyBackendId: 'openrouter',
        resolveLegacyBackendId: session => session?.zkapiSessionId || session?.apiKeyInfo?.backendId === 'zkapi'
            ? 'zkapi' : 'openrouter',
        resolveDefaultModelConfig: backend => (backend.id === 'zkapi' ? zkModels : ticketModels).getDefaultModelConfig()
    });
    runtime = createPaymentModeRuntimeCore({ zkRuntime: createZkapiChatRuntime(), inferenceService,
        acquireVerifiedAccess, modelConfiguration, preferenceStorage: storage, initialMode });
    return runtime;
}
