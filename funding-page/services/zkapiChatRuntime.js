import zkapiClient from './zkapiClient.js';
import zkapiBackend from './inference/backends/zkapiBackend.js';
import { createInferenceService } from '../../oa-chat/chat/publicInferenceApi.js';
import * as modelConfiguration from './modelConfig.js';
import { createZkapiChatRuntimeCore } from './zkapiChatRuntimeCore.mjs';
import { ensureModelTiersReady } from '../../oa-chat/chat/publicModelTierApi.js';
import { getModelBudget } from './zkapiModelBudget.mjs';

/** Production defaults; the lifecycle core has no browser/wallet side effects. */
export function createZkapiChatRuntime(options = {}) {
    return createZkapiChatRuntimeCore({
        client: zkapiClient,
        backend: zkapiBackend,
        createInferenceService,
        modelConfiguration,
        resolveModelBudget: async (modelId, reasoningEnabled, signal) => {
            await ensureModelTiersReady({ signal });
            return getModelBudget(modelId, reasoningEnabled);
        },
        ...options
    });
}
