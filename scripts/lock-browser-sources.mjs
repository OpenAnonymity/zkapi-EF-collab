import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const revisions = {};
for (const directory of ['oa-chat', 'protocol']) {
    revisions[directory] = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: path.join(root, directory), encoding: 'utf8'
    }).trim();
}
await fs.writeFile(path.join(root, 'browser-sources.lock.json'), `${JSON.stringify(revisions, null, 2)}\n`);
console.log('Updated browser source pins; review and commit them with the submodule changes.');
