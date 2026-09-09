import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import test from 'node:test';
const __dirname = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const root = __dirname;

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
        sha256(path.join(root, 'assets/proofs/request.pk')),
        'faa0e68954ade5e9709fa74baca3380cf0ff0d325ff06742385f33036123928e'
    );
    assert.equal(
        sha256(path.join(root, 'assets/proofs/withdrawal.pk')),
        '92a90139c87ae0e331fddc92a36e231047e1b4ae95474521d9a75f9b5a7bd0ab'
    );
});

test('browser config defaults to the public Sepolia deployment', () => {
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'assets/config/sepolia.json'), 'utf8'));
    assert.equal(config.deployment_manifest_url, 'https://d33l4w2z2nh4cg.cloudfront.net/config.json');
    assert.deepEqual(config.allowed_deployment_manifest_urls, [config.deployment_manifest_url]);
    assert.equal(config.trusted_deployment.chain_id, 11155111);
    assert.equal(config.trusted_deployment.contract_address.toLowerCase(), '0x590df9abbfb21074016daa486c771ae0af729ee2');
    assert.equal(config.trusted_deployment.request_proving_key_sha256, sha256(path.join(root, 'assets/proofs/request.pk')));
    assert.equal(config.trusted_deployment.withdrawal_proving_key_sha256, sha256(path.join(root, 'assets/proofs/withdrawal.pk')));
    assert.equal(config.proving_keys_base_url, './proofs/');
    assert.equal(config.deployment_api_proxy_path, '/zkapi-deployment/');
    assert.equal(config.billing_token_symbol, 'ZKAPI');
    assert.equal(config.billing_token_decimals, 6);
    assert.equal(config.require_oa_key_source, true);
    assert.equal(config.openrouter_requests_per_key, undefined);
});

test('mainnet browser config pins real Ethereum USDC and the deployed zkAPI server', () => {
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'assets/config/mainnet.json'), 'utf8'));
    assert.equal(config.deployment_manifest_url, 'https://d27v1dvkaxfc09.cloudfront.net/config.json');
    assert.deepEqual(config.allowed_deployment_manifest_urls, [config.deployment_manifest_url]);
    assert.equal(config.trusted_deployment.deployment_id, 'zkapi-ef-mainnet-groth16-v2-20260812');
    assert.equal(config.trusted_deployment.chain_id, 1);
    assert.equal(config.trusted_deployment.contract_address.toLowerCase(), '0xef88012d1a7f9d44e5f5afb8bc5e611dc3283709');
    assert.equal(config.trusted_deployment.billing_token_address.toLowerCase(), '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
    assert.equal(config.trusted_deployment.protocol_server_url, 'https://d27v1dvkaxfc09.cloudfront.net');
    assert.equal(config.trusted_deployment.indexer_url, 'https://d27v1dvkaxfc09.cloudfront.net');
    assert.equal(config.trusted_deployment.request_proving_key_sha256, sha256(path.join(root, 'assets/proofs/request.pk')));
    assert.equal(config.trusted_deployment.withdrawal_proving_key_sha256, sha256(path.join(root, 'assets/proofs/withdrawal.pk')));
    assert.equal(config.suggested_deposit_amount, 2_000_000);
    assert.equal(config.billing_token_symbol, 'USDC');
    assert.equal(config.billing_token_decimals, 6);
    assert.equal(config.require_oa_key_source, true);
});

test('browser chat leases prove only published model budgets without changing the deployment minimum', async () => {
    const compat = await import(pathToFileURL(path.join(__dirname, 'services/zkapiRequestCompat.mjs')));
    const sepolia = JSON.parse(fs.readFileSync(path.join(__dirname, 'assets/config/sepolia.json'), 'utf8'));
    const mainnet = JSON.parse(fs.readFileSync(path.join(__dirname, 'assets/config/mainnet.json'), 'utf8'));

    assert.equal(sepolia.trusted_deployment.request_charge_cap, 50_000);
    assert.equal(mainnet.trusted_deployment.request_charge_cap, 50_000);
    assert.deepEqual(compat.CHAT_SPENDING_TIER_USD, [1, 2, 3, 4.5, 6]);
    assert.equal(compat.selectLeaseSpendingLimitCredits(1_000_000, 50_000), 1_000_000);
    assert.equal(compat.selectLeaseSpendingLimitCredits(2_000_000, 50_000), 1_000_000);
    assert.equal(compat.selectLeaseSpendingLimitCredits(100_000_000, 50_000), 1_000_000);
    for (const dollars of compat.CHAT_SPENDING_TIER_USD) {
        assert.equal(compat.selectLeaseSpendingLimitCredits(100_000_000, 50_000, 1_000_000, dollars), dollars * 1_000_000);
        assert.throws(() => compat.selectLeaseSpendingLimitCredits(dollars * 1_000_000 - 1, 50_000, 1_000_000, dollars), error => error.required_credits === dollars * 1_000_000);
    }
    assert.throws(() => compat.selectLeaseSpendingLimitCredits(100_000_000, 50_000, 1_000_000, 1.234567), /budget configuration/);
});

test('browser chat leases give actionable guidance below the selected model budget', async () => {
    const compat = await import(pathToFileURL(path.join(__dirname, 'services/zkapiRequestCompat.mjs')));

    assert.throws(
        () => compat.selectLeaseSpendingLimitCredits(999_999, 50_000),
        error => {
            assert.equal(error.code, 'insufficient_chat_balance');
            assert.equal(error.required_credits, 1_000_000);
            assert.match(error.message, /lower-cap model/i);
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
