#!/usr/bin/env node
// Local-only fixture host. Never use this server or its injected HTML in a deployment.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installWithdrawalRecoveryFixture } from './browser-withdrawal-recovery-fixture.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(repo, process.argv[2] || 'dist/browser');
const port = Number(process.argv[3] || 8878);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid localhost port.');
const config = JSON.parse(await fs.readFile(path.join(root, 'funding/browser-config.json'), 'utf8'));
const bootstrap = `(${installWithdrawalRecoveryFixture.toString()})(${JSON.stringify(config)});`;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-src 'none'");
    if (url.pathname === '/__fixture__/bootstrap.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bootstrap); return; }
    if (url.pathname === '/') { response.writeHead(302, { Location: '/funding/?zkapiMode=browser' }); response.end(); return; }
    const filename = path.resolve(root, `.${decodeURIComponent(url.pathname)}`, url.pathname.endsWith('/') ? 'index.html' : '');
    if (!filename.startsWith(`${root}${path.sep}`)) { response.writeHead(403); response.end(); return; }
    try {
        let body = await fs.readFile(filename);
        if (filename.endsWith('/funding/index.html')) body = Buffer.from(body.toString().replace('<head>', '<head><script src="/__fixture__/bootstrap.js"></script>'));
        response.setHeader('Content-Type', types[path.extname(filename)] || 'application/octet-stream');
        response.end(body);
    } catch { response.writeHead(404); response.end('Fixture host: not found'); }
});
server.listen(port, '127.0.0.1', () => console.log(`Withdrawal fixture only: http://127.0.0.1:${port}/funding/?zkapiMode=browser`));
