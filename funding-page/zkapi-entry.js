import { createChatApp } from '../oa-chat/chat/publicApi.js';
import { createPaymentModeRuntime } from './services/paymentModeRuntime.js';
import { createPaymentModeUi } from './ui/createPaymentModeUi.js';

const runtime = createPaymentModeRuntime();
const ui = createPaymentModeUi(runtime);

function start() {
    createChatApp({ routeRoot: '/funding/', runtime, ui, analytics: false });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
else start();
