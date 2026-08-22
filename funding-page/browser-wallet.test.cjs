const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sourceBlockAt(source, markerIndex) {
    assert.ok(markerIndex >= 0, 'source block marker is missing');
    const blockStart = source.indexOf('{', markerIndex);
    assert.ok(blockStart >= 0, 'source block opening brace is missing');
    let depth = 0;
    for (let index = blockStart; index < source.length; index += 1) {
        if (source[index] === '{') depth += 1;
        if (source[index] === '}') {
            depth -= 1;
            if (depth === 0) return source.slice(blockStart, index + 1);
        }
    }
    assert.fail('source block closing brace is missing');
}

function sourceMethodAt(source, marker) {
    const markerIndex = source.indexOf(marker);
    assert.ok(markerIndex >= 0, `source method marker is missing: ${marker}`);
    const parametersStart = source.indexOf('(', markerIndex);
    assert.ok(parametersStart >= 0, `source method parameters are missing: ${marker}`);

    let parameterDepth = 0;
    let parametersEnd = -1;
    for (let index = parametersStart; index < source.length; index += 1) {
        if (source[index] === '(') parameterDepth += 1;
        if (source[index] === ')') {
            parameterDepth -= 1;
            if (parameterDepth === 0) {
                parametersEnd = index;
                break;
            }
        }
    }
    assert.ok(parametersEnd >= 0, `source method parameters do not close: ${marker}`);

    const bodyStart = source.indexOf('{', parametersEnd);
    assert.ok(bodyStart >= 0, `source method body is missing: ${marker}`);
    return source.slice(markerIndex, bodyStart) + sourceBlockAt(source, bodyStart);
}

test('browser build contains every wallet WASM operation', () => {
    const bytes = fs.readFileSync(path.join(__dirname, 'wasm/zkapi_browser_bg.wasm'));
    const module = new WebAssembly.Module(bytes);
    const exports = new Set(WebAssembly.Module.exports(module).map(entry => entry.name));
    for (const name of [
        'browser_generate_deposit',
        'browser_confirm_deposit',
        'browser_wallet_status',
        'browser_tree_path',
        'browser_prepare_request',
        'browser_complete_response',
        'browser_withdrawal_nullifier',
        'browser_prepare_withdrawal'
    ]) {
        assert.ok(exports.has(name), `missing WASM export ${name}`);
    }
});

test('static proving keys match the deployment-pinned hashes', () => {
    assert.equal(
        sha256(path.join(root, 'protocol/setup/v2/request.pk')),
        'faa0e68954ade5e9709fa74baca3380cf0ff0d325ff06742385f33036123928e'
    );
    assert.equal(
        sha256(path.join(root, 'protocol/setup/v2/withdrawal.pk')),
        '92a90139c87ae0e331fddc92a36e231047e1b4ae95474521d9a75f9b5a7bd0ab'
    );
});

test('browser config defaults to the public Sepolia deployment', () => {
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'browser-config.json'), 'utf8'));
    assert.equal(config.deployment_manifest_url, 'https://d33l4w2z2nh4cg.cloudfront.net/config.json');
    assert.deepEqual(config.allowed_deployment_manifest_urls, [config.deployment_manifest_url]);
    assert.equal(config.trusted_deployment.chain_id, 11155111);
    assert.equal(config.trusted_deployment.contract_address.toLowerCase(), '0x590df9abbfb21074016daa486c771ae0af729ee2');
    assert.equal(config.trusted_deployment.request_proving_key_sha256, sha256(path.join(root, 'protocol/setup/v2/request.pk')));
    assert.equal(config.trusted_deployment.withdrawal_proving_key_sha256, sha256(path.join(root, 'protocol/setup/v2/withdrawal.pk')));
    assert.equal(config.proving_keys_base_url, './proofs/');
    assert.equal(config.deployment_api_proxy_path, '/zkapi-deployment/');
    assert.equal(config.billing_token_symbol, 'ZKAPI');
    assert.equal(config.billing_token_decimals, 6);
    assert.equal(config.require_oa_key_source, true);
    assert.equal(config.openrouter_requests_per_key, undefined);
});

test('mainnet browser config pins real Ethereum USDC and the deployed zkAPI server', () => {
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'browser-config.mainnet.json'), 'utf8'));
    assert.equal(config.deployment_manifest_url, 'https://d27v1dvkaxfc09.cloudfront.net/config.json');
    assert.deepEqual(config.allowed_deployment_manifest_urls, [config.deployment_manifest_url]);
    assert.equal(config.trusted_deployment.deployment_id, 'zkapi-ef-mainnet-groth16-v2-20260812');
    assert.equal(config.trusted_deployment.chain_id, 1);
    assert.equal(config.trusted_deployment.contract_address.toLowerCase(), '0xef88012d1a7f9d44e5f5afb8bc5e611dc3283709');
    assert.equal(config.trusted_deployment.billing_token_address.toLowerCase(), '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
    assert.equal(config.trusted_deployment.protocol_server_url, 'https://d27v1dvkaxfc09.cloudfront.net');
    assert.equal(config.trusted_deployment.indexer_url, 'https://d27v1dvkaxfc09.cloudfront.net');
    assert.equal(config.trusted_deployment.request_proving_key_sha256, sha256(path.join(root, 'protocol/setup/v2/request.pk')));
    assert.equal(config.trusted_deployment.withdrawal_proving_key_sha256, sha256(path.join(root, 'protocol/setup/v2/withdrawal.pk')));
    assert.equal(config.suggested_deposit_amount, 2_000_000);
    assert.equal(config.billing_token_symbol, 'USDC');
    assert.equal(config.billing_token_decimals, 6);
    assert.equal(config.require_oa_key_source, true);
});

test('Vercel browser deployment proxies only the pinned Sepolia API origin', () => {
    const vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.browser.json'), 'utf8'));
    assert.deepEqual(vercel.rewrites, [{
        source: '/zkapi-deployment/:path*',
        destination: 'https://d33l4w2z2nh4cg.cloudfront.net/:path*'
    }]);
});

test('separate Vercel mainnet build packages the pinned config and proxies only the mainnet server', () => {
    const vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.mainnet.json'), 'utf8'));
    assert.equal(vercel.buildCommand, './scripts/package-browser-client-mainnet.sh');
    assert.equal(vercel.outputDirectory, 'dist/browser-mainnet');
    assert.deepEqual(vercel.rewrites, [{
        source: '/zkapi-deployment/:path*',
        destination: 'https://d27v1dvkaxfc09.cloudfront.net/:path*'
    }]);
    const packager = fs.readFileSync(path.join(root, 'scripts/package-browser-client-mainnet.sh'), 'utf8');
    assert.match(packager, /browser-config\.mainnet\.json/);
    assert.match(packager, /funding\/browser-config\.json/);
});

test('mainnet funding UX labels USDC and warns before using real funds', () => {
    const runtime = fs.readFileSync(path.join(__dirname, 'services/browserWalletRuntime.js'), 'utf8');
    const client = fs.readFileSync(path.join(__dirname, 'services/zkapiClient.js'), 'utf8');
    const account = fs.readFileSync(path.join(__dirname, 'components/AccountModal.js'), 'utf8');
    const welcome = fs.readFileSync(path.join(__dirname, 'components/WelcomePanel.js'), 'utf8');
    const rootSync = fs.readFileSync(path.join(__dirname, 'services/zkapiWithdrawalRoot.mjs'), 'utf8');
    assert.match(runtime, /billing_token_symbol/);
    assert.match(runtime, /billing_token_decimals/);
    assert.match(client, /symbol: this\.billingTokenSymbol/);
    assert.match(client, /this\.networkName\(\)/);
    assert.match(account, /Add \$\{tokenSymbol\} to MetaMask/);
    assert.match(account, /Ethereum Mainnet:/);
    assert.match(account, /real USDC/);
    assert.match(account, /does not set the gas limit or fee rate/);
    assert.match(welcome, /Ethereum Mainnet:/);
    assert.match(welcome, /real ETH for gas/);
    assert.doesNotMatch(rootSync, /Sepolia vault root/);
});

test('browser direct requests use a proof-backed dollar budget instead of a small token quota', async () => {
    const compat = await import(pathToFileURL(path.join(__dirname, 'services/zkapiRequestCompat.mjs')));
    assert.equal(compat.selectLeaseSpendingLimitCredits(2_000_000, 50_000), 2_000_000);
    assert.equal(compat.selectLeaseSpendingLimitCredits(1_999_999, 50_000), 1_500_000);
    assert.equal(compat.selectLeaseSpendingLimitCredits(900_000, 50_000), 500_000);
    assert.equal(compat.selectLeaseSpendingLimitCredits(10_000_000, 50_000), 5_000_000);
    assert.deepEqual(
        compat.ensureDirectCompletionLimit(
            { model: 'anthropic/claude-opus-5' },
            {
                spendingLimitUsd: 2,
                model: {
                    pricing: { completion: '0.000025' },
                    top_provider: { max_completion_tokens: 128_000 }
                }
            }
        ),
        { model: 'anthropic/claude-opus-5', max_tokens: 36_000 }
    );
    assert.deepEqual(
        compat.ensureDirectCompletionLimit({ model: 'openai/gpt-5.6-sol' }, { spendingLimitUsd: 5 }),
        { model: 'openai/gpt-5.6-sol', max_tokens: 90_000 }
    );
    assert.deepEqual(
        compat.ensureDirectCompletionLimit({ model: 'daemon/model' }),
        { model: 'daemon/model' }
    );
    assert.equal(compat.ensureDirectCompletionLimit({ max_tokens: 32 }).max_tokens, 32);
    assert.equal(compat.ensureDirectCompletionLimit({ max_completion_tokens: 48 }).max_completion_tokens, 48);
    assert.deepEqual(
        compat.ensureDirectCompletionLimit({ max_output_tokens: 64 }),
        { max_tokens: 64 }
    );
});

test('browser inference separates zkAPI key checkout from OA streaming transport', () => {
    const runtime = fs.readFileSync(path.join(__dirname, 'services/browserWalletRuntime.js'), 'utf8');
    const client = fs.readFileSync(path.join(__dirname, 'services/zkapiClient.js'), 'utf8');
    const api = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

    assert.match(runtime, /async acquireEphemeralKey\(sessionId, onProgress = \(\) => \{\}, options = \{\}\)/);
    assert.match(runtime, /apiKey: lease\.api_key/);
    assert.match(runtime, /spendingLimitUsd: Number\(lease\.spending_limit_usd\)/);
    assert.match(runtime, /selectLeaseSpendingLimitCredits/);
    assert.match(runtime, /request_charge_cap: spendingLimitCredits/);
    assert.match(runtime, /request\.public_inputs\.solvency_bound/);
    assert.match(runtime, /lease\.inFlight \+= 1/);
    assert.match(runtime, /lease\.inFlight = Math\.max\(0, lease\.inFlight - 1\)/);
    assert.doesNotMatch(runtime, /requestsServed|requests_per_key|lease_request_limit/);
    assert.doesNotMatch(runtime, /async inferenceFetch\(/);
    assert.match(client, /async acquireInferenceAccess\(sessionId, options = \{\}\)/);
    assert.doesNotMatch(client, /async inferenceFetch\(/);
    assert.match(api, /await zkapiClient\.acquireInferenceAccess\(sessionId\)/);
    assert.match(api, /stream: true/);
    assert.match(api, /await consumeSseBody\(response\.body, processSseLine\)/);
    assert.match(api, /finishReason: completionFinishReason/);
    assert.doesNotMatch(api, /\{ \.\.\.body, stream: false \}/);
});

test('onboarding has a static readable card surface and length-limited answers expose Continue', () => {
    const css = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf8');
    const templates = fs.readFileSync(path.join(__dirname, 'components/MessageTemplates.js'), 'utf8');
    const chatArea = fs.readFileSync(path.join(__dirname, 'components/ChatArea.js'), 'utf8');
    const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    assert.match(css, /\.welcome-modal-glass\s*\{[\s\S]*background: hsl\(var\(--color-card\) \/ 0\.96\)/);
    assert.match(css, /#welcome-panel\s*\{[\s\S]*rgba\(0, 0, 0, 0\.35\)/);
    assert.match(templates, /message\.finishReason === 'length'/);
    assert.match(templates, /continue-message-btn/);
    assert.match(chatArea, /continueLimitedResponse/);
    assert.match(app, /Continue exactly where you left off/);
});

test('zkAPI clock updates are isolated from semantic rerenders', () => {
    const client = fs.readFileSync(path.join(__dirname, 'services/zkapiClient.js'), 'utf8');
    const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    const account = fs.readFileSync(path.join(__dirname, 'components/AccountModal.js'), 'utf8');
    const welcome = fs.readFileSync(path.join(__dirname, 'components/WelcomePanel.js'), 'utf8');
    const rightPanel = fs.readFileSync(path.join(__dirname, 'components/RightPanel.js'), 'utf8');

    assert.match(client, /setInterval\(\(\) => this\.emitClock\(\), 1_000\)/);
    assert.doesNotMatch(client, /emitChange\('clock'\)/);
    assert.match(client, /subscribeClock\(listener\)/);
    assert.match(client, /stateBeforeRefresh !== this\.runtimeStateSignature\(\)/);
    assert.match(app, /zkapiClient\.subscribeClock\(/);
    assert.match(app, /renderZkapiComposerStatus\(this\.elements\.zkapiComposerStatus, this\)/);
    assert.match(account, /zkapiClient\.subscribeClock\(/);
    assert.match(account, /data-zkapi-escape-countdown/);
    assert.match(account, /finalizeButton\.disabled = !ready \|\| this\.busy/);
    assert.match(welcome, /this\.step !== 'success'/);
    assert.match(rightPanel, /handleZkapiClock\(\)/);
    assert.match(rightPanel, /zkapiClockUnsubscribe/);
});

test('repeated input-state updates retain the animated send-button child', () => {
    const appSource = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    const updateInputState = sourceMethodAt(appSource, 'updateInputState() {');
    const Harness = Function(`return class InputHarness { ${updateInputState} };`)();
    const attributes = new Map();
    let buttonHtml = '';
    let buttonWrites = 0;
    const sendBtn = {
        dataset: {},
        disabled: false,
        classList: {
            toggle() {},
            add() {},
            remove() {}
        },
        set innerHTML(value) {
            buttonHtml = String(value);
            buttonWrites += 1;
        },
        get innerHTML() { return buttonHtml; },
        setAttribute(name, value) { attributes.set(name, String(value)); },
        removeAttribute(name) { attributes.delete(name); }
    };
    const instance = new Harness();
    instance.elements = {
        messageInput: { value: 'hello', disabled: false, placeholder: '' },
        sendBtn
    };
    instance.uploadedFiles = [];
    instance.state = { currentSessionId: 'chat-a' };
    instance.sessionSwitchInFlight = null;
    instance.pendingSettlementSendSessions = new Set(['chat-a']);
    instance.sendSubmissionsInFlight = new Set();
    instance.exclusiveSessionMutationOwners = new Map();
    instance.searchEnabled = false;
    instance.isCurrentSessionStreaming = () => false;

    instance.updateInputState();
    const orbitMarkup = sendBtn.innerHTML;
    instance.updateInputState();
    assert.equal(buttonWrites, 1, 'the busy orbit node must survive an unchanged update');
    assert.equal(sendBtn.innerHTML, orbitMarkup);
    assert.equal(sendBtn.dataset.zkapiVisualState, 'busy');

    instance.pendingSettlementSendSessions.clear();
    instance.updateInputState();
    assert.equal(buttonWrites, 2, 'a real visual-mode transition must still replace the icon');
    assert.equal(sendBtn.dataset.zkapiVisualState, 'idle');
    instance.updateInputState();
    assert.equal(buttonWrites, 2, 'the idle icon must also remain mounted when unchanged');
});

test('OA System Panel is preserved with only ticket billing replaced', () => {
    const panel = fs.readFileSync(path.join(__dirname, 'components/RightPanel.js'), 'utf8');
    const modelPicker = fs.readFileSync(path.join(__dirname, 'components/ModelPicker.js'), 'utf8');
    const upstreamPanel = fs.readFileSync(path.join(__dirname, 'components/OaRightPanelBase.js'), 'utf8');
    assert.match(panel, /extends OaRightPanelBase/);
    assert.match(panel, /super\.generateTopSectionHTML\(\)/);
    assert.match(panel, /<!-- API Key Panel -->/);
    assert.match(panel, /super\.attachTopSectionEventListeners\(\)/);
    assert.match(panel, /Private balance/);
    assert.match(upstreamPanel, /Ephemeral Access Key/);
    assert.match(upstreamPanel, /Network Proxy/);
    assert.match(upstreamPanel, /Activity Timeline/);
    assert.match(modelPicker, /selectLeaseSpendingLimitCredits/);
    assert.match(modelPicker, /Cumulative dollar spending cap for this chat/);
    assert.doesNotMatch(modelPicker, /Maximum private-balance charge per request/);
});

test('OA credit-exhaustion recovery immediately settles the zkAPI lease', () => {
    const backend = fs.readFileSync(path.join(__dirname, 'services/inference/backends/zkapiBackend.js'), 'utf8');
    assert.match(backend, /refreshOnCreditExhaustion: true/);
    assert.match(backend, /session\.zkapiSettleBeforeAccess = true/);
    assert.match(backend, /await zkapiClient\.settleActiveLease\(\)/);
    assert.match(backend, /delete session\.zkapiSettleBeforeAccess/);
});

test('New Chat opens immediately and settles its previous lease in the background', () => {
    const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    const handlerStart = app.indexOf('async handleNewChatRequest(options = {})');
    const helperStart = app.indexOf('\n    startPreviousChatLeaseSettlement(previousSession, previousLease = null) {', handlerStart);
    assert.ok(handlerStart >= 0 && helperStart > handlerStart, 'New Chat settlement helper is missing');

    const handler = app.slice(handlerStart, helperStart);
    assert.match(handler, /await this\.clearCurrentSession\(\{ \.\.\.options, immediate: true \}\)/);
    assert.match(handler, /this\.startPreviousChatLeaseSettlement\(previousSession, previousLease\)/);
    assert.doesNotMatch(handler, /await this\.startPreviousChatLeaseSettlement/);
    assert.ok(
        handler.indexOf('startPreviousChatLeaseSettlement') < handler.indexOf('clearCurrentSession'),
        'the retirement barrier must exist before a fast send can use the new composer'
    );

    const helper = app.slice(helperStart, app.indexOf('/**', helperStart));
    assert.match(app, /const NEW_CHAT_SETTLEMENT_DEADLINE_MS = 45_000/);
    assert.match(helper, /this\.newChatSettlementPromise = settlement/);
    assert.match(helper, /await this\.cancelPendingSendsAndWait/);
    assert.match(helper, /const currentLease = zkapiClient\.activeLease/);
    assert.match(helper, /currentLease\.session_id !== ownerSessionId/);
    assert.match(helper, /await zkapiClient\.settleActiveLease\(\)/);
    assert.match(helper, /Date\.now\(\) \+ NEW_CHAT_SETTLEMENT_DEADLINE_MS/);
    assert.match(helper, /'lease_requests_in_flight',[\s\S]*'lease_pending',[\s\S]*'lease_settlement_pending'/);
    assert.match(helper, /error\?\.data\?\.retry_after_seconds/);
    assert.match(helper, /Date\.now\(\) \+ retryDelayMs > deadline/);
    assert.match(helper, /inferenceService\.clearAccessInfo\(ownerSession\)/);
    assert.match(helper, /phase: 'settling'/);
    assert.match(helper, /phase: 'ready'/);
    assert.match(helper, /zkapi-lease-settlement-start/);
    assert.match(helper, /zkapi-lease-settlement-complete/);
    assert.doesNotMatch(helper, /newChatButton\.disabled/);

    const send = sourceMethodAt(app, 'async sendMessage(');
    const captured = sourceMethodAt(app, 'async sendCapturedMessage(');
    assert.match(send, /capturePendingSendDraft/);
    assert.match(send, /sendSubmissionsInFlight/);
    assert.match(send, /clearAcceptedChatbarDraft\(initiatingSessionId, draft\)/);
    assert.match(captured, /deliveryState: settlementPendingAtSend/);
    assert.match(captured, /this\.startPreviousChatLeaseSettlement\(owningSession, activeLease\)/);
    assert.match(captured, /await this\.waitForPreviousChatLeaseSettlement\(/);
    assert.match(captured, /signal: abortController\.signal/);
    assert.doesNotMatch(captured, /Continue the active chat until its private key expires/);
    assert.ok(
        captured.indexOf("this.addMessage('user'") < captured.indexOf('await zkapiClient.init()')
            && captured.indexOf('await zkapiClient.init()') < captured.indexOf('waitForPreviousChatLeaseSettlement'),
        'the pending user message must be persisted before initialization or settlement waits'
    );
});

test('New Chat settlement logs through the application service without a component facade', async () => {
    const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    const method = sourceMethodAt(
        source,
        'startPreviousChatLeaseSettlement(previousSession, previousLease = null)'
    );
    const logs = [];
    const session = { id: 'old-chat', title: 'Old chat' };
    const lease = { session_id: session.id };
    const zkapiClient = {
        activeLease: lease,
        async settleActiveLease() {
            this.activeLease = null;
        }
    };
    const networkLogger = {
        logRequest(entry) {
            logs.push(entry);
        }
    };
    const Harness = Function(
        'zkapiClient',
        'inferenceService',
        'chatDB',
        'networkLogger',
        'NEW_CHAT_SETTLEMENT_DEADLINE_MS',
        `return class SettlementHarness { ${method} };`
    )(
        zkapiClient,
        { clearAccessInfo() {} },
        { async saveSession() {} },
        networkLogger,
        45_000
    );
    const app = new Harness();
    app.state = { sessionsById: new Map([[session.id, session]]) };
    app.newChatSettlementPromise = null;
    app.setNewChatSettlementState = () => {};
    app.cancelPendingSendsAndWait = async () => true;
    app.isSessionDeleted = () => false;
    app.showToast = () => {};

    assert.equal(app.services, undefined, 'the controller must not depend on the UI component facade');
    await app.startPreviousChatLeaseSettlement(session, lease);

    assert.deepEqual(
        logs.map(entry => entry.action),
        ['zkapi-lease-settlement-start', 'zkapi-lease-settlement-complete']
    );
});

test('queued-send wiring snapshots before awaiting while user bubbles remain state-free', () => {
    const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    const templates = fs.readFileSync(path.join(__dirname, 'components/MessageTemplates.js'), 'utf8');
    const send = sourceMethodAt(app, 'async sendMessage(');
    const captured = sourceMethodAt(app, 'async sendCapturedMessage(');

    assert.ok(send.indexOf('this.sendSubmissionsInFlight.set(submission.key, submission)') < send.indexOf('await this.sendCapturedMessage(draft, submission)'));
    assert.ok(send.indexOf('clearAcceptedChatbarDraft') < send.indexOf('await this.sendCapturedMessage(draft, submission)'));
    assert.match(app, /retainUnacceptedText/);
    assert.match(app, /retainUnacceptedFiles/);
    assert.match(captured, /sessionId: session\.id/);
    assert.match(captured, /this\.announceZkapiSendState\('Message accepted'\)/);
    assert.match(captured, /updateOutgoingDeliveryState\(userMessage, 'failed'/);
    assert.doesNotMatch(templates, /user-delivery|data-delivery-state/);
    assert.match(templates, /resend-prompt-btn/);
    assert.match(templates, /edit-prompt-btn/);
});

test('queued-send guards are session-scoped and New Chat cancels the session being left', () => {
    const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    const constructorStart = app.indexOf('constructor()');
    const constructor = app.slice(constructorStart, app.indexOf('\n    async init()', constructorStart));
    const newChatStart = app.indexOf('async handleNewChatRequest(options = {})');
    const newChatEnd = app.indexOf('\n    /**', newChatStart);
    const newChat = app.slice(newChatStart, newChatEnd);
    const send = sourceMethodAt(app, 'async sendMessage(');
    const captured = sourceMethodAt(app, 'async sendCapturedMessage(');

    assert.match(constructor, /this\.sendSubmissionsInFlight = new Map\(\)/);
    assert.match(constructor, /this\.pendingSettlementSendSessions = new Set\(\)/);
    assert.match(send, /const initiatingSubmissionKey = initiatingSessionId \|\| '__new_chat__'/);
    assert.match(send, /this\.sendSubmissionsInFlight\.has\(initiatingSubmissionKey\)/);
    assert.match(captured, /submission\.key = createdSession\.id/);
    assert.match(captured, /this\.sendSubmissionsInFlight\.set\(submission\.key, submission\)/);

    assert.match(newChat, /this\.stopSessionStreaming\(previousSession\.id\)/);
    assert.ok(
        newChat.indexOf('stopSessionStreaming(previousSession.id)') < newChat.indexOf('clearCurrentSession'),
        'New Chat must cancel a queued send before leaving its session'
    );
    assert.match(newChat, /this\.stopSessionStreaming\(previousLease\.session_id\)/);

    assert.match(app, /async waitForPreviousChatLeaseSettlement\(sessionId, \{ signal = null \} = \{\}\)/);
    assert.match(app, /Promise\.race\(\[settled, canceled\]\)/);
    assert.match(app, /this\.pendingSettlementSendSessions\.delete\(sessionId\)/);
});

test('New Chat can abort a send before its session has been allocated', () => {
    const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    const send = sourceMethodAt(app, 'async sendMessage(');
    const createSession = sourceMethodAt(app, 'async createSession(');
    const newChatStart = app.indexOf('async handleNewChatRequest(options = {})');
    const newChatEnd = app.indexOf('\n    /**', newChatStart);
    const newChat = app.slice(newChatStart, newChatEnd);
    const restoreStart = app.indexOf('restoreUnacceptedChatbarDraft(draft)');
    const restoreEnd = app.indexOf('\n    clearAllChatbarStates()', restoreStart);
    const restore = app.slice(restoreStart, restoreEnd);

    const ownClick = send.indexOf('controller: new AbortController()');
    const firstAwait = send.indexOf('await this.sendCapturedMessage(draft, submission)');
    assert.ok(ownClick >= 0 && ownClick < firstAwait, 'the click must own an abort controller before its first await');
    assert.match(send, /submission\.draft\s*=\s*draft/);

    const initialRead = createSession.indexOf("await chatDB.getSetting('selectedModel')");
    const abortCheck = createSession.indexOf('if (options.signal?.aborted) return null');
    const allocation = createSession.indexOf('this.state.sessions.unshift(session)');
    assert.ok(
        initialRead >= 0 && abortCheck > initialRead && allocation > abortCheck,
        'an abort during the initial settings read must stop allocation'
    );

    const findPending = newChat.indexOf("previousSession?.id || '__new_chat__'");
    const discard = newChat.indexOf('pendingSubmission.draft.discarded = true');
    const abort = newChat.indexOf('pendingSubmission.controller.abort()');
    const clear = newChat.indexOf('await this.clearCurrentSession(');
    assert.ok(findPending >= 0 && discard > findPending && abort > discard && clear > abort);
    assert.match(restore, /draft\.discarded/);
});

test('new-chat sends bind drafts during allocation and restore failures to their owning composer', () => {
    const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    const createSession = sourceMethodAt(app, 'async createSession(');
    const captured = sourceMethodAt(app, 'async sendCapturedMessage(');
    const restoreStart = app.indexOf('restoreUnacceptedChatbarDraft(draft)');
    const restoreEnd = app.indexOf('\n    clearAllChatbarStates()', restoreStart);
    const restore = app.slice(restoreStart, restoreEnd);

    const allocated = createSession.indexOf('options.onAllocated?.(session)');
    const persisted = createSession.indexOf('await chatDB.saveSession(session)');
    assert.ok(allocated >= 0, 'createSession must expose the newly allocated session synchronously');
    assert.ok(persisted > allocated, 'the draft must bind before createSession waits on persistence');

    assert.match(captured, /draft\.sessionId\s*=\s*createdSession\.id/);
    assert.match(captured, /onAllocated:\s*bindSubmissionToSession/);
    assert.match(captured, /sessionsById\.get\(draft\.sessionId\)/);
    assert.match(captured, /entry\.id\s*===\s*draft\.sessionId/);
    assert.ok(
        captured.indexOf('sessionsById.get(draft.sessionId)')
            < captured.indexOf("await this.createSession('New Chat'"),
        'a previously bound draft must recover its original session instead of allocating another'
    );

    assert.match(restore, /targetSessionId\s*=\s*draft\.sessionId\s*\|\|\s*null/);
    assert.match(restore, /isViewingSession\(targetSessionId\)/);
    assert.match(restore, /sessionChatbarStates\.set\(targetSessionId/);
});

test('accepted attachments remain recoverable until their durable metadata is prepared', () => {
    const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    const captured = sourceMethodAt(app, 'async sendCapturedMessage(');
    const retry = sourceMethodAt(app, 'async regenerateResponse(');
    const prepare = sourceMethodAt(app, 'async ensureMessageFileMetadata(');

    const provisional = captured.indexOf('pendingFileObjects: currentFiles');
    const accepted = captured.indexOf("await this.addMessage('user'");
    const prepared = captured.indexOf('this.ensureMessageFileMetadata(userMessage, currentFiles)');
    assert.ok(provisional >= 0 && accepted > provisional, 'raw attachments must be part of the accepted message');
    assert.ok(prepared > accepted, 'attachment conversion must happen after the recoverable message is persisted');

    assert.match(retry, /lastUserMessage\.pendingFileObjects\?\.length/);
    assert.match(retry, /ensureMessageFileMetadata\(lastUserMessage\)/);
    assert.ok(
        retry.indexOf('ensureMessageFileMetadata(lastUserMessage)')
            < retry.indexOf('inferenceService.streamCompletion('),
        'retry must finish provisional attachment conversion before opening the model stream'
    );

    assert.match(prepare, /Array\.isArray\(message\.pendingFileObjects\)/);
    const preparationStart = prepare.indexOf('const preparation =');
    const preparation = sourceBlockAt(prepare, preparationStart);
    const build = preparation.indexOf('await this.buildMessageFileMetadata(pendingFiles)');
    const clearMatch = /delete (?:latestMessage|message)\.pendingFileObjects/.exec(preparation);
    const saveMatch = /await chatDB\.saveMessage\((?:latestMessage|message)\)/.exec(preparation);
    const clear = clearMatch?.index ?? -1;
    const save = saveMatch?.index ?? -1;
    assert.ok(build >= 0 && clear > build && save > clear, 'provisional files clear only after conversion and are then persisted');
});

test('joining attachment preparation hydrates and persists the retry message clone', () => {
    const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    const prepareStart = app.indexOf('async ensureMessageFileMetadata(');
    const prepareEnd = app.indexOf('\n    updateEditDraftContent(', prepareStart);
    const prepare = app.slice(prepareStart, prepareEnd);
    const existingStart = prepare.indexOf('if (existing)');
    const existing = sourceBlockAt(prepare, existingStart);

    const awaitExisting = existing.indexOf('const files = await existing');
    const hydrate = existing.indexOf('message.files = files');
    const clearPending = existing.indexOf('delete message.pendingFileObjects');
    const persist = existing.indexOf('await chatDB.saveMessage(message)');
    assert.ok(
        awaitExisting >= 0 && hydrate > awaitExisting && clearPending > hydrate && persist > clearPending,
        'a distinct IndexedDB retry clone must be saved after it joins the original preparation'
    );
});

test('editing after attachment preparation failure cannot resurrect pending raw files', () => {
    const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    const enterStart = app.indexOf('async enterEditMode(');
    const enterEnd = app.indexOf('\n    cancelEditMode(', enterStart);
    const enterEdit = app.slice(enterStart, enterEnd);
    const confirmStart = app.indexOf('async confirmEditPrompt(');
    const confirmEnd = app.indexOf('\n    /**\n     * Forks the conversation', confirmStart);
    const confirmEdit = app.slice(confirmStart, confirmEnd);

    const pendingGuardStart = enterEdit.indexOf('if (message.pendingFileObjects?.length)');
    const pendingGuard = sourceBlockAt(enterEdit, pendingGuardStart);
    const catchStart = pendingGuard.indexOf('catch (error)');
    const failure = sourceBlockAt(pendingGuard, catchStart);
    const blocksUnsafeEdit = /\breturn(?:\s+[^;]+)?;/.test(failure);

    const replaceFiles = confirmEdit.indexOf('message.files =');
    const clearMatch = /(?:delete\s+message\.pendingFileObjects|message\.pendingFileObjects\s*=\s*(?:null|\[\]))/.exec(
        replaceFiles >= 0 ? confirmEdit.slice(replaceFiles) : ''
    );
    const clearPending = clearMatch ? replaceFiles + clearMatch.index : -1;
    const persist = confirmEdit.indexOf('await chatDB.saveMessage(message)', replaceFiles);
    const clearsPendingBeforeSave = replaceFiles >= 0 && clearPending > replaceFiles && persist > clearPending;

    assert.ok(
        blocksUnsafeEdit || clearsPendingBeforeSave,
        'failed raw attachments must either block editing or be cleared atomically with the edited attachment set'
    );
});

test('retry reuses the accepted model and search choice instead of live composer state', () => {
    const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    const captured = sourceMethodAt(app, 'async sendCapturedMessage(');
    const retry = sourceMethodAt(app, 'async regenerateResponse(');

    assert.match(captured, /model:\s*capturedModelName\s*\|\|\s*session\.model/);
    assert.match(captured, /metadata\.searchEnabled\s*=\s*true/);
    assert.match(captured, /modelNameOverride:\s*capturedModelName/);
    assert.match(
        captured.slice(captured.indexOf('inferenceService.streamCompletion(')),
        /\n\s*searchEnabled,\s*\n\s*abortController,/,
        'the captured search toggle must be an argument to the stream call'
    );

    assert.match(retry, /lastUserMessage\.model\s*\|\|\s*session\.model/);
    assert.match(retry, /Boolean\(lastUserMessage\.searchEnabled\)/);
    assert.match(retry, /modelNameOverride:\s*retryModelName/);
    assert.match(retry, /modelNameToUse\s*=\s*retryModelName/);
    assert.match(
        retry.slice(retry.indexOf('inferenceService.streamCompletion(')),
        /\n\s*retrySearchEnabled,\s*\n\s*abortController,/,
        'retry must pass the accepted search choice to the stream call'
    );
    assert.doesNotMatch(retry, /this\.searchEnabled/);
});

test('accepted memory and reasoning controls are persisted and reused by Retry', () => {
    const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    const send = sourceMethodAt(app, 'async sendMessage(');
    const captured = sourceMethodAt(app, 'async sendCapturedMessage(');
    const retry = sourceMethodAt(app, 'async regenerateResponse(');

    assert.match(
        send,
        /memoryMode:\s*options\.memoryMode\s*\n\s*\?\?\s*\(this\.memoryFeatureEnabled[^,\n]*this\.memoryMode/
    );
    assert.match(send, /reasoningEnabled:\s*[^,\n]*this\.reasoningEnabled/);
    assert.match(
        send,
        /reasoningEffort:\s*normalizeReasoningEffort\(options\.reasoningEffort\s*\?\?\s*this\.reasoningEffort\)/
    );

    assert.match(captured, /memoryMode:\s*capturedMemoryMode/);
    assert.match(captured, /reasoningEnabled:\s*capturedReasoningEnabled/);
    assert.match(captured, /reasoningEffort:\s*capturedReasoningEffort/);
    assert.match(captured, /capturedMemoryMode/);
    assert.match(
        captured.slice(captured.indexOf('inferenceService.streamCompletion(')),
        /capturedReasoningEnabled,\s*\n\s*capturedReasoningEffort/,
        'the accepted reasoning controls must reach the initial stream'
    );

    assert.match(retry, /lastUserMessage\.memoryMode/);
    assert.match(retry, /lastUserMessage\.reasoningEnabled/);
    assert.match(retry, /lastUserMessage\.reasoningEffort/);
    assert.match(retry, /retryMemoryMode/);
    assert.match(
        retry.slice(retry.indexOf('inferenceService.streamCompletion(')),
        /retryReasoningEnabled,\s*\n\s*retryReasoningEffort/,
        'Retry must stream with the controls stored on the accepted prompt'
    );
});

test('initial sends and retries gate inference on a usable funded note', () => {
    const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    const methods = [
        ['send', sourceMethodAt(app, 'async sendCapturedMessage(')],
        ['retry', sourceMethodAt(app, 'async regenerateResponse(')]
    ];

    for (const [label, method] of methods) {
        const init = method.indexOf('await zkapiClient.init()');
        const withdrawal = method.indexOf('if (zkapiClient.withdrawalBlocksChat)');
        const missingNote = method.indexOf('if (!zkapiClient.hasNote)');
        const acquire = method.indexOf('await this.acquireAndSetAccess(');
        const stream = method.indexOf('inferenceService.streamCompletion(');
        assert.ok(init >= 0 && withdrawal > init, `${label} must initialize wallet state before checking it`);
        assert.ok(missingNote > withdrawal, `${label} must reject both blocked withdrawals and missing notes`);
        assert.ok(acquire > missingNote && stream > acquire, `${label} must gate key acquisition and inference`);
        assert.match(method, /accountModal\?\.open\?\.\('withdraw'\)/);
        assert.match(method, /accountModal\?\.open\?\.\('fund'\)/);
    }
});

test('opaque zkAPI chat bindings stay Securing until transport access is real', () => {
    const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    const resolveMethod = sourceMethodAt(source, '\n    resolvePendingPhaseForSession(session)');
    const advanceMethod = sourceMethodAt(source, 'advancePendingStateAfterAccessGranted(session, typingId = null)');
    let transportReady = false;
    const inferenceService = {
        isTransportAccessReady() {
            return transportReady;
        }
    };
    const Harness = Function(
        'inferenceService',
        `return class PendingAccessHarness { ${resolveMethod} ${advanceMethod} };`
    )(inferenceService);
    const app = new Harness();
    const phases = [];
    const typing = [];
    app.updateSessionStreamingPhase = (sessionId, phase) => phases.push({ sessionId, phase });
    app.updateTypingIndicator = (id, phase) => typing.push({ id, phase });
    const session = { id: 'chat-a', apiKey: 'opaque-session-binding' };

    assert.equal(app.advancePendingStateAfterAccessGranted(session, 'typing-a'), 'requesting-key');
    assert.deepEqual(phases.at(-1), { sessionId: session.id, phase: 'requesting-key' });
    assert.deepEqual(typing.at(-1), { id: 'typing-a', phase: 'requesting-key' });

    transportReady = true;
    assert.equal(app.advancePendingStateAfterAccessGranted(session, 'typing-a'), 'waiting-response');
    assert.deepEqual(phases.at(-1), { sessionId: session.id, phase: 'waiting-response' });
    assert.deepEqual(typing.at(-1), { id: 'typing-a', phase: 'waiting-response' });
});

test('send and Retry keep delivery Securing while zkAPI transport access is deferred', () => {
    const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    const send = sourceMethodAt(source, 'async sendCapturedMessage(');
    const retry = sourceMethodAt(source, 'async regenerateResponse(');
    const refresh = sourceMethodAt(source, 'async refreshAccessAfterCreditExhaustion(');

    for (const [label, method] of [['send', send], ['retry', retry]]) {
        assert.match(
            method,
            /const phase = this\.advancePendingStateAfterAccessGranted\(session, typingId\);[\s\S]*?phase === 'requesting-key' \? 'securing' : 'sending'/,
            `${label} must derive its receipt from real transport readiness`
        );
    }
    assert.doesNotMatch(
        send,
        /if \(userMessage\?\.deliveryState !== 'sending'\)/,
        'a local session binding must not unconditionally claim that private access is ready'
    );
    assert.doesNotMatch(
        retry,
        /void this\.updateOutgoingDeliveryState\(lastUserMessage, 'sending'\)/,
        'Retry must not unconditionally claim that private access is ready'
    );
    assert.match(
        refresh,
        /updateOutgoingDeliveryState\(message, 'securing'\)/,
        'an exhausted-key refresh must return the durable receipt to Securing'
    );
});

test('successful send and Retry streams complete the accessible send announcement', () => {
    const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    const methods = [
        ['send', sourceMethodAt(app, 'async sendCapturedMessage(')],
        ['retry', sourceMethodAt(app, 'async regenerateResponse(')]
    ];

    for (const [label, method] of methods) {
        const streamStart = method.indexOf('const tokenData = await inferenceService.streamCompletion(');
        const successEnd = method.indexOf('} catch (error)', streamStart);
        assert.ok(streamStart >= 0 && successEnd > streamStart, `${label} success path must be present`);

        const successPath = method.slice(streamStart, successEnd);
        const finalSave = successPath.lastIndexOf('await chatDB.saveMessage(streamingMessage)');
        const completionAnnouncement = successPath.indexOf(
            "this.announceZkapiSendState('Response complete')"
        );
        assert.ok(finalSave >= 0, `${label} must persist the completed response`);
        assert.ok(
            completionAnnouncement > finalSave,
            `${label} must announce completion only after the response is finalized`
        );
        assert.match(
            successPath,
            /if \(this\.isViewingSession\(session\.id\)\) \{\s*this\.announceZkapiSendState\('Response complete'\);\s*\}/,
            `${label} must not announce completion for a background chat`
        );
    }
});

test('stream failures preserve partial assistant content on both send and retry paths', () => {
    const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    const methods = [
        ['send', sourceMethodAt(app, 'async sendCapturedMessage(')],
        ['retry', sourceMethodAt(app, 'async regenerateResponse(')]
    ];

    for (const [label, method] of methods) {
        const partialStart = method.lastIndexOf('if (firstChunkReceived && streamingMessage)');
        const partial = sourceBlockAt(method, partialStart);
        assert.match(partial, /streamingMessage\.content\s*=\s*streamedContent/);
        assert.match(partial, /streamingMessage\.reasoning\s*=\s*streamedReasoning/);
        assert.match(partial, /await chatDB\.saveMessage\(streamingMessage\)/);
        assert.match(partial, /updateOutgoingDeliveryState\([^)]*'failed'/s);
        assert.doesNotMatch(method, /streamingMessage\.content\s*=\s*userFriendlyMessage/);
    }
});

test('cancellation preserves image-only partial responses on send and Retry', () => {
    const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    const methods = [
        ['send', sourceMethodAt(app, 'async sendCapturedMessage(')],
        ['retry', sourceMethodAt(app, 'async regenerateResponse(')]
    ];

    for (const [label, method] of methods) {
        const cancelStart = method.lastIndexOf('if (error.isCancelled)');
        const cancellation = sourceBlockAt(method, cancelStart);
        assert.match(
            cancellation,
            /(?:streamingMessage\.images\?\.length|Array\.isArray\(streamingMessage\.images\)|streamingMessage\.images\s*&&\s*streamingMessage\.images\.length)/,
            `${label} cancellation must count generated images as partial output`
        );
        assert.match(cancellation, /await chatDB\.saveMessage\(streamingMessage\)/);
    }
});

test('session deletion and history clearing await pending send ownership', () => {
    const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    const cancel = sourceMethodAt(app, 'async cancelPendingSendsAndWait(');
    const deleteSession = sourceMethodAt(app, 'async deleteSession(');
    const deleteAll = sourceMethodAt(app, 'async deleteAllChats(');
    const captured = sourceMethodAt(app, 'async sendCapturedMessage(');

    assert.match(cancel, /submission\.draft\.discarded\s*=\s*true/);
    assert.match(cancel, /submission\.controller\?\.abort\(\)/);
    assert.match(cancel, /sendSubmissionsInFlight/);
    assert.match(cancel, /sessionStreamingStates/);

    const stopOne = deleteSession.indexOf('await this.cancelPendingSendsAndWait([sessionId])');
    const deleteOne = deleteSession.indexOf('await chatDB.deleteSession(sessionId)');
    assert.ok(stopOne >= 0 && deleteOne > stopOne, 'single-chat deletion must await its send before storage deletion');

    const stopAll = deleteAll.indexOf('await this.cancelPendingSendsAndWait()');
    const clearStorage = deleteAll.indexOf('await chatDB.clearAllChats()');
    assert.ok(stopAll >= 0 && clearStorage > stopAll, 'history clearing must await every send before clearing storage');

    const finishStart = captured.indexOf('const finishAcceptedSend =');
    const finish = sourceBlockAt(captured, finishStart);
    assert.match(finish, /await fileMetadataPromise/);
});

test('message acceptance becomes atomic at the first durable message write', () => {
    const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    const addMessage = sourceMethodAt(app, 'async addMessage(');
    const send = sourceMethodAt(app, 'async sendMessage(');
    const captured = sourceMethodAt(app, 'async sendCapturedMessage(');

    const durableWrite = addMessage.indexOf('await chatDB.saveMessage(message)');
    const acceptedCallback = addMessage.indexOf('metadata.onPersisted?.(message)');
    const laterBookkeeping = addMessage.indexOf('await chatDB.getSessionMessages(session.id)');
    assert.ok(
        durableWrite >= 0 && acceptedCallback > durableWrite && laterBookkeeping > acceptedCallback,
        'post-write session/UI failures must not make a durable prompt look unaccepted'
    );

    const callbackStart = captured.indexOf('onPersisted: (message) =>');
    const callback = sourceBlockAt(captured, callbackStart);
    assert.match(callback, /draft\.accepted\s*=\s*true/);
    assert.match(callback, /draft\.message\s*=\s*message/);
    assert.match(send, /if \(draft\.accepted && draft\.message\?\.id\)/);
    assert.match(send, /updateOutgoingDeliveryState\(draft\.message, 'failed'/);
});

test('memory API overrides remain scoped to the session that approved them', () => {
    const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    const constructor = sourceMethodAt(app, 'constructor()');
    const memoryFlow = sourceMethodAt(app, 'async runMemoryAugmentFlow(');
    const process = sourceMethodAt(app, 'processMessagesWithFiles(');
    const refresh = sourceMethodAt(app, 'refreshProcessedMessagesIfMemoryOverrideChanged(');
    const retry = sourceMethodAt(app, 'async regenerateResponse(');
    const captured = sourceMethodAt(app, 'async sendCapturedMessage(');

    assert.match(constructor, /this\.memoryApiOverrides = new Map\(\)/);
    assert.match(memoryFlow, /sessionId:\s*session\.id/);
    assert.match(
        memoryFlow,
        /setMemoryApiOverrideContent\([^;]*memoryRunGeneration,\s*session\.id\)/s
    );
    assert.match(memoryFlow, /clearMemoryApiOverrideContent\(session\.id\)/);

    assert.match(process, /getMemoryApiOverrideContent\(sessionId\)/);
    assert.match(refresh, /getMemoryApiOverrideGeneration\(sessionId\)/);
    assert.match(refresh, /processMessagesWithFiles\(sourceMessages, modelIdForRequest, sessionId\)/);

    for (const [label, method] of [['send', captured], ['retry', retry]]) {
        assert.match(
            method,
            /processMessagesWithFiles\(sanitizedMessages, modelIdForRequest, session\.id\)/,
            `${label} must build its request from the owning session's override`
        );
        assert.match(
            method,
            /getMemoryApiOverrideGeneration\(session\.id\)/,
            `${label} must snapshot the owning session's override generation`
        );
        assert.match(
            method,
            /refreshProcessedMessagesIfMemoryOverrideChanged\([\s\S]*?session\.id\s*\)/,
            `${label} must refresh only from the owning session's override`
        );
        assert.match(method, /clearMemoryApiOverrideContent\(session\.id\)/);
    }
});

test('Retry reserves its target session synchronously and releases only its own stream', () => {
    const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    const chatArea = fs.readFileSync(path.join(__dirname, 'components/ChatArea.js'), 'utf8');
    const constructor = sourceMethodAt(app, 'constructor()');
    const retry = sourceMethodAt(app, 'async regenerateResponse(');
    const send = sourceMethodAt(app, 'async sendMessage(');

    assert.match(constructor, /this\.regenerationReservations = new Set\(\)/);
    assert.match(retry, /options\.sessionId/);
    assert.match(retry, /options\.userMessageId/);
    assert.match(retry, /this\.regenerationReservations\.has\(reservationKey\)/);

    const reserve = retry.indexOf('this.regenerationReservations.add(reservationKey)');
    const exposeController = retry.indexOf('this.setSessionStreamingState(session.id, true, ownedAbortController');
    const firstAwait = retry.indexOf('await ');
    assert.ok(
        reserve >= 0 && exposeController > reserve && firstAwait > exposeController,
        'Retry must own the session and expose its abort controller before its first await'
    );

    const release = retry.lastIndexOf('this.regenerationReservations.delete(reservationKey)');
    const ownedState = retry.lastIndexOf('ownedState.abortController === ownedAbortController');
    assert.ok(release > firstAwait && ownedState > release, 'Retry cleanup must release only the stream it owns');
    assert.match(send, /regenerationReservations\.has\(targetSessionId\)/);
    assert.match(retry, /sendSubmissionsInFlight\.has\(reservationKey\)/);

    const targetedCalls = chatArea.match(/regenerateResponse\(\{ sessionId, userMessageId, mutationToken \}\)/g) || [];
    assert.equal(targetedCalls.length, 2, 'both Retry entry points must preserve their session and prompt anchor');
});

test('deletion tombstones sessions before waiting and gates tracked background writers', () => {
    const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    const constructor = sourceMethodAt(app, 'constructor()');
    const beginMutation = sourceMethodAt(app, 'beginSessionMutation(');
    const endMutation = sourceMethodAt(app, 'endSessionMutation(');
    const cancel = sourceMethodAt(app, 'async cancelPendingSendsAndWait(');
    const deleteSession = sourceMethodAt(app, 'async deleteSession(');
    const deleteAll = sourceMethodAt(app, 'async deleteAllChats(');
    const clearMemoryPrompts = sourceMethodAt(app, 'async clearPendingMemoryApprovalPromptsForCurrentSession(');
    const staleMemoryApproval = sourceMethodAt(app, 'async resolveStaleMemoryApproval(');
    const confirmEdit = sourceMethodAt(app, 'async confirmEditPrompt(');
    const title = sourceMethodAt(app, 'async generateSessionTitleIfNeeded(');
    const extraction = sourceMethodAt(app, 'async runPostTurnMemoryExtraction(');
    const prepareFiles = sourceMethodAt(app, 'async ensureMessageFileMetadata(');
    const citations = sourceMethodAt(app, 'async enrichCitationsAndUpdateUI(');
    const bannedWarning = sourceMethodAt(app, 'async showBannedStationWarningModal(');
    const scrubber = sourceMethodAt(app, 'async preCacheScrubberRestore(');

    assert.match(constructor, /this\.deletedSessionIds = new Set\(\)/);
    assert.match(constructor, /this\.messageFilePreparationSessions = new Map\(\)/);
    assert.match(constructor, /this\.sessionMutationReservations = new Map\(\)/);
    assert.match(beginMutation, /this\.isSessionDeleted\(sessionId\)/);
    assert.match(beginMutation, /this\.sessionMutationReservations\.set\(sessionId, reservations\)/);
    assert.match(endMutation, /this\.sessionMutationReservations\.delete\(sessionId\)/);
    assert.match(cancel, /submission\.controller\?\.abort\(\)/);
    assert.match(cancel, /state\?\.abortController\?\.abort\(\)/);
    assert.match(cancel, /memoryExtractionAbortControllers/);
    assert.match(cancel, /accessAcquisitionInFlight/);
    assert.match(cancel, /hasRegeneration/);
    assert.match(cancel, /hasSessionMutation/);
    assert.match(cancel, /hasMemoryExtraction/);
    assert.match(cancel, /hasFilePreparation/);
    assert.match(cancel, /hasAccessAcquisition/);

    const tombstoneOne = deleteSession.indexOf('this.deletedSessionIds.add(sessionId)');
    const waitOne = deleteSession.indexOf('await this.cancelPendingSendsAndWait([sessionId])');
    const deleteOne = deleteSession.indexOf('await chatDB.deleteSession(sessionId)');
    assert.ok(tombstoneOne >= 0 && waitOne > tombstoneOne && deleteOne > waitOne);

    const tombstoneAll = deleteAll.indexOf('this.deletedSessionIds.add(sessionId)');
    const waitAll = deleteAll.indexOf('await this.cancelPendingSendsAndWait()');
    const clearAll = deleteAll.indexOf('await chatDB.clearAllChats()');
    assert.ok(tombstoneAll >= 0 && waitAll > tombstoneAll && clearAll > waitAll);

    const titleFetch = title.indexOf('await chatDB.getSessionMessages(session.id)');
    const titleGate = title.indexOf('this.isSessionDeleted(sessionId)', titleFetch);
    assert.ok(titleFetch >= 0 && titleGate > titleFetch, 'title generation must re-check its tombstone after loading');

    const extractionCall = extraction.indexOf('await ingestMemoryMessages(');
    const extractionGate = extraction.indexOf('this.isSessionDeleted(session.id)', extractionCall);
    assert.ok(extractionCall >= 0 && extractionGate > extractionCall, 'memory extraction must gate its post-request writes');

    assert.match(prepareFiles, /messageFilePreparationSessions\.set\(message\.id, message\.sessionId\)/);
    const fileBuild = prepareFiles.indexOf('await this.buildMessageFileMetadata(pendingFiles)');
    const fileGate = prepareFiles.indexOf('this.isSessionDeleted(message.sessionId)', fileBuild);
    assert.ok(fileBuild >= 0 && fileGate > fileBuild, 'file preparation must stop after deletion');

    const citationFetch = citations.indexOf('await Promise.all(metadataPromises)');
    const citationGate = citations.indexOf('this.isSessionDeleted(message.sessionId)', citationFetch);
    const citationSave = citations.indexOf('await chatDB.saveMessage(message)', citationFetch);
    assert.ok(citationFetch >= 0 && citationGate > citationFetch && citationSave > citationGate);

    const scrubberRequest = scrubber.indexOf('restoreResult = await');
    const scrubberGate = scrubber.lastIndexOf('this.isSessionDeleted(session.id)');
    const scrubberSave = scrubber.lastIndexOf('await chatDB.saveMessage(message)');
    assert.ok(scrubberRequest >= 0 && scrubberGate > scrubberRequest && scrubberSave > scrubberGate);

    for (const [label, mutation] of [
        ['memory-disable cleanup', clearMemoryPrompts],
        ['stale memory approval', staleMemoryApproval],
        ['prompt edit', confirmEdit],
        ['banned-key warning', bannedWarning]
    ]) {
        const begin = mutation.indexOf('this.beginSessionMutation(session.id');
        const beginById = mutation.indexOf('this.beginSessionMutation(sessionId');
        const firstAwait = mutation.indexOf('await ');
        const end = Math.max(
            mutation.lastIndexOf('this.endSessionMutation(session.id, mutationToken)'),
            mutation.lastIndexOf('this.endSessionMutation(sessionId, mutationToken)')
        );
        const effectiveBegin = Math.max(begin, beginById);
        assert.ok(
            effectiveBegin >= 0 && firstAwait > effectiveBegin && end > firstAwait,
            `${label} must remain owned until its writes finish`
        );
    }
    assert.match(clearMemoryPrompts, /this\.isSessionDeleted\(sessionId\)/);

    assert.match(bannedWarning, /sessionsById\.get\(sessionId\)/);
    assert.match(bannedWarning, /this\.isSessionDeleted\(session\.id\)/);
    assert.match(bannedWarning, /sessionId:\s*session\.id/);
});

test('navigation generations keep delayed loads from stealing the selected composer', () => {
    const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    const constructor = sourceMethodAt(app, 'constructor()');
    const create = sourceMethodAt(app, 'async createSession(');
    const switchSession = sourceMethodAt(app, 'async switchSession(');
    const clear = sourceMethodAt(app, 'async clearCurrentSession(');
    const deleteSession = sourceMethodAt(app, 'async deleteSession(');
    const send = sourceMethodAt(app, 'async sendMessage(');
    const inputState = sourceMethodAt(app, 'updateInputState() {');

    assert.match(constructor, /this\.navigationGeneration = 0/);
    assert.match(constructor, /this\.sessionSwitchInFlight = null/);

    const createGeneration = create.indexOf('++this.navigationGeneration');
    const createAwait = create.indexOf('await ');
    const selectDecision = create.indexOf('const shouldSelectCreatedSession');
    assert.ok(createGeneration >= 0 && createAwait > createGeneration && selectDecision > createAwait);
    assert.match(create, /this\.navigationGeneration === createNavigationGeneration/);
    assert.match(create, /this\.state\.currentSessionId === expectedCurrentSessionId/);
    assert.match(create, /pendingModelPreferenceAtStart/);
    assert.match(create, /this\.state\.pendingModelName === pendingModelPreferenceAtStart/);
    const selectedBlock = sourceBlockAt(create, create.indexOf('if (shouldSelectCreatedSession)'));
    assert.match(selectedBlock, /this\.state\.currentSessionId = session\.id/);

    const switchGeneration = switchSession.indexOf('++this.navigationGeneration');
    const switchAwait = switchSession.indexOf('await this.ensureSessionLoaded(sessionId)');
    const switchGate = switchSession.indexOf('this.navigationGeneration !== switchNavigationGeneration');
    assert.ok(switchGeneration >= 0 && switchAwait > switchGeneration && switchGate > switchAwait);
    assert.match(switchSession, /sessionId === this\.state\.currentSessionId && !this\.sessionSwitchInFlight/);
    assert.match(switchSession, /this\.sessionSwitchInFlight = transition/);
    assert.match(switchSession, /await this\.renderMessages\(\)/);
    assert.match(switchSession, /this\.state\.currentSessionId !== sessionId/);
    assert.match(switchSession, /this\.sessionSwitchInFlight === transition/);
    assert.match(send, /if \(this\.sessionSwitchInFlight\) return/);
    assert.match(inputState, /const isSwitchingSession = Boolean\(this\.sessionSwitchInFlight\)/);
    assert.match(inputState, /this\.elements\.messageInput\.disabled = isSwitchingSession/);
    assert.match(inputState, /Loading selected chat/);

    const clearGeneration = clear.indexOf('++this.navigationGeneration');
    const clearAwait = clear.indexOf("await chatDB.getSetting('selectedModel')");
    const clearGate = clear.indexOf('this.navigationGeneration !== clearNavigationGeneration');
    assert.ok(clearGeneration >= 0 && clearAwait > clearGeneration && clearGate > clearAwait);

    const deleteGeneration = deleteSession.indexOf('++this.navigationGeneration');
    const deleteAwait = deleteSession.indexOf('await chatDB.deleteSession(sessionId)');
    const deleteGate = deleteSession.indexOf('this.navigationGeneration === deleteNavigationGeneration');
    const fallbackResolution = deleteSession.indexOf('replacementSessionId = this.state.sessions.length');
    const fallbackSelection = deleteSession.indexOf('this.state.currentSessionId = replacementSessionId');
    assert.ok(
        deleteGeneration >= 0 && deleteAwait > deleteGeneration
            && deleteGate > deleteAwait
            && fallbackResolution > deleteGate
            && fallbackSelection > fallbackResolution,
        'a delayed delete must not replace a newer user-selected chat'
    );
    const ownedDeleteBlock = sourceBlockAt(deleteSession, deleteSession.indexOf('if (stillOwnsSelection)'));
    assert.match(ownedDeleteBlock, /this\.editingMessageId = null/);
    assert.match(ownedDeleteBlock, /this\.editDrafts\.clear\(\)/);
    assert.match(ownedDeleteBlock, /replacementSessionId = this\.state\.sessions\.length/);
    assert.match(ownedDeleteBlock, /this\.state\.currentSessionId = replacementSessionId/);
    assert.match(deleteSession, /const replacementIsStillSelected = stillOwnsSelection[\s\S]*this\.navigationGeneration === deleteNavigationGeneration[\s\S]*this\.state\.currentSessionId === replacementSessionId/);
    const replacementBlock = sourceBlockAt(
        deleteSession,
        deleteSession.indexOf('if (replacementIsStillSelected)')
    );
    assert.match(replacementBlock, /this\.updateUrlWithSession\(replacementSessionId\)/);
    assert.match(replacementBlock, /sessionStorage\.(?:setItem|removeItem)/);
    assert.match(replacementBlock, /this\.restoreChatbarStateForSession\(this\.state\.currentSessionId\)/);
    assert.match(replacementBlock, /this\.rightPanel\?\.onSessionChange/);
});

test('A → B → A navigation cannot bind a follow-up to the stale B session', async () => {
    const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    const switchSession = sourceMethodAt(source, 'async switchSession(');
    const chatDB = { saveSetting() {} };
    const inferenceService = { getCachedModels() { return []; } };
    const Harness = Function(
        'chatDB',
        'inferenceService',
        'SESSION_STORAGE_KEY',
        `return class NavigationHarness { ${switchSession} };`
    )(chatDB, inferenceService, 'current-session');

    const originalSessionStorage = global.sessionStorage;
    global.sessionStorage = { setItem() {}, removeItem() {} };
    const deferred = () => {
        let resolve;
        const promise = new Promise(done => { resolve = done; });
        return { promise, resolve };
    };
    const sessionA = { id: 'chat-a', model: 'model-a' };
    const sessionB = { id: 'chat-b', model: 'model-b' };
    const makeHarness = () => {
        const instance = new Harness();
        instance.navigationGeneration = 0;
        instance.sessionSwitchInFlight = null;
        instance.state = {
            currentSessionId: sessionA.id,
            sessions: [sessionA, sessionB],
            sessionsById: new Map([[sessionA.id, sessionA], [sessionB.id, sessionB]])
        };
        instance.editingMessageId = null;
        instance.editDrafts = new Map();
        instance.chatInput = { updateSearchToggleUI() {} };
        instance.updateInputState = () => {};
        instance.saveCurrentSessionScrollPosition = () => {};
        instance.saveChatbarStateForSession = () => {};
        instance.updateUrlWithSession = () => {};
        instance.hideScrollToBottomButton = () => {};
        instance.renderSessions = () => {};
        instance.renderCurrentModel = () => {};
        instance.resetMessageInputLayout = () => {};
        instance.restoreChatbarStateForSession = () => {};
        instance.updateShareButtonUI = () => {};
        instance.renderMessages = async () => {};
        instance.isMobileView = () => false;
        instance.rightPanel = null;
        instance.floatingPanel = null;
        instance.sidebar = null;
        return instance;
    };

    try {
        const loadB = deferred();
        const app = makeHarness();
        app.ensureSessionLoaded = async (sessionId) => {
            if (sessionId === sessionB.id) await loadB.promise;
        };

        const staleB = app.switchSession(sessionB.id);
        await Promise.resolve();
        await app.switchSession(sessionA.id);
        loadB.resolve();
        await staleB;

        assert.equal(app.state.currentSessionId, sessionA.id);
        assert.equal(app.sessionSwitchInFlight, null);

        const renderB = deferred();
        const loadingApp = makeHarness();
        const busyStates = [];
        loadingApp.updateInputState = () => busyStates.push(Boolean(loadingApp.sessionSwitchInFlight));
        loadingApp.ensureSessionLoaded = async () => {};
        loadingApp.renderMessages = () => renderB.promise;
        const loadingB = loadingApp.switchSession(sessionB.id);
        for (let i = 0; i < 4 && loadingApp.state.currentSessionId !== sessionB.id; i += 1) {
            await Promise.resolve();
        }
        assert.equal(loadingApp.state.currentSessionId, sessionB.id);
        assert.equal(loadingApp.sessionSwitchInFlight?.targetSessionId, sessionB.id);
        assert.equal(busyStates.at(-1), true);
        renderB.resolve();
        await loadingB;
        assert.equal(loadingApp.sessionSwitchInFlight, null);
        assert.equal(busyStates.at(-1), false);
    } finally {
        global.sessionStorage = originalSessionStorage;
    }
});

test('forks copy the transcript without copying zkAPI access or stealing later navigation', () => {
    const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    const fork = sourceMethodAt(app, 'async forkConversation(');

    const generation = fork.indexOf('++this.navigationGeneration');
    const firstAwait = fork.indexOf('await ');
    const selectDecision = fork.indexOf('const shouldSelectFork');
    assert.ok(
        generation >= 0 && firstAwait > generation && selectDecision > firstAwait,
        'fork navigation ownership must be claimed before its first asynchronous read'
    );
    assert.match(fork, /const sourceSessionId = session\.id/);
    assert.match(fork, /apiKey:\s*null/);
    assert.match(fork, /apiKeyInfo:\s*null/);
    assert.match(fork, /expiresAt:\s*null/);
    assert.match(fork, /sharedAccess:\s*false/);
    assert.doesNotMatch(fork, /getAccessInfo\s*\(/);
    assert.doesNotMatch(fork, /accessInfo\.(?:token|apiKey)/);

    assert.match(fork, /const shouldSelectFork = this\.navigationGeneration === forkNavigationGeneration[\s\S]*this\.state\.currentSessionId === sourceSessionId/);
    const selectionBlock = sourceBlockAt(fork, fork.indexOf('if (shouldSelectFork)'));
    assert.match(selectionBlock, /this\.state\.currentSessionId = newSessionId/);
    assert.match(selectionBlock, /await chatDB\.saveSetting\('currentSessionId', newSessionId\)/);
    assert.match(fork, /const forkIsStillSelected = shouldSelectFork[\s\S]*this\.navigationGeneration === forkNavigationGeneration[\s\S]*this\.state\.currentSessionId === newSessionId/);
    const postSelection = fork.slice(fork.indexOf('if (!forkIsStillSelected) return;'));
    assert.match(postSelection, /this\.editingMessageId = null/);
    assert.match(postSelection, /this\.editDrafts\.clear\(\)/);
    assert.match(postSelection, /this\.updateUrlWithSession\(newSessionId\)/);
    assert.match(postSelection, /this\.rightPanel\?\.onSessionChange\?\.\(newSession\)/);

    assert.match(fork, /const sourceLease = zkapiClient\.activeLease/);
    assert.match(fork, /sourceLease\?\.session_id === sourceSessionId/);
    assert.match(fork, /this\.startPreviousChatLeaseSettlement\(session, sourceLease\)/);
});

test('wallet transactions leave gas estimation and EIP-1559 fee selection to MetaMask', async () => {
    const contractErrors = await import(pathToFileURL(path.join(__dirname, 'services/zkapiContractError.mjs')));
    const staleRoot = contractErrors.contractEstimateError({
        message: 'execution reverted',
        data: { originalError: { data: '0x607447de' } }
    });
    assert.equal(staleRoot.code, 'stale_root');
    assert.match(staleRoot.message, /vault changed/i);
    const unknown = contractErrors.contractEstimateError({ message: 'execution reverted' });
    assert.equal(unknown.code, 'gas_estimation_failed');
    assert.match(unknown.message, /Transaction simulation failed: execution reverted/);
    assert.doesNotMatch(unknown.message, /market|gas price/i);
    const client = fs.readFileSync(path.join(__dirname, 'services/zkapiClient.js'), 'utf8');
    assert.doesNotMatch(client, /method: 'eth_estimateGas'/);
    assert.doesNotMatch(client, /transaction\.(?:gas|gasPrice|maxFeePerGas|maxPriorityFeePerGas)\s*=/);
    assert.match(client, /method: 'eth_sendTransaction'/);
    assert.match(client, /contractRevertSelector\(error\)/);
    assert.match(client, /error\?\.code !== 'stale_root'/);
});

test('published vault challenge-period getter is probed before the reverting fallback', () => {
    const client = fs.readFileSync(path.join(__dirname, 'services/zkapiClient.js'), 'utf8');
    const method = sourceMethodAt(client, 'async loadChallengePeriod()');
    const publishedGetter = method.indexOf('ABI.legacyChallengePeriod');
    const fallbackGetter = method.indexOf('ABI.challengePeriod');

    assert.ok(publishedGetter >= 0, 'published CHALLENGE_PERIOD() getter is missing');
    assert.ok(fallbackGetter >= 0, 'challengePeriod() fallback getter is missing');
    assert.ok(
        publishedGetter < fallbackGetter,
        'the known-reverting fallback must not be probed before the published getter'
    );
});

test('lease settlement state is visible in every relevant OA chat surface', () => {
    const index = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    const sidebar = fs.readFileSync(path.join(__dirname, 'components/Sidebar.js'), 'utf8');
    const panel = fs.readFileSync(path.join(__dirname, 'components/RightPanel.js'), 'utf8');
    const experience = fs.readFileSync(path.join(__dirname, 'components/ZkapiStateExperience.js'), 'utf8');
    const uxState = fs.readFileSync(path.join(__dirname, 'services/zkapiUxState.mjs'), 'utf8');
    const upstreamPanel = fs.readFileSync(path.join(__dirname, 'components/OaRightPanelBase.js'), 'utf8');
    const logRenderer = fs.readFileSync(path.join(__dirname, 'services/networkLogRenderer.js'), 'utf8');
    assert.match(index, /id="zkapi-composer-status"/);
    assert.match(app, /pendingSettlementSend/);
    assert.match(app, /Your message is queued until the previous chat key closes/);
    assert.match(sidebar, /Closing private key/);
    assert.match(panel, /renderZkapiPanelExperience/);
    assert.match(panel, /Closing previous chat key/);
    assert.match(experience, /renderZkapiComposerStatus/);
    assert.match(uxState, /Finishing previous chat/);
    assert.match(uxState, /Message queued/);
    assert.match(upstreamPanel, /getMissingApiKeyStatus/);
    assert.match(logRenderer, /Previous chat key settled/);
});

test('browser withdrawal refreshes stale Merkle roots before retrying', () => {
    const runtime = fs.readFileSync(path.join(__dirname, 'services/browserWalletRuntime.js'), 'utf8');
    const rootSync = fs.readFileSync(path.join(__dirname, 'services/zkapiWithdrawalRoot.mjs'), 'utf8');
    const client = fs.readFileSync(path.join(__dirname, 'services/zkapiClient.js'), 'utf8');
    assert.match(runtime, /expectedActiveRoot/);
    assert.match(runtime, /waitForExpectedActiveRoot/);
    assert.match(runtime, /sameFelt\(existing\.public_inputs\?\.active_root, path\.active_root\)/);
    assert.match(rootSync, /indexer_root_lag/);
    assert.match(client, /`0x\$\{ABI\.currentRoot\}`/);
    assert.match(client, /const attempts = this\.browserMode \? 3 : 1/);
    assert.match(client, /Refreshing the Merkle path and proof/);
});

test('withdrawal root synchronization waits for the indexer and fails closed', async () => {
    const roots = await import(pathToFileURL(path.join(__dirname, 'services/zkapiWithdrawalRoot.mjs')));
    let calls = 0;
    const current = await roots.waitForExpectedActiveRoot(async () => {
        calls += 1;
        return { active_root: calls === 1 ? '0x10' : '0x11' };
    }, 17n, { attempts: 3, delayMs: 0, sleep: async () => {} });
    assert.equal(current.active_root, '0x11');
    assert.equal(calls, 2);
    assert.equal(roots.sameFelt('0x11', 17n), true);

    await assert.rejects(
        roots.waitForExpectedActiveRoot(
            async () => ({ active_root: '0x12' }),
            '0x13',
            { attempts: 2, delayMs: 0, sleep: async () => {} }
        ),
        error => error.code === 'indexer_root_lag'
    );
});

test('browser withdrawal settles an active key instead of waiting for expiry', () => {
    const client = fs.readFileSync(path.join(__dirname, 'services/zkapiClient.js'), 'utf8');
    const runtime = fs.readFileSync(path.join(__dirname, 'services/browserWalletRuntime.js'), 'utf8');
    const modal = fs.readFileSync(path.join(__dirname, 'components/AccountModal.js'), 'utf8');
    assert.match(client, /await this\.settleActiveLease\(onStatus\)/);
    assert.match(runtime, /await this\.settleActiveLease\(\);\s*return withBrowserWalletLock/);
    assert.match(modal, /Settle key now/);
    assert.doesNotMatch(modal, /withdrawButton\.disabled = .*activeLease/);
    assert.match(modal, /withdrawalAmount\.textContent = zkapiClient\.formatMoney/);
    assert.match(modal, /data-active-lease-notice/);
});

test('deposit captures the edited amount before the busy-state render', () => {
    const modal = fs.readFileSync(path.join(__dirname, 'components/AccountModal.js'), 'utf8');
    const capture = modal.indexOf('const amount = depositInput?.value ?? this.depositAmount');
    const run = modal.indexOf('return this.run(async (report) => {', capture);
    assert.ok(capture >= 0, 'deposit amount capture is missing');
    assert.ok(run > capture, 'deposit must capture the amount before run() re-renders the modal');
    assert.match(modal.slice(run, run + 300), /zkapiClient\.deposit\(amount,/);
    assert.match(modal, /if \(this\.isOpen && !this\.busy && zkapiClient\.note/);
    assert.match(modal, /this\.depositAmount = depositInput\.value/);
});

test('an unsigned prepared deposit can be replaced after MetaMask cancellation', () => {
    const runtime = fs.readFileSync(path.join(__dirname, 'services/browserWalletRuntime.js'), 'utf8');
    assert.match(runtime, /if \(this\.runtime\.pendingDeposit\.transactionHash\)/);
    assert.match(runtime, /await this\.commit\(\{ \.\.\.this\.runtime, pendingDeposit: null \}\)/);
    assert.match(runtime, /A different deposit transaction is already pending in MetaMask/);
});
