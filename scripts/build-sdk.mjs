import path from 'node:path';
import { build } from 'esbuild';
import { buildBrowserSdkAssets } from '../sdk/build.mjs';

const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : null;
const network = option('--network') || 'sepolia';
const outDir = path.resolve(option('--out-dir') || `dist/sdk-${network}`);
const result = await buildBrowserSdkAssets({ network, outDir, build });
console.log(`Built ${network} zkAPI SDK assets: ${result.directory}`);
