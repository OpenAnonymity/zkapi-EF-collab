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

    assert.match(runtime, /async acquireEphemeralKey\(sessionId, onProgress = \(\) => \{\}\)/);
    assert.match(runtime, /apiKey: lease\.api_key/);
    assert.match(runtime, /spendingLimitUsd: Number\(lease\.spending_limit_usd\)/);
    assert.match(runtime, /selectLeaseSpendingLimitCredits/);
    assert.match(runtime, /request_charge_cap: spendingLimitCredits/);
    assert.match(runtime, /request\.public_inputs\.solvency_bound/);
    assert.match(runtime, /lease\.inFlight \+= 1/);
    assert.match(runtime, /lease\.inFlight = Math\.max\(0, lease\.inFlight - 1\)/);
    assert.doesNotMatch(runtime, /requestsServed|requests_per_key|lease_request_limit/);
    assert.doesNotMatch(runtime, /async inferenceFetch\(/);
    assert.match(client, /async acquireInferenceAccess\(sessionId\)/);
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
    const helperStart = app.indexOf('\n    startPreviousChatLeaseSettlement(previousSession, previousLease) {', handlerStart);
    assert.ok(handlerStart >= 0 && helperStart > handlerStart, 'New Chat settlement helper is missing');

    const handler = app.slice(handlerStart, helperStart);
    assert.match(handler, /await this\.clearCurrentSession\(\{ \.\.\.options, immediate: true \}\)/);
    assert.match(handler, /this\.startPreviousChatLeaseSettlement\(previousSession, previousLease\)/);
    assert.doesNotMatch(handler, /await this\.startPreviousChatLeaseSettlement/);
    assert.ok(
        handler.indexOf('clearCurrentSession') < handler.indexOf('startPreviousChatLeaseSettlement'),
        'the new composer must open before background settlement starts'
    );

    const helper = app.slice(helperStart, app.indexOf('/**', helperStart));
    assert.match(helper, /this\.newChatSettlementPromise = settlement/);
    assert.match(helper, /await this\.stopSessionStreamingAndWait/);
    assert.match(helper, /await zkapiClient\.settleActiveLease\(\)/);
    assert.match(helper, /error\?\.code !== 'lease_requests_in_flight'/);
    assert.match(helper, /inferenceService\.clearAccessInfo\(ownerSession\)/);
    assert.match(helper, /phase: 'settling'/);
    assert.match(helper, /phase: 'ready'/);
    assert.match(helper, /zkapi-lease-settlement-start/);
    assert.match(helper, /zkapi-lease-settlement-complete/);
    assert.doesNotMatch(helper, /newChatButton\.disabled/);

    const sendStart = app.indexOf('async sendMessage()');
    const send = app.slice(sendStart, app.indexOf('// Create session if none exists', sendStart));
    assert.match(send, /await this\.waitForPreviousChatLeaseSettlement\(\)/);
    assert.match(send, /retry settlement, and visibly queue the send/);
    assert.match(send, /this\.startPreviousChatLeaseSettlement\(owningSession, activeLease\)/);
    assert.doesNotMatch(send, /Continue the active chat until its private key expires/);
    assert.ok(
        send.indexOf('waitForPreviousChatLeaseSettlement') < send.indexOf('const activeLease'),
        'a fast send must await background settlement before checking lease ownership'
    );
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
