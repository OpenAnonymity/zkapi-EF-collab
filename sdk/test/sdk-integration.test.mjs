import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { build } from 'esbuild';
import { buildBrowserSdkAssets, verifyBrowserSdkAssets } from '../build.mjs';
import { configureBrowserSdk, browserSdkOptions, browserSdkTransport, beginBrowserSdkInitialization } from '../configure.js';
import { BrowserWalletRuntime } from '../services/browserWalletRuntime.js';

test('SDK imports without a host UI, codec global, wallet connection or network request', async () => {
    assert.equal(globalThis.zkapiWallet, undefined);
    const sdk = await import('../index.js');
    assert.equal(typeof sdk.zkapiClient.init, 'function');
    assert.equal(sdk.zkapiClient.initialized, false);
    assert.equal(sdk.browserWalletRuntime.worker, null);
    assert.deepEqual(sdk.CHAT_SPENDING_TIER_USD, [1, 2, 3, 4.5, 6]);
});

test('transport omits account credentials for both direct and opt-in host proxy requests', async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (...args) => { calls.push(args); return new Response('{}'); };
    try {
        const init = { method: 'POST', credentials: 'include', body: 'public-proof', headers: { 'x-test': 'value' } };
        await browserSdkTransport('https://service.example/leases', init, { preferProxy: true });
        assert.equal(calls[0][1].credentials, 'omit');
        assert.equal(init.credentials, 'include');
        const hints = { preferProxy: true };
        configureBrowserSdk({ transport: async (...args) => { calls.push(args); return new Response('{}'); } });
        await browserSdkTransport('https://service.example/leases', init, hints);
        assert.deepEqual(calls[1][1], { ...init, credentials: 'omit' });
        assert.equal(calls[1][1].body, init.body);
        assert.equal(calls[1][1].headers, init.headers);
        assert.equal(calls[1][2], hints);
    } finally {
        globalThis.fetch = originalFetch;
        configureBrowserSdk({ transport: null });
    }
});

test('optional daemon requests retain their explicit session header without host account cookies', async () => {
    const { ZkapiClient, SESSION_HEADER } = await import('../index.js');
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (...args) => { calls.push(args); return new Response('{"ok":true}'); };
    try {
        const client = new ZkapiClient();
        const signal = new AbortController().signal;
        assert.deepEqual(await client.apiJson('/zkapi/v1/openrouter/leases', {
            method: 'POST', body: '{"spending_limit_usd":2}', signal,
            headers: { [SESSION_HEADER]: 'same-chat' }, credentials: 'include'
        }), { ok: true });
        assert.equal(calls[0][1].credentials, 'omit');
        assert.equal(calls[0][1].headers[SESSION_HEADER], 'same-chat');
        assert.equal(calls[0][1].headers['content-type'], 'application/json');
        assert.equal(calls[0][1].signal, signal);
        assert.equal(calls[0][1].body, '{"spending_limit_usd":2}');
    } finally { globalThis.fetch = originalFetch; }
});

test('host configuration resolves explicit paths and retains trusted same-origin proxy routing', async () => {
    const originalLocation = globalThis.location;
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.location = { href: 'https://host.example/chat/', origin: 'https://host.example' };
    globalThis.fetch = async (...args) => { calls.push(args); return new Response('{}'); };
    try {
        configureBrowserSdk({ configUrl: '/zkapi/browser-config.json', workerUrl: '/zkapi/assets/zkapiWasmWorker.js' });
        const runtime = new BrowserWalletRuntime();
        await runtime.loadBrowserConfig();
        assert.equal(calls[0][0], 'https://host.example/zkapi/browser-config.json');
        assert.equal(calls[0][1].credentials, 'omit');
        const config = JSON.parse(await fs.readFile(new URL('../assets/config/sepolia.json', import.meta.url), 'utf8'));
        runtime.browserConfig = config;
        await runtime.remoteFetch(config.trusted_deployment.protocol_server_url + '/v2/requests', { method: 'POST', body: '{"proof":"private-proof"}', credentials: 'include' });
        assert.equal(calls[1][0], 'https://host.example/zkapi-deployment/v2/requests');
        assert.equal(calls[1][1].credentials, 'omit');
        assert.equal(calls[1][1].body, '{"proof":"private-proof"}');
        await runtime.directJson(config.deployment_manifest_url);
        assert.equal(calls[2][1].credentials, 'omit');
        globalThis.fetch = async (...args) => { calls.push(args); return calls.length === 4 ? new Response('', {status:404}) : new Response('{}'); };
        await runtime.remoteFetch(config.trusted_deployment.protocol_server_url + '/v2/requests', { credentials: 'include', body: 'proof', method: 'POST' });
        assert.equal(calls[3][1].credentials, 'omit');
        assert.equal(calls[4][1].credentials, 'omit');
        assert.equal(browserSdkOptions().workerUrl, 'https://host.example/zkapi/assets/zkapiWasmWorker.js');
        const manifest = { ...config.trusted_deployment, privacy_mode: { openrouter_inference_base: 'https://openrouter.ai/api/v1' } };
        assert.equal(runtime.buildClientConfig(manifest, config).proving_keys.request.url, 'https://host.example/zkapi/proofs/request.pk');
    } finally {
        globalThis.location = originalLocation;
        globalThis.fetch = originalFetch;
    }
});

test('packaged proof assets and host-built worker are independent of source submodules', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'zkapi-sdk-assets-'));
    try {
        const pinned = await verifyBrowserSdkAssets();
        for (const network of ['sepolia', 'mainnet']) {
            const result = await buildBrowserSdkAssets({ outDir: path.join(temp, network), network, publicPath: '/chat/zkapi/', build });
            assert.equal(result.configUrl, '/chat/zkapi/browser-config.json');
            assert.equal(result.workerUrl, '/chat/zkapi/assets/zkapiWasmWorker.js');
            assert.equal(result.config.trusted_deployment.chain_id, network === 'mainnet' ? 1 : 11155111);
            assert.equal(result.files['proofs/request.pk'], pinned.files['assets/proofs/request.pk']);
            assert.equal(result.files['wasm/zkapi_browser_bg.wasm'], pinned.files['wasm/zkapi_browser_bg.wasm']);
            const worker = await fs.readFile(path.join(result.directory, 'assets/zkapiWasmWorker.js'), 'utf8');
            assert.match(worker, /\.\.\/wasm\/zkapi_browser_bg\.wasm/);
            assert.doesNotMatch(worker, /oa-chat|funding-page|networkProxy/);
        }
        await assert.rejects(buildBrowserSdkAssets({outDir: temp, network: 'invalid', build}), /Network/);
        await assert.rejects(buildBrowserSdkAssets({outDir: temp, publicPath: '//other.example/', build}), /same-origin/);
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('SDK rejects unsupported options and cannot change its trust/transport configuration after initialization begins', () => {
    assert.throws(() => configureBrowserSdk({ mode: 'invalid' }), /mode/);
    assert.throws(() => configureBrowserSdk({ transport: {} }), /transport/);
    assert.throws(() => configureBrowserSdk({ configUrl: 'https://user:secret@example.com/config' }), /credentials/);
    assert.throws(() => configureBrowserSdk({ ignoredOption: true }), /Unknown/);
    beginBrowserSdkInitialization();
    assert.throws(() => configureBrowserSdk({ configUrl: 'https://other.example/config' }), /before initializing/);
});
