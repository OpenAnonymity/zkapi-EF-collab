import { createChatApp } from '../oa-chat/chat/publicApi.js';
import { createZkapiChatRuntime } from './services/zkapiChatRuntime.js';
import { createZkapiUi } from './ui/createZkapiUi.js';

const runtime = createZkapiChatRuntime();
const ui = createZkapiUi(runtime);

function start() {
    createChatApp({ routeRoot: '/funding/', runtime, ui, analytics: false });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
else start();
