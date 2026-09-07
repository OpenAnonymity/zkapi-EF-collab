import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { composeBrowserClient, composeHtml, isPublishableAsset, validateOutputDirectory } from './compose-browser-client.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const HTML = '<!doctype html><html><head><base href="/"><link href="styles.css" rel="stylesheet"><link rel="dns-prefetch" href="https://org.openanonymity.ai"></head><body><!-- BUNDLE:PRELUDE --><script type="module" src="prelude.js"></script><!-- /BUNDLE:PRELUDE --><!-- BUNDLE:APP --><script type="module" src="standalone.js"></script><!-- /BUNDLE:APP --></body></html>';

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zkapi-compose-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const files = {
        'oa-chat/chat/publicApi.js': "import { ORG_API_BASE, ORG_AUTH_ORIGIN, VERIFIER_URL } from './config.js'; export function createChatApp() { globalThis.composed = true; globalThis.oaEndpoints = { apiBase: ORG_API_BASE, authOrigin: ORG_AUTH_ORIGIN, verifier: VERIFIER_URL }; }",
        'oa-chat/chat/config.js': await fs.readFile(new URL('../oa-chat/chat/config.js', import.meta.url), 'utf8'),
        'oa-chat/chat/services/orgEndpoints.js': await fs.readFile(new URL('../oa-chat/chat/services/orgEndpoints.js', import.meta.url), 'utf8'),
        'oa-chat/chat/index.html': HTML,
        'oa-chat/chat/prelude.js': 'globalThis.prelude = true;',
        'oa-chat/chat/styles.css': ':root { color: black; }',
        'oa-chat/chat/tailwind.generated.css': '.hidden { display: none; }',
        'oa-chat/chat/favicon.svg': '<svg/>',
        'oa-chat/chat/fonts/fonts.css': '/* fonts */',
        'oa-chat/chat/img/provider.svg': '<svg/>',
        'oa-chat/chat/vendor/marked/marked.min.js': 'globalThis.marked = {};',
        'oa-chat/chat/vendor/.env': 'DO_NOT_PUBLISH',
        'oa-chat/chat/vendor/parser.test.js': 'DO_NOT_PUBLISH',
        'oa-chat/chat/vendor/parser.js.map': 'DO_NOT_PUBLISH',
        'oa-chat/LICENSE': 'MIT fixture license',
        'oa-chat/nanomem/browser.js': 'export {};',
        'funding-page/zkapi-entry.js': "import { createChatApp } from '../oa-chat/chat/publicApi.js'; createChatApp(); globalThis.workerUrl = new URL('./zkapiWasmWorker.js', import.meta.url); globalThis.configUrl = new URL('../browser-config.json', import.meta.url);",
        'funding-page/services/zkapiWasmWorker.js': "globalThis.wasmUrl = new URL('../wasm/zkapi_browser_bg.wasm', import.meta.url);",
        'funding-page/wasm/zkapi_browser_bg.wasm': '\0asm',
        'funding-page/zkapi.css': '.zkapi { color: blue; }',
        'funding-page/wallet.js': 'globalThis.zkapiWallet = {};',
        'funding-page/app.js': 'DO_NOT_PUBLISH_OLD_CHAT',
        'funding-page/old.test.mjs': 'DO_NOT_PUBLISH_TEST',
        'funding-page/.env': 'DO_NOT_PUBLISH_SECRET',
        'protocol/setup/v2/request.pk': 'request proof fixture',
        'protocol/setup/v2/withdrawal.pk': 'withdrawal proof fixture',
        'browser-sources.lock.json': JSON.stringify({ 'oa-chat': 'a'.repeat(40), protocol: 'b'.repeat(40) })
    };
    for (const [name, contents] of Object.entries(files)) {
        const destination = path.join(root, name);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, contents);
    }
    for (const network of ['mainnet', 'sepolia']) {
        const config = {
            billing_token_symbol: network === 'mainnet' ? 'USDC' : 'ZKAPI',
            proving_keys_base_url: './proofs/',
            trusted_deployment: {
                chain_id: network === 'mainnet' ? 1 : 11155111,
                request_proving_key_sha256: hash(files['protocol/setup/v2/request.pk']),
                withdrawal_proving_key_sha256: hash(files['protocol/setup/v2/withdrawal.pk'])
            }
        };
        await fs.writeFile(path.join(root, 'funding-page', network === 'mainnet' ? 'browser-config.mainnet.json' : 'browser-config.json'), JSON.stringify(config));
    }
    return root;
}

function readBundledEndpoints({ directory, manifest }) {
    const moduleUrl = pathToFileURL(path.join(directory, manifest.app)).href;
    const script = `
        globalThis.window = { location: { hostname: 'trial.example.org', origin: 'https://trial.example.org' } };
        globalThis.__OA_PRODUCTION_ORG_ORIGIN__ = 'https://untrusted.example.org';
        globalThis.__OA_ORG_SAME_ORIGIN__ = true;
        await import(${JSON.stringify(moduleUrl)});
        process.stdout.write(JSON.stringify(globalThis.oaEndpoints));
    `;
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }));
}

test('composition keeps OA source untouched and publishes only runtime assets', async t => {
    const root = await fixture(t);
    const before = await fs.readFile(path.join(root, 'oa-chat/chat/index.html'), 'utf8');
    const { directory, manifest } = await composeBrowserClient({ repoRoot: root, outDir: path.join(root, 'dist/browser') });
    assert.equal(await fs.readFile(path.join(root, 'oa-chat/chat/index.html'), 'utf8'), before);
    const html = await fs.readFile(path.join(directory, 'index.html'), 'utf8');
    assert.match(html, /<base href="\/funding\/">/);
    assert.match(html, /src="assets\/app-[A-Z0-9]+\.js"/);
    assert.match(html, /src="wallet\.js"/);
    assert.match(html, /href="zkapi\.css"/);
    assert.ok(manifest.sourceInputs.includes('oa-chat/chat/publicApi.js'));
    assert.ok(!manifest.sourceInputs.includes('funding-page/app.js'));
    assert.ok(manifest.files['assets/zkapiWasmWorker.js']);
    assert.ok(manifest.files['wasm/zkapi_browser_bg.wasm']);
    assert.ok(manifest.files['proofs/request.pk']);
    assert.ok(!Object.keys(manifest.files).some(file => /test|\.env|\.map$|components\/|services\//.test(file)));
    assert.match(await fs.readFile(path.join(directory, 'app.js'), 'utf8'), /import '\.\/assets\/app-/);
    for (const [name, digest] of Object.entries(manifest.files)) {
        assert.equal(hash(await fs.readFile(path.join(directory, name))), digest, name);
    }
});

test('identical source produces deterministic output across separate output directories', async t => {
    const root = await fixture(t);
    const first = await composeBrowserClient({ repoRoot: root, outDir: path.join(root, 'dist/first') });
    const second = await composeBrowserClient({ repoRoot: root, outDir: path.join(root, 'dist/second') });
    assert.deepEqual(first.manifest, second.manifest);
    assert.equal(first.manifest.hash.length, 64);
    assert.equal(first.manifest.oaChatRevision, 'a'.repeat(40));
    assert.equal(first.manifest.protocolRevision, 'b'.repeat(40));
    assert.equal(first.manifest.oaOrgOrigin, 'https://org.openanonymity.ai');
    assert.deepEqual(readBundledEndpoints(first), {
        apiBase: 'https://org.openanonymity.ai',
        authOrigin: 'https://org.openanonymity.ai',
        verifier: 'https://verifier2.openanonymity.ai'
    });
});

test('a pinned staging org changes account and ticket endpoints without changing either zkAPI deployment', async t => {
    const root = await fixture(t);
    const oaOrgOrigin = 'https://staging.example.org';
    for (const network of ['sepolia', 'mainnet']) {
        const originalConfig = await fs.readFile(path.join(root, 'funding-page', network === 'mainnet' ? 'browser-config.mainnet.json' : 'browser-config.json'), 'utf8');
        const result = await composeBrowserClient({ repoRoot: root, outDir: path.join(root, 'dist', network), network, oaOrgOrigin: `${oaOrgOrigin}/` });
        assert.equal(result.manifest.oaOrgOrigin, oaOrgOrigin);
        assert.equal(result.manifest.network, network);
        assert.deepEqual(readBundledEndpoints(result), {
            apiBase: oaOrgOrigin,
            authOrigin: oaOrgOrigin,
            verifier: 'https://verifier2.openanonymity.ai'
        });
        const html = await fs.readFile(path.join(result.directory, 'index.html'), 'utf8');
        assert.ok(html.includes(`<link rel="dns-prefetch" href="${oaOrgOrigin}">`));
        assert.ok(!html.includes('org.openanonymity.ai'));
        for (const name of Object.keys(result.manifest.files).filter(file => file.endsWith('.js'))) {
            assert.ok(!(await fs.readFile(path.join(result.directory, name), 'utf8')).includes('org.openanonymity.ai'), name);
        }
        assert.deepEqual(JSON.parse(await fs.readFile(path.join(result.directory, 'browser-config.json'), 'utf8')), JSON.parse(originalConfig));
        for (const kind of ['request', 'withdrawal']) {
            assert.equal(result.manifest.files[`proofs/${kind}.pk`], hash(await fs.readFile(path.join(root, 'protocol/setup/v2', `${kind}.pk`))));
        }
    }
    assert.equal(await fs.readFile(path.join(root, 'oa-chat/chat/index.html'), 'utf8'), HTML);
});

test('invalid org origins fail closed before replacing the last successful build', async t => {
    const root = await fixture(t);
    const options = { repoRoot: root, outDir: path.join(root, 'dist/browser') };
    const first = await composeBrowserClient(options);
    for (const oaOrgOrigin of [
        'http://staging.example.org', '//staging.example.org', 'javascript:alert(1)',
        'https://user:password@staging.example.org', 'https://staging.example.org/api',
        'https://staging.example.org?org=other', 'https://staging.example.org#other'
    ]) {
        await assert.rejects(composeBrowserClient({ ...options, oaOrgOrigin }), /--oa-org-origin/);
    }
    assert.equal(JSON.parse(await fs.readFile(path.join(first.directory, 'build.json'), 'utf8')).hash, first.manifest.hash);
});

test('mainnet and Sepolia compose the same app with isolated pinned configuration', async t => {
    const root = await fixture(t);
    const sepolia = await composeBrowserClient({ repoRoot: root, outDir: path.join(root, 'dist/sepolia'), proposal: 'quiet' });
    const mainnet = await composeBrowserClient({ repoRoot: root, outDir: path.join(root, 'dist/mainnet'), network: 'mainnet' });
    assert.equal(sepolia.manifest.files[sepolia.manifest.app], mainnet.manifest.files[mainnet.manifest.app]);
    assert.notEqual(sepolia.manifest.hash, mainnet.manifest.hash);
    const testConfig = JSON.parse(await fs.readFile(path.join(sepolia.directory, 'browser-config.json'), 'utf8'));
    const realConfig = JSON.parse(await fs.readFile(path.join(mainnet.directory, 'browser-config.json'), 'utf8'));
    assert.equal(testConfig.trusted_deployment.chain_id, 11155111);
    assert.equal(testConfig.ux_proposal, 'quiet');
    assert.equal(realConfig.trusted_deployment.chain_id, 1);
    assert.equal(realConfig.billing_token_symbol, 'USDC');
    assert.equal(realConfig.proving_keys_base_url, './proofs/');
});

test('config, proof and WASM worker URLs survive entry bundling', async t => {
    const root = await fixture(t);
    const { directory, manifest } = await composeBrowserClient({ repoRoot: root, outDir: path.join(root, 'dist/browser') });
    const origin = 'https://example.test/funding/';
    const appUrl = new URL(manifest.app, origin);
    const workerUrl = new URL('./zkapiWasmWorker.js', appUrl);
    const configUrl = new URL('../browser-config.json', appUrl);
    assert.equal(workerUrl.pathname, '/funding/assets/zkapiWasmWorker.js');
    assert.equal(configUrl.pathname, '/funding/browser-config.json');
    assert.equal(new URL('../wasm/zkapi_browser_bg.wasm', workerUrl).pathname, '/funding/wasm/zkapi_browser_bg.wasm');
    assert.equal(new URL('./proofs/request.pk', configUrl).pathname, '/funding/proofs/request.pk');
    assert.match(await fs.readFile(path.join(directory, manifest.app), 'utf8'), /import\.meta\.url/);
});

test('build fails closed on a mismatched proving key and preserves last good output', async t => {
    const root = await fixture(t);
    const options = { repoRoot: root, outDir: path.join(root, 'dist/browser') };
    const first = await composeBrowserClient(options);
    await fs.writeFile(path.join(root, 'protocol/setup/v2/request.pk'), 'wrong proof');
    await assert.rejects(composeBrowserClient(options), /request proving key does not match/);
    assert.equal(JSON.parse(await fs.readFile(path.join(first.directory, 'build.json'), 'utf8')).hash, first.manifest.hash);
});

test('production composition rejects the legacy ChatApp dependency', async t => {
    const root = await fixture(t);
    await fs.writeFile(path.join(root, 'funding-page/app.js'), 'globalThis.oldChat = true;');
    await fs.appendFile(path.join(root, 'funding-page/zkapi-entry.js'), "\nimport './app.js';");
    await assert.rejects(composeBrowserClient({ repoRoot: root, outDir: path.join(root, 'dist/browser') }), /old vendored ChatApp/);
});

test('asset filter excludes test, secret and source-map paths', () => {
    for (const name of ['.env', '.git/config', 'x.test.mjs', 'x.spec.js', 'x.js.map', 'secret.pem', 'tests/fixture.js', 'node_modules/x.js']) assert.equal(isPublishableAsset(name), false, name);
    for (const name of ['font.woff2', 'libcurl_full.js', 'LICENSE.md', 'proof.pk']) assert.equal(isPublishableAsset(name), true, name);
});

test('unsafe output roots and incompatible shared shells fail explicitly', () => {
    for (const directory of ['/', os.homedir(), '/tmp/fixture-repo', '/tmp/fixture-repo/oa-chat/dist', '/tmp/fixture-repo/funding-page']) {
        assert.throws(() => validateOutputDirectory(directory, '/tmp/fixture-repo'), /Refusing/);
    }
    assert.throws(() => composeHtml('<html><head></head></html>', {}), /base URL/);
    assert.throws(() => composeHtml('<base href="/">', {}), /BUNDLE:APP/);
});
