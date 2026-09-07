import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { DEFAULT_PRODUCTION_ORG_ORIGIN, normalizePublicOrigin } from '../oa-chat/scripts/buildConfig.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROPOSALS = new Set(['quiet', 'guided', 'activity', 'receipt', 'relay', 'ambient', 'capsule']);
const STATIC_DIRECTORIES = ['fonts', 'img', 'vendor'];
const STATIC_FILES = ['styles.css', 'tailwind.generated.css', 'favicon.svg'];

export function validateOutputDirectory(value, repoRoot = REPO_ROOT) {
    const resolved = path.resolve(value);
    const forbidden = [path.parse(resolved).root, os.homedir(), repoRoot];
    const sourceDirectories = ['oa-chat', 'funding-page', 'protocol', 'scripts', 'crates', '.git']
        .map(directory => path.join(repoRoot, directory));
    if (forbidden.includes(resolved) || repoRoot.startsWith(`${resolved}${path.sep}`)
        || sourceDirectories.some(directory => resolved === directory || resolved.startsWith(`${directory}${path.sep}`))) {
        throw new Error(`Refusing to use a source or broad directory as build output: ${resolved}`);
    }
    return resolved;
}

export function isPublishableAsset(relativePath) {
    const parts = relativePath.split(/[\\/]/);
    return parts.every(part => !part.startsWith('.') && part !== 'node_modules' && part !== 'test' && part !== 'tests')
        && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relativePath)
        && !/\.(?:map|key|pem|sqlite|db)$/.test(relativePath);
}

async function copyPublicDirectory(source, destination) {
    await fs.mkdir(destination, { recursive: true });
    const entries = await fs.readdir(source, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!isPublishableAsset(entry.name)) continue;
        const sourcePath = path.join(source, entry.name);
        const destinationPath = path.join(destination, entry.name);
        // Static runtime assets must be explicit files, never symlinks into a source tree.
        if (entry.isDirectory()) await copyPublicDirectory(sourcePath, destinationPath);
        else if (entry.isFile()) await fs.copyFile(sourcePath, destinationPath);
    }
}

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

async function listFiles(root, directory = root) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) files.push(...await listFiles(root, absolute));
        else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join('/'));
    }
    return files;
}

async function pinnedRevisions(repoRoot) {
    const lock = JSON.parse(await fs.readFile(path.join(repoRoot, 'browser-sources.lock.json'), 'utf8'));
    for (const directory of ['oa-chat', 'protocol']) {
        if (!/^[0-9a-f]{40}$/.test(lock[directory] || '')) throw new Error(`Missing pinned ${directory} revision in browser-sources.lock.json.`);
        // Uploaded source archives have no .git. In a checkout, additionally
        // reject stale version metadata rather than label a different revision.
        const gitPresent = await fs.lstat(path.join(repoRoot, directory, '.git')).then(() => true, () => false);
        if (gitPresent) {
            const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.join(repoRoot, directory), encoding: 'utf8' }).trim();
            if (actual !== lock[directory]) throw new Error(`${directory} differs from browser-sources.lock.json. Run npm run lock:sources after deliberately updating the pinned submodule.`);
        }
    }
    return lock;
}

export function composeHtml(source, { app, prelude, css, oaCommit, oaOrgOrigin = DEFAULT_PRODUCTION_ORG_ORIGIN }) {
    let html = source.replace(/<base\s+href="[^"]*"\s*\/?\s*>/, '<base href="/funding/">');
    if (!html.includes('<base href="/funding/">')) throw new Error('OA shell is missing its base URL.');
    // Never contact the production org just to warm DNS in a staging build.
    html = html.replace(
        /<link\s+rel="dns-prefetch"\s+href="https:\/\/org\.openanonymity\.ai"\s*>/g,
        `<link rel="dns-prefetch" href="${oaOrgOrigin}">`
    );
    for (const [name, bundle] of [['APP', app], ['PRELUDE', prelude]]) {
        const block = new RegExp(`<!--\\s*BUNDLE:${name}\\s*-->[\\s\\S]*?<!--\\s*\\/BUNDLE:${name}\\s*-->`);
        if (!block.test(html)) throw new Error(`OA shell is missing BUNDLE:${name}.`);
        html = html.replace(block, `<!-- BUNDLE:${name} -->\n    <script type="module" src="${bundle}"></script>\n    <!-- /BUNDLE:${name} -->`);
    }
    // Compose only the generated shell: source files in the OA submodule are never patched.
    const styles = ['zkapi.css', ...(css ? [css] : [])]
        .map(href => `    <link rel="stylesheet" href="${href}">`).join('\n');
    return html.replace('</head>', `${styles}\n    <script src="wallet.js"></script>\n    <meta name="oa-chat-revision" content="${oaCommit}">\n</head>`);
}

export async function composeBrowserClient(options = {}) {
    const repoRoot = options.repoRoot || REPO_ROOT;
    const outputRoot = validateOutputDirectory(options.outDir || path.join(repoRoot, 'dist/browser'), repoRoot);
    const network = options.network || 'sepolia';
    const proposal = options.proposal || null;
    // The org is a build input, independent of the pinned zkAPI deployment.
    // Deliberately do not read environment or runtime endpoint overrides.
    const oaOrgOrigin = normalizePublicOrigin(options.oaOrgOrigin, '--oa-org-origin') || DEFAULT_PRODUCTION_ORG_ORIGIN;
    if (!['sepolia', 'mainnet'].includes(network)) throw new Error('Network must be sepolia or mainnet.');
    if (proposal && !PROPOSALS.has(proposal)) throw new Error('Unknown UX proposal.');
    const oaRoot = path.join(repoRoot, 'oa-chat');
    const sourceRoot = path.join(repoRoot, 'funding-page');
    const entry = path.join(sourceRoot, 'zkapi-entry.js');
    const configPath = path.join(sourceRoot, network === 'mainnet' ? 'browser-config.mainnet.json' : 'browser-config.json');
    const required = [entry, path.join(oaRoot, 'chat/publicApi.js'), path.join(oaRoot, 'nanomem/browser.js'),
        path.join(sourceRoot, 'wasm/zkapi_browser_bg.wasm'), configPath];
    for (const file of required) {
        try { await fs.access(file); }
        catch { throw new Error(`Required build input is missing: ${file}. Initialize pinned submodules with git submodule update --init --recursive.`); }
    }
    const entrySource = await fs.readFile(entry, 'utf8');
    if (!entrySource.includes('oa-chat/chat/publicApi.js')) {
        throw new Error('The zkAPI entry must compose OA through oa-chat/chat/publicApi.js.');
    }
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    if (proposal) config.ux_proposal = proposal;
    const revisions = await pinnedRevisions(repoRoot);
    const oaCommit = revisions['oa-chat'];
    await fs.mkdir(outputRoot, { recursive: true });
    const stage = await fs.mkdtemp(path.join(outputRoot, '.zkapi-funding-build-'));
    try {
        for (const directory of STATIC_DIRECTORIES) {
            await copyPublicDirectory(path.join(oaRoot, 'chat', directory), path.join(stage, directory));
        }
        for (const file of STATIC_FILES) await fs.copyFile(path.join(oaRoot, 'chat', file), path.join(stage, file));
        for (const file of ['zkapi.css', 'wallet.js']) await fs.copyFile(path.join(sourceRoot, file), path.join(stage, file));
        await fs.copyFile(path.join(oaRoot, 'LICENSE'), path.join(stage, 'OA_CHAT_LICENSE'));
        await fs.mkdir(path.join(stage, 'wasm'));
        await fs.copyFile(path.join(sourceRoot, 'wasm/zkapi_browser_bg.wasm'), path.join(stage, 'wasm/zkapi_browser_bg.wasm'));
        await fs.mkdir(path.join(stage, 'proofs'));
        for (const kind of ['request', 'withdrawal']) {
            const bytes = await fs.readFile(path.join(repoRoot, 'protocol/setup/v2', `${kind}.pk`));
            const expected = config.trusted_deployment?.[`${kind}_proving_key_sha256`];
            if (!expected || sha256(bytes) !== expected) throw new Error(`${kind} proving key does not match the pinned ${network} deployment.`);
            await fs.writeFile(path.join(stage, 'proofs', `${kind}.pk`), bytes);
        }
        await fs.writeFile(path.join(stage, 'browser-config.json'), `${JSON.stringify(config, null, 2)}\n`);

        const result = await build({
            absWorkingDir: repoRoot,
            entryPoints: { app: entry, prelude: path.join(oaRoot, 'chat/prelude.js') },
            bundle: true, splitting: true, format: 'esm', platform: 'browser', target: ['es2020'],
            outdir: path.join(stage, 'assets'), entryNames: '[name]-[hash]', chunkNames: 'chunk-[hash]',
            assetNames: 'asset-[hash]', minify: true, metafile: true, logLevel: 'warning',
            loader: { '.svg': 'file', '.png': 'file', '.jpg': 'file', '.woff': 'file', '.woff2': 'file' },
            define: {
                __DEV__: 'false',
                __OA_ORG_SAME_ORIGIN__: 'false',
                __OA_PRODUCTION_ORG_ORIGIN__: JSON.stringify(oaOrgOrigin)
            }
        });
        // new Worker(new URL('./zkapiWasmWorker.js', import.meta.url)) resolves from any
        // app/chunk in assets/. Worker-relative ../wasm/ and ../browser-config.json
        // retain the same /funding/ paths used by the unbundled wallet runtime.
        await build({
            absWorkingDir: repoRoot, entryPoints: [path.join(sourceRoot, 'services/zkapiWasmWorker.js')],
            bundle: true, format: 'esm', platform: 'browser', target: ['es2020'], minify: true,
            outfile: path.join(stage, 'assets/zkapiWasmWorker.js'), logLevel: 'warning'
        });
        const inputs = Object.keys(result.metafile.inputs).sort();
        if (inputs.includes('funding-page/app.js')) throw new Error('The composed build must not include the old vendored ChatApp.');
        const outputFor = input => {
            const item = Object.entries(result.metafile.outputs).find(([, info]) => info.entryPoint && path.resolve(repoRoot, info.entryPoint) === input);
            if (!item) throw new Error(`Missing composed entry output: ${input}`);
            return { filename: path.relative(stage, path.resolve(repoRoot, item[0])).split(path.sep).join('/'), info: item[1] };
        };
        const app = outputFor(entry);
        const prelude = outputFor(path.join(oaRoot, 'chat/prelude.js'));
        const css = app.info.cssBundle ? path.relative(stage, path.resolve(repoRoot, app.info.cssBundle)).split(path.sep).join('/') : null;
        const html = composeHtml(await fs.readFile(path.join(oaRoot, 'chat/index.html'), 'utf8'), {
            app: app.filename, prelude: prelude.filename, css, oaCommit, oaOrgOrigin
        });
        await fs.writeFile(path.join(stage, 'index.html'), html);
        // Preserve the daemon's legacy asset endpoint without serving another app implementation.
        await fs.writeFile(path.join(stage, 'app.js'), `import './${app.filename}';\n`);
        const files = {};
        for (const file of await listFiles(stage)) files[file] = sha256(await fs.readFile(path.join(stage, file)));
        const manifest = {
            schema: 1, builder: 'oa-zkapi-composition', network, proposal, oaOrgOrigin,
            hash: sha256(JSON.stringify(files)),
            oaChatRevision: oaCommit, protocolRevision: revisions.protocol,
            app: app.filename, prelude: prelude.filename,
            sourceInputs: inputs, files
        };
        await fs.writeFile(path.join(stage, 'build.json'), `${JSON.stringify(manifest, null, 2)}\n`);
        // Replace only the generated funding subtree, never the caller's whole output directory.
        const destination = path.join(outputRoot, 'funding');
        await fs.rm(destination, { recursive: true, force: true });
        await fs.rename(stage, destination);
        return { directory: destination, manifest };
    } finally {
        await fs.rm(stage, { recursive: true, force: true });
    }
}

function parseArguments(args) {
    const options = {};
    const names = { '--out-dir': 'outDir', '--network': 'network', '--proposal': 'proposal', '--oa-org-origin': 'oaOrgOrigin' };
    for (let index = 0; index < args.length; index += 2) {
        const name = names[args[index]];
        if (!name || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Unknown or incomplete build argument: ${args[index]}`);
        options[name] = args[index + 1];
    }
    return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    composeBrowserClient(parseArguments(process.argv.slice(2)))
        .then(({ directory, manifest }) => console.log(`Composed ${manifest.network} OA Chat at ${directory} (${manifest.hash.slice(0, 12)})`))
        .catch(error => { console.error(`[compose] ${error.message}`); process.exitCode = 1; });
}
