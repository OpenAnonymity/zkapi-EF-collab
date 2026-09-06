import zkapiClient from './zkapiClient.js';
import zkapiBackend from './inference/backends/zkapiBackend.js';
import { createInferenceService } from '../../oa-chat/chat/publicInferenceApi.js';
import * as modelConfiguration from './modelConfig.js';
import { createZkapiChatRuntimeCore } from './zkapiChatRuntimeCore.mjs';

/** Production defaults; the lifecycle core has no browser/wallet side effects. */
export function createZkapiChatRuntime(options = {}) {
    return createZkapiChatRuntimeCore({
        client: zkapiClient,
        backend: zkapiBackend,
        createInferenceService,
        modelConfiguration,
        ...options
    });
}
