import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sdkRoot = path.dirname(fileURLToPath(import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** Read and verify the package's public artifacts without any source submodule. */
export async function verifyBrowserSdkAssets() {
    const manifest = JSON.parse(await fs.readFile(path.join(sdkRoot, 'assets/manifest.json'), 'utf8'));
    for (const [relative, expected] of Object.entries(manifest.files)) {
        const resolved = path.resolve(sdkRoot, relative);
        if (!resolved.startsWith(`${sdkRoot}${path.sep}`)) throw new Error('Invalid SDK asset path.');
        if (digest(await fs.readFile(resolved)) !== expected) {
            throw new Error(`zkAPI SDK asset integrity check failed: ${relative}.`);
        }
    }
    return manifest;
}

/**
 * Publish one deployment's immutable proof assets beneath the host's app route.
 * The host supplies its esbuild `build` function; esbuild is not a runtime SDK
 * dependency. No network, private credentials, Rust, or submodules are required.
 */
export async function buildBrowserSdkAssets({ outDir, network = 'sepolia', publicPath = '/zkapi/', build } = {}) {
    if (!['sepolia', 'mainnet'].includes(network)) throw new Error('Network must be sepolia or mainnet.');
    if (!outDir || typeof build !== 'function') throw new TypeError('outDir and an esbuild build function are required.');
    if (!/^\/(?!\/)[^?#]*\/$/.test(publicPath) || publicPath.split('/').includes('..')) {
        throw new TypeError('publicPath must be an absolute same-origin directory path ending with /.');
    }
    const directory = path.resolve(outDir);
    if (directory === path.parse(directory).root || directory === sdkRoot || sdkRoot.startsWith(`${directory}${path.sep}`)
        || directory.startsWith(`${sdkRoot}${path.sep}`)) {
        throw new Error('SDK build output must not overwrite its package source.');
    }
    const provenance = await verifyBrowserSdkAssets();
    const config = JSON.parse(await fs.readFile(path.join(sdkRoot, `assets/config/${network}.json`), 'utf8'));
    const files = {};
    const write = async (relative, bytes) => {
        const destination = path.join(directory, relative);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, bytes);
        files[relative] = digest(bytes);
    };
    for (const kind of ['request', 'withdrawal']) {
        const bytes = await fs.readFile(path.join(sdkRoot, `assets/proofs/${kind}.pk`));
        if (digest(bytes) !== config.trusted_deployment?.[`${kind}_proving_key_sha256`]) {
            throw new Error(`${kind} proving key does not match the ${network} deployment pins.`);
        }
        await write(`proofs/${kind}.pk`, bytes);
    }
    await write('wasm/zkapi_browser_bg.wasm', await fs.readFile(path.join(sdkRoot, 'wasm/zkapi_browser_bg.wasm')));
    await write('browser-config.json', `${JSON.stringify(config, null, 2)}\n`);
    const workerFile = path.join(directory, 'assets/zkapiWasmWorker.js');
    await build({
        entryPoints: [path.join(sdkRoot, 'services/zkapiWasmWorker.js')], outfile: workerFile,
        bundle: true, format: 'esm', platform: 'browser', target: ['es2020'], minify: true, logLevel: 'warning'
    });
    files['assets/zkapiWasmWorker.js'] = digest(await fs.readFile(workerFile));
    const manifest = { schema: 1, network, protocolRevision: provenance.protocolRevision, files: { ...files } };
    await write('sdk-assets.json', `${JSON.stringify(manifest, null, 2)}\n`);
    return {
        directory, config, manifest, files,
        configUrl: `${publicPath}browser-config.json`, workerUrl: `${publicPath}assets/zkapiWasmWorker.js`
    };
}
