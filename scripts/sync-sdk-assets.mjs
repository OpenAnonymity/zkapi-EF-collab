import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBrowserSdkAssets } from '../sdk/build.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv.includes('--check')) {
    await verifyBrowserSdkAssets();
    console.log('SDK public artifact hashes verified.');
} else {
    const manifestFile = path.join(root, 'sdk/assets/manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    const protocolRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.join(root, 'protocol'), encoding: 'utf8' }).trim();
    for (const network of ['sepolia', 'mainnet']) {
        const config = JSON.parse(await fs.readFile(path.join(root, `sdk/assets/config/${network}.json`), 'utf8'));
        for (const kind of ['request', 'withdrawal']) {
            const bytes = await fs.readFile(path.join(root, `protocol/setup/v2/${kind}.pk`));
            const hash = createHash('sha256').update(bytes).digest('hex');
            if (hash !== config.trusted_deployment?.[`${kind}_proving_key_sha256`]) {
                throw new Error(`${kind} proof key differs from the ${network} deployment pin; no asset manifest was updated.`);
            }
        }
    }
    for (const kind of ['request', 'withdrawal']) {
        await fs.copyFile(path.join(root, `protocol/setup/v2/${kind}.pk`), path.join(root, `sdk/assets/proofs/${kind}.pk`));
    }
    for (const relative of Object.keys(manifest.files)) {
        manifest.files[relative] = createHash('sha256').update(await fs.readFile(path.join(root, 'sdk', relative))).digest('hex');
    }
    manifest.protocolRevision = protocolRevision;
    await fs.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log('Updated SDK artifact provenance; review and commit the generated changes.');
}
