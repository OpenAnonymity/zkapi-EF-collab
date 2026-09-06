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
        'browserrequestprover_new',
        'browserrequestprover_prepare_request',
        'browser_complete_response',
        'browser_withdrawal_nullifier',
        'browser_prepare_withdrawal'
    ]) {
        assert.ok(exports.has(name), `missing WASM export ${name}`);
    }
});

test('browser worker retains the decoded request prover and retries failed initialization', () => {
    const glue = fs.readFileSync(path.join(__dirname, 'wasm/zkapi_browser.js'), 'utf8');
    const worker = fs.readFileSync(path.join(__dirname, 'services/zkapiWasmWorker.js'), 'utf8');
    const runtime = fs.readFileSync(path.join(__dirname, 'services/browserWalletRuntime.js'), 'utf8');

    assert.match(glue, /export class BrowserRequestProver/);
    assert.match(worker, /const requestProvers = new Map\(\)/);
    assert.match(worker, /new BrowserRequestProver\(bytes\)/);
    assert.match(worker, /case 'preloadRequestProver':\s*await loadRequestProver\(payload\.provingKey\)/);
    assert.match(worker, /return parse\(prover\.prepare_request\(/);
    assert.match(worker, /if \(provingKeys\.get\(cacheKey\) === promise\) provingKeys\.delete\(cacheKey\)/);
    assert.match(worker, /requestProvers\.delete\(cacheKey\)/);
    assert.doesNotMatch(worker, /\bbrowser_prepare_request\b/);
    assert.match(runtime, /prewarmRequestProver\(\)/);
    assert.match(runtime, /this\.worker\.call\('preloadRequestProver'/);
    assert.match(runtime, /if \(this\.runtime\.state \|\| this\.runtime\.pendingDeposit\)/);
    const prepareDeposit = sourceMethodAt(runtime, 'async prepareDeposit(amount)');
    const walletStatus = sourceMethodAt(runtime, 'async walletStatus()');
    assert.match(prepareDeposit, /void this\.prewarmRequestProver\(\)/);
    assert.ok(
        prepareDeposit.indexOf('void this.prewarmRequestProver()')
            > prepareDeposit.indexOf('await withBrowserWalletLock'),
        'deposit warm-up must not block its lightweight worker preparation'
    );
    assert.match(walletStatus, /const status = await this\.worker\.call\('walletStatus'/);
    assert.match(walletStatus, /void this\.prewarmRequestProver\(\)/);
    assert.ok(
        walletStatus.indexOf('void this.prewarmRequestProver()')
            > walletStatus.indexOf("await this.worker.call('walletStatus'"),
        'funded-page warm-up must begin only after initial wallet status resolves'
    );
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

test('Sepolia browser deployments proxy the pinned API and public OpenRouter model catalog', () => {
    for (const configName of ['vercel.browser.json', 'vercel.ux-quiet.json']) {
        const vercel = JSON.parse(fs.readFileSync(path.join(root, configName), 'utf8'));
        assert.deepEqual(vercel.rewrites, [
            {
                source: '/zkapi-deployment/:path*',
                destination: 'https://d33l4w2z2nh4cg.cloudfront.net/:path*'
            },
            {
                source: '/zkapi-model-catalog',
                destination: 'https://openrouter.ai/api/v1/models'
            }
        ], configName);
        const catalogHeaders = vercel.headers.find(entry => entry.source === '/zkapi-model-catalog');
        assert.deepEqual(catalogHeaders?.headers, [
            { key: 'Cache-Control', value: 'no-store' }
        ], configName);
    }
});

test('separate Vercel mainnet build packages the pinned config and model-catalog proxy', () => {
    const vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.mainnet.json'), 'utf8'));
    assert.equal(vercel.buildCommand, './scripts/package-browser-client-mainnet.sh');
    assert.equal(vercel.outputDirectory, 'dist/browser-mainnet');
    assert.deepEqual(vercel.rewrites, [
        {
            source: '/zkapi-deployment/:path*',
            destination: 'https://d27v1dvkaxfc09.cloudfront.net/:path*'
        },
        {
            source: '/zkapi-model-catalog',
            destination: 'https://openrouter.ai/api/v1/models'
        }
    ]);
    const catalogHeaders = vercel.headers.find(entry => entry.source === '/zkapi-model-catalog');
    assert.deepEqual(catalogHeaders?.headers, [
        { key: 'Cache-Control', value: 'no-store' }
    ]);
    const packager = fs.readFileSync(path.join(root, 'scripts/package-browser-client-mainnet.sh'), 'utf8');
    assert.match(packager, /compose-browser-client\.mjs/);
    assert.match(packager, /--network mainnet/);
    assert.equal(vercel.installCommand, 'npm ci');
    const composer = fs.readFileSync(path.join(root, 'scripts/compose-browser-client.mjs'), 'utf8');
    assert.match(composer, /browser-config\.mainnet\.json/);
    assert.match(composer, /path\.join\(stage, 'browser-config\.json'\)/);
});

test('fresh chats default to GPT-5.6 Sol without replacing explicit model preferences', async () => {
    const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        writable: true,
        value: {
            getItem() { return null; },
            setItem() {},
            removeItem() {}
        }
    });

    try {
        const modelConfigUrl = pathToFileURL(path.join(__dirname, 'services/modelConfig.js'));
        modelConfigUrl.searchParams.set('fresh-default-test', String(Date.now()));
        const modelSelectionUrl = pathToFileURL(path.join(__dirname, '../oa-chat/chat/domain/modelSelection.js'));
        modelSelectionUrl.searchParams.set('fresh-default-test', String(Date.now()));
        const modelPricingUrl = pathToFileURL(path.join(__dirname, 'services/modelPricing.mjs'));
        modelPricingUrl.searchParams.set('fresh-default-test', String(Date.now()));

        const [modelConfig, modelSelection, modelPricing] = await Promise.all([
            import(modelConfigUrl.href),
            import(modelSelectionUrl.href),
            import(modelPricingUrl.href)
        ]);

        assert.equal(modelPricing.DEFAULT_MODEL_ID, 'openai/gpt-5.6-sol');
        assert.equal(modelPricing.DEFAULT_MODEL_NAME, 'OpenAI: GPT-5.6 Sol');
        assert.equal(modelConfig.getDefaultModelId(), modelPricing.DEFAULT_MODEL_ID);
        assert.equal(modelConfig.getDefaultModelName(), modelPricing.DEFAULT_MODEL_NAME);
        assert.equal(modelConfig.getPinnedModels()[0], modelPricing.DEFAULT_MODEL_ID);

        const liveCatalog = [
            { id: 'openai/gpt-4o-mini', name: 'OpenAI: GPT-4o Mini' },
            { id: modelPricing.DEFAULT_MODEL_ID, name: modelPricing.DEFAULT_MODEL_NAME }
        ];
        assert.equal(
            modelSelection.getFallbackModelEntry(
                liveCatalog,
                modelConfig.getDefaultModelId(),
                modelConfig.getPinnedModels()
            ).id,
            modelPricing.DEFAULT_MODEL_ID,
            'the default must not depend on GPT-5.6 Sol being first in the deployment manifest'
        );

        for (const explicitChoice of ['OpenAI: GPT-4o Mini', 'Anthropic: Claude Opus 5']) {
            const update = modelSelection.resolveDefaultModelPreferenceUpdate({
                storedModelPreference: explicitChoice,
                pendingModelName: explicitChoice,
                hasCurrentSession: false,
                upgradeDefaultModelPreference: modelName => modelSelection.upgradeDefaultModelPreference(
                    modelName,
                    ['OpenAI: GPT-5.2 Instant', 'OpenAI: GPT-5.1 Instant'],
                    modelPricing.DEFAULT_MODEL_NAME
                )
            });
            assert.equal(update.upgradedStoredModelPreference, explicitChoice);
            assert.equal(update.shouldSaveStoredPreference, false);
            assert.equal(update.nextPendingModelName, explicitChoice);
            assert.equal(update.changed, false);
        }
    } finally {
        if (previousLocalStorage) {
            Object.defineProperty(globalThis, 'localStorage', previousLocalStorage);
        } else {
            delete globalThis.localStorage;
        }
    }
});

test('model availability supports both hosted deployment manifests and the local daemon', () => {
    const modelConfig = fs.readFileSync(path.join(__dirname, 'services/modelConfig.js'), 'utf8');
    assert.match(modelConfig, /\/zkapi-deployment\/config\.json/);
    assert.match(modelConfig, /\/zkapi\/v1\/config/);
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

test('browser chat leases prove exactly $1 without changing the trusted deployment minimum', async () => {
    const compat = await import(pathToFileURL(path.join(__dirname, 'services/zkapiRequestCompat.mjs')));
    const sepolia = JSON.parse(fs.readFileSync(path.join(__dirname, 'browser-config.json'), 'utf8'));
    const mainnet = JSON.parse(fs.readFileSync(path.join(__dirname, 'browser-config.mainnet.json'), 'utf8'));

    assert.equal(sepolia.trusted_deployment.request_charge_cap, 50_000);
    assert.equal(mainnet.trusted_deployment.request_charge_cap, 50_000);
    assert.deepEqual(compat.CHAT_SPENDING_TIER_USD, [1]);
    assert.equal(compat.selectLeaseSpendingLimitCredits(1_000_000, 50_000), 1_000_000);
    assert.equal(compat.selectLeaseSpendingLimitCredits(2_000_000, 50_000), 1_000_000);
    assert.equal(compat.selectLeaseSpendingLimitCredits(100_000_000, 50_000), 1_000_000);
});

test('browser chat leases give actionable guidance below the fixed $1 budget', async () => {
    const compat = await import(pathToFileURL(path.join(__dirname, 'services/zkapiRequestCompat.mjs')));

    assert.throws(
        () => compat.selectLeaseSpendingLimitCredits(999_999, 50_000),
        error => {
            assert.equal(error.code, 'insufficient_chat_balance');
            assert.equal(error.required_credits, 1_000_000);
            assert.match(error.message, /add funds/i);
            assert.match(error.message, /at least \$1\.00/i);
            return true;
        }
    );
});

test('browser direct requests derive output headroom from the proof-backed dollar budget', async () => {
    const compat = await import(pathToFileURL(path.join(__dirname, 'services/zkapiRequestCompat.mjs')));
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
    assert.match(api, /await zkapiClient\.acquireInferenceAccess\(sessionId, options\)/);
    assert.match(api, /fetch\('\/zkapi-model-catalog'/);
    assert.doesNotMatch(api, /fetch\('\/openrouter-models'/);
    const modelCatalogCache = fs.readFileSync(path.join(__dirname, '../oa-chat/chat/services/modelCatalogCache.js'), 'utf8');
    assert.match(modelCatalogCache, /const CACHE_VERSION = 2/);
    assert.match(api, /extends OpenRouterAPI/);
    assert.match(api, /oa-chat\/chat\/publicInferenceApi\.js/);
    const transport = fs.readFileSync(path.join(__dirname, '../oa-chat/chat/api.js'), 'utf8');
    assert.match(transport, /stream: true/);
    assert.match(transport, /finishReason: completionFinishReason/);
    assert.doesNotMatch(api, /\{ \.\.\.body, stream: false \}/);
});

test('onboarding has a static readable card surface and length-limited answers expose Continue', () => {
    const css = fs.readFileSync(path.join(__dirname, 'zkapi.css'), 'utf8');
    const welcome = fs.readFileSync(path.join(__dirname, 'components/WelcomePanel.js'), 'utf8');
    const templates = fs.readFileSync(path.join(__dirname, '../oa-chat/chat/components/MessageTemplates.js'), 'utf8');
    const chatArea = fs.readFileSync(path.join(__dirname, '../oa-chat/chat/components/ChatArea.js'), 'utf8');
    const app = fs.readFileSync(path.join(__dirname, '../oa-chat/chat/app.js'), 'utf8');
    assert.match(css, /\.zkapi-welcome-dialog\s*\{[\s\S]*color: hsl\(var\(--color-foreground\)\);[\s\S]*background: hsl\(var\(--color-card\)\);/);
    assert.match(welcome, /zkapi-welcome-dialog/);
    assert.match(templates, /message\.finishReason === 'length'/);
    assert.match(templates, /continue-message-btn/);
    assert.match(chatArea, /continueLimitedResponse/);
    assert.match(app, /Continue exactly where you left off/);
});

test('zkAPI clock updates are isolated from semantic rerenders', () => {
    const client = fs.readFileSync(path.join(__dirname, 'services/zkapiClient.js'), 'utf8');
    const app = fs.readFileSync(path.join(__dirname, '../oa-chat/chat/app.js'), 'utf8');
    const account = fs.readFileSync(path.join(__dirname, 'components/AccountModal.js'), 'utf8');
    const welcome = fs.readFileSync(path.join(__dirname, 'components/WelcomePanel.js'), 'utf8');
    const rightPanel = fs.readFileSync(path.join(__dirname, 'components/RightPanel.js'), 'utf8');
    const runtime = fs.readFileSync(path.join(__dirname, 'services/zkapiChatRuntimeCore.mjs'), 'utf8');
    const composition = fs.readFileSync(path.join(__dirname, 'ui/createZkapiUi.js'), 'utf8');

    assert.match(client, /setInterval\(\(\) => this\.emitClock\(\), 1_000\)/);
    assert.doesNotMatch(client, /emitChange\('clock'\)/);
    assert.match(client, /subscribeClock\(listener\)/);
    assert.match(client, /stateBeforeRefresh !== this\.runtimeStateSignature\(\)/);
    assert.doesNotMatch(app, /zkapiClient|subscribeClock/);
    assert.match(runtime, /detail\?\.reason !== 'clock'/);
    assert.match(composition, /renderZkapiComposerStatus\(status, componentApp\)/);
    assert.match(account, /zkapiClient\.subscribeClock\(/);
    assert.match(account, /data-zkapi-escape-countdown/);
    assert.match(account, /finalizeButton\.disabled = !ready \|\| this\.busy/);
    assert.match(welcome, /this\.step !== 'success'/);
    assert.match(rightPanel, /handleZkapiClock\(\)/);
    assert.match(rightPanel, /zkapiClockUnsubscribe/);
});

test('repeated input-state updates retain the animated send-button child', () => {
    const appSource = fs.readFileSync(path.join(__dirname, '../oa-chat/chat/app.js'), 'utf8');
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
    instance.exclusiveSessionMutationOwners = new Map();
    instance.searchEnabled = false;
    let isPreparing = true;
    instance.isCurrentSessionStreaming = () => isPreparing;
    instance.getPendingSend = () => null;
    instance.getSessionStreamingState = () => ({ phase: 'preparing-access' });

    instance.updateInputState();
    const orbitMarkup = sendBtn.innerHTML;
    instance.updateInputState();
    assert.equal(buttonWrites, 1, 'the busy orbit node must survive an unchanged update');
    assert.equal(sendBtn.innerHTML, orbitMarkup);
    assert.equal(sendBtn.dataset.visualState, 'busy');

    isPreparing = false;
    instance.updateInputState();
    assert.equal(buttonWrites, 2, 'a real visual-mode transition must still replace the icon');
    assert.equal(sendBtn.dataset.visualState, 'idle');
    instance.updateInputState();
    assert.equal(buttonWrites, 2, 'the idle icon must also remain mounted when unchanged');
});

test('OA System Panel is preserved with only ticket billing replaced', () => {
    const panel = fs.readFileSync(path.join(__dirname, 'components/RightPanel.js'), 'utf8');
    const modelPicker = fs.readFileSync(path.join(__dirname, '../oa-chat/chat/components/ModelPicker.js'), 'utf8');
    const upstreamPanel = fs.readFileSync(path.join(__dirname, '../oa-chat/chat/components/RightPanel.js'), 'utf8');
    const composition = fs.readFileSync(path.join(__dirname, 'ui/createZkapiUi.js'), 'utf8');
    assert.match(panel, /import \{ RightPanel as SharedRightPanel \} from '\.\.\/\.\.\/oa-chat\/chat\/publicApi\.js'/);
    assert.match(panel, /extends SharedRightPanel/);
    assert.match(panel, /generateFundingSectionHTML\(\)/);
    assert.doesNotMatch(panel, /OaRightPanelBase|super\.generateTopSectionHTML\(\)|<!-- API Key Panel -->/);
    assert.match(panel, /super\.attachTopSectionEventListeners\(\)/);
    assert.match(panel, /Private balance/);
    assert.match(upstreamPanel, /Ephemeral Access Key/);
    assert.match(upstreamPanel, /Network Proxy/);
    assert.match(upstreamPanel, /Activity Timeline/);
    assert.match(modelPicker, /presentation\?\.getModelPricing\?\.\(model\)/);
    assert.match(composition, /formatModelPricing/);
    assert.match(composition, /formatExactTokenPricing/);
    assert.match(composition, /Pricing unavailable/);
    assert.doesNotMatch(modelPicker, /Maximum private-balance charge per request/);
});

test('OA credit-exhaustion recovery immediately settles the zkAPI lease', () => {
    const backend = fs.readFileSync(path.join(__dirname, 'services/inference/backends/zkapiBackend.js'), 'utf8');
    assert.match(backend, /refreshOnCreditExhaustion: true/);
    assert.match(backend, /session\.zkapiSettleBeforeAccess = true/);
    assert.match(backend, /await zkapiClient\.settleActiveLease\(\)/);
    assert.match(backend, /delete session\.zkapiSettleBeforeAccess/);
});

// The former controller source-shape checks lived against a copied app. Run
// the actual shared controller and product runtime instead: their behavior is
// the contract, not helper names or an inactive payment-specific UI fork.
// Coverage: captured Send/Retry configuration; queued cancellation; New Chat
// settlement and logs; atomic prompts/files; transcript recovery; partial text,
// reasoning and images; tombstoned deletion; navigation/fork ownership; per-chat
// Memory isolation; usage accounting; real transport-access readiness.
test('browser composition executes the production controller and product lifecycle regressions', () => {
    const { spawnSync } = require('node:child_process');
    const testEnvironment = { ...process.env };
    // A nested runner must not inherit Node's child-test protocol: doing so
    // exits successfully without running these entrypoints or producing TAP.
    for (const key of Object.keys(testEnvironment)) if (key.startsWith('NODE_TEST_')) delete testEnvironment[key];
    const result = spawnSync(process.execPath, [
        '--test', '--test-force-exit',
        path.join(root, 'oa-chat/test/application/chatRuntimeOwnership.test.js'),
        path.join(root, 'oa-chat/test/application/forkComposition.test.js'),
        path.join(root, 'oa-chat/test/application/chatMemoryOwnership.test.js'),
        path.join(__dirname, 'zkapi-chat-runtime.test.mjs')
    ], { cwd: root, env: testEnvironment, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /production ChatApp runtime ownership/, 'the child must execute the production controller suite');
    assert.match(result.stdout, /(?:#|ℹ) tests [1-9]\d*/, 'a successful empty test process is not coverage');
});

test('shared user bubbles contain no duplicated payment-state receipts', () => {
    const templates = fs.readFileSync(path.join(root, 'oa-chat/chat/components/MessageTemplates.js'), 'utf8');
    assert.doesNotMatch(templates, /user-delivery|data-delivery-state/);
    assert.match(templates, /resend-prompt-btn/);
    assert.match(templates, /edit-prompt-btn/);
});

test('wallet transactions use a bounded preflight gas limit and leave EIP-1559 fees to MetaMask', async () => {
    const gas = await import(pathToFileURL(path.join(__dirname, 'services/zkapiGas.mjs')));
    assert.equal(gas.bufferedGasLimit('0x6d094d'), '0x839b46');
    assert.throws(
        () => gas.bufferedGasLimit(16_000_000n),
        error => error.code === 'transaction_gas_limit_exceeded'
    );
    assert.throws(() => gas.bufferedGasLimit('0x0'), /invalid gas estimate/);
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
    const send = sourceMethodAt(client, 'async sendContractTransaction(');
    const estimateIndex = send.indexOf("method: 'eth_estimateGas'");
    const gasIndex = send.indexOf('transaction.gas = bufferedGasLimit(estimate)');
    const submitIndex = send.indexOf("method: 'eth_sendTransaction'");
    assert.ok(estimateIndex >= 0 && gasIndex > estimateIndex && submitIndex > gasIndex);
    assert.match(send, /catch \(error\) \{[\s\S]*tagTransactionError\(contractEstimateError\(error\), 'estimate', false\)[\s\S]*\}\s*let hash;[\s\S]*method: 'eth_sendTransaction'/);
    assert.doesNotMatch(send, /transaction\.(?:gasPrice|maxFeePerGas|maxPriorityFeePerGas)\s*=/);
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
    const composition = fs.readFileSync(path.join(__dirname, 'ui/createZkapiUi.js'), 'utf8');
    const runtime = fs.readFileSync(path.join(__dirname, 'services/zkapiChatRuntimeCore.mjs'), 'utf8');
    const sidebar = fs.readFileSync(path.join(__dirname, '../oa-chat/chat/components/Sidebar.js'), 'utf8');
    const panel = fs.readFileSync(path.join(__dirname, 'components/RightPanel.js'), 'utf8');
    const experience = fs.readFileSync(path.join(__dirname, 'components/ZkapiStateExperience.js'), 'utf8');
    const uxState = fs.readFileSync(path.join(__dirname, 'services/zkapiUxState.mjs'), 'utf8');
    const upstreamPanel = fs.readFileSync(path.join(__dirname, '../oa-chat/chat/components/RightPanel.js'), 'utf8');
    const logRenderer = fs.readFileSync(path.join(__dirname, '../oa-chat/chat/services/networkLogRenderer.js'), 'utf8');
    assert.match(composition, /status\.id = 'zkapi-composer-status'/);
    assert.match(runtime, /queuedSessions\.has\(session\?\.id\)/);
    assert.match(runtime, /label: 'Queued'/);
    assert.match(runtime, /label: 'Finishing'/);
    assert.match(sidebar, /presentation\?\.getSessionStatus\?\.\(session\)/);
    assert.match(composition, /getSessionStatus: session => runtime\.getSessionStatus\?\.\(session\)/);
    assert.match(panel, /renderZkapiPanelExperience/);
    assert.match(panel, /Closing previous chat key/);
    assert.match(experience, /renderZkapiComposerStatus/);
    assert.match(uxState, /Finishing previous chat/);
    assert.match(uxState, /Message queued/);
    assert.match(upstreamPanel, /getMissingApiKeyStatus/);
    assert.match(logRenderer, /return message \|\| 'Local operation completed'/);
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
    assert.match(modal, /const editingDeposit = this\.view === 'balance'[\s\S]*document\.activeElement\?\.id === 'zkapi-deposit-amount'/);
    assert.match(modal, /if \(this\.isOpen && !this\.busy && !editingDeposit\) this\.render\(\)/);
    assert.match(modal, /this\.depositAmount = depositInput\.value/);
});

test('only a never-submitted prepared deposit can be replaced after cancellation', () => {
    const runtime = fs.readFileSync(path.join(__dirname, 'services/browserWalletRuntime.js'), 'utf8');
    assert.match(runtime, /pending\.phase !== 'prepared' \|\| pending\.submissionId[\s\S]*pending\.transactionHash \|\| pending\.transactionHashes\?\.length/);
    assert.match(runtime, /await this\.commit\(\{ \.\.\.this\.runtime, pendingDeposit: null \}\)/);
    assert.match(runtime, /A previous deposit may already be in MetaMask\. Recover it before changing the amount/);
});

test('browser deposits refresh an unsigned Merkle path after token approval', () => {
    const runtime = fs.readFileSync(path.join(__dirname, 'services/browserWalletRuntime.js'), 'utf8');
    const client = fs.readFileSync(path.join(__dirname, 'services/zkapiClient.js'), 'utf8');
    const refresh = sourceMethodAt(runtime, 'async refreshPendingDeposit(');
    assert.match(refresh, /async refreshPendingDeposit\(amount, expectedActiveRoot = null\)/);
    assert.match(refresh, /const refreshed = \{[\s\S]*\.\.\.pending,[\s\S]*next_note_id: path\.note_id,[\s\S]*active_root: path\.active_root,[\s\S]*zero_path: path\.siblings/);
    assert.doesNotMatch(refresh, /secret:/);
    assert.match(client, /await browserWalletRuntime\.refreshPendingDeposit\([\s\S]*Number\(amount\),[\s\S]*expectedActiveRoot/);
    assert.match(client, /const attempts = this\.browserMode \? 3 : 1/);
    assert.match(client, /error\?\.code !== 'stale_root'/);
});
