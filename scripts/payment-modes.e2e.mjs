#!/usr/bin/env node
/**
 * Payment-mode UI E2E with explicitly simulated external services.
 * Real: composed app/controller, mode runtime, IndexedDB, request construction,
 *       verified-access policy, SSE parsing, streaming UI, and reload.
 * Simulated: ticket issuance, verifier result, zkAPI funding/key leases, models,
 *            provider replies. This does NOT certify live cryptography/payment.
 *
 * npm run build:browser
 * npm run test:e2e [-- --url https://preview.example/funding/]
 * Requires installed Google Chrome, or CHROME_EXECUTABLE pointing to Chromium.
 *
 * A fresh, nonpersistent Chrome context is always used. No existing browser
 * wallet, ticket inventory, account, profile, or chat database is opened.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : null;
const output = path.resolve(value('--output') || path.join(repo, '.verify-run-payment-modes'));
const buildRoot = path.resolve(value('--build') || path.join(repo, 'dist/browser'));

async function serve() {
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
        '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
        '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
    const server = http.createServer(async (request, response) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        const filename = path.resolve(buildRoot, `.${decodeURIComponent(pathname)}`, pathname.endsWith('/') ? 'index.html' : '');
        if (!filename.startsWith(`${buildRoot}${path.sep}`)) { response.writeHead(403); response.end(); return; }
        try {
            const body = await fs.readFile(filename);
            response.setHeader('Content-Type', types[path.extname(filename)] || 'application/octet-stream');
            response.setHeader('Cache-Control', 'no-store');
            response.end(body);
        } catch { response.writeHead(404); response.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { server, url: `http://127.0.0.1:${server.address().port}/funding/` };
}

// Executed only inside the new automation context, after the composed app loads.
async function installFixture() {
    if (window.__PAYMENT_MODE_E2E_ISOLATED__ !== true || window.ethereum) {
        throw new Error('Payment fixture requires a fresh isolated browser without a wallet extension.');
    }
    const app = window.app;
    await app.ready;
    const client = window.zkapiClient;
    await client.init().catch(() => {});
    const fixture = window.paymentModesFixture = {
        requests: [], acquisitions: [], verifications: [], settlements: [], holdResponses: false,
        ticketCount: Number(localStorage.getItem('payment-e2e-ticket-count') || '100')
    };
    const models = ['openrouter/auto', 'openai/gpt-4o-mini', 'google/gemini-3.1-flash-lite-preview'].map(id => ({
        id, name: id === 'openrouter/auto' ? 'Auto Router' : id, provider: 'OpenAI',
        category: 'Test models', categoryPriority: 1, context_length: 128000,
        pricing: { prompt: '0.0000001', completion: '0.0000002' },
        architecture: { input_modalities: ['text'], output_modalities: ['text'] }
    }));
    const delay = (ms, signal) => new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
        const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
        signal?.addEventListener('abort', abort, { once: true });
    });
    const ticketBackend = app.inferenceService.getBackend('openrouter');
    const zkBackend = app.inferenceService.getBackend('zkapi');
    for (const backend of [ticketBackend, zkBackend]) {
        backend.getCachedModels = () => models;
        backend.fetchModels = async () => models;
    }
    // Keep the actual acquireVerifiedAccess policy and access persistence. Only
    // the external key issuer and verifier response are simulated here.
    window.ticketClient.getTicketCount = () => fixture.ticketCount;
    ticketBackend.requestAccess = async ({ session, ticketsRequired = 1, signal }) => {
        await delay(25, signal);
        fixture.ticketCount -= ticketsRequired;
        localStorage.setItem('payment-e2e-ticket-count', String(fixture.ticketCount));
        fixture.acquisitions.push({ mode: 'tickets', sessionId: session.id });
        window.dispatchEvent(new Event('tickets-updated'));
        return { key: `test-only-ticket:${session.id}`, stationId: 'test-only-station',
            expiresAt: new Date(Date.now() + 300000).toISOString(), expiresAtUnix: Math.floor(Date.now() / 1000) + 300,
            stationSignature: 'test-only', orgSignature: 'test-only', creditLimit: 0.05, ticketsConsumed: ticketsRequired };
    };
    ticketBackend.verification.allowsLocalBypass = () => false;
    ticketBackend.verification.init = async () => {};
    ticketBackend.verification.startBroadcastCheck = () => {};
    ticketBackend.verification.setCurrentAccess = () => {};
    ticketBackend.verification.submitAccess = async info => {
        fixture.verifications.push({ stationId: info.stationId });
        return { status: 'verified', station_id: info.stationId };
    };
    client.initialized = true;
    client.lastError = null;
    client.wallet = { has_note: true, note: { note_id: 999, deposit_amount: 5000000,
        current_balance: 5000000, expiry_ts: Math.floor(Date.now() / 1000) + 86400 } };
    client.config = { ...client.config, funding: { ...client.config?.funding, models },
        active_lease: null, prepared_withdrawal: null, late_withdrawal_attempts: [] };
    client.init = async () => client.snapshot();
    client.refresh = async () => client.snapshot();
    client.hasPendingLease = async () => Boolean(client.activeLease);
    client.getPendingLeaseOwner = async () => client.activeLease?.session_id || null;
    client.acquireInferenceAccess = async (sessionId, { signal, onProgress } = {}) => {
        fixture.acquisitions.push({ mode: 'zkapi', sessionId });
        onProgress?.({ kind: 'access', phase: 'proof', message: 'Preparing simulated private access…' });
        await delay(25, signal);
        client.config.active_lease = { session_id: sessionId, expires_at: Math.floor(Date.now() / 1000) + 300, remaining_requests: 99 };
        client.emitChange('runtime');
        return { mode: 'browser', apiKey: `test-only-zkapi:${sessionId}`, baseUrl: 'https://provider.invalid/v1',
            spendingLimitUsd: 0.05, headers: { authorization: `Bearer test-only-zkapi:${sessionId}` }, release() {} };
    };
    client.settleActiveLease = async () => {
        fixture.settlements.push(client.activeLease?.session_id);
        await delay(25);
        client.config.active_lease = null;
        client.emitChange('runtime');
    };
    const transport = window.networkProxy;
    const record = (url, init) => {
        const token = new Headers(init.headers).get('authorization') || '';
        const mode = token.includes('test-only-zkapi:') ? 'zkapi' : 'tickets';
        if (!token.includes('test-only-')) throw new Error('E2E refused a non-fixture credential.');
        const body = JSON.parse(init.body);
        const request = { mode, body, stream: body.stream === true };
        fixture.requests.push(request);
        return request;
    };
    transport.fetchWithRetry = async (url, init, { signal } = {}) => {
        const request = record(url, init);
        const encoder = new TextEncoder();
        return new Response(new ReadableStream({
            async start(controller) {
                try {
                    while (fixture.holdResponses) await delay(20, signal);
                    for (const content of ['Test response ', `using ${request.mode}.`]) {
                        await delay(60, signal);
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`));
                    }
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }],
                        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.000003 } })}\n\ndata: [DONE]\n\n`));
                    controller.close();
                } catch (error) { controller.error(error); }
            }
        }), { headers: { 'content-type': 'text/event-stream' } });
    };
    transport.fetchWithRetryJson = async (url, init) => {
        record(url, init);
        const data = { choices: [{ message: { content: 'Payment switching test' } }],
            usage: { prompt_tokens: 3, completion_tokens: 3, cost: 0.000001 } };
        return { response: new Response(JSON.stringify(data)), data, text: JSON.stringify(data) };
    };
    app.welcomePanel?.close();
    await app.loadModels();
    client.emitChange('runtime');
    return { installed: true, simulated: ['tickets', 'verifier', 'zkAPI wallet/leases', 'provider replies'] };
}

let local;
let browser;
let page;
const pageErrors = [];
const checks = [];
try {
    await fs.mkdir(output, { recursive: true });
    local = value('--url') ? null : await serve();
    const url = new URL(value('--url') || local.url);
    url.searchParams.set('zkapiMode', 'browser');
    browser = await chromium.launch({ channel: 'chrome', headless: true,
        ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const models = { data: ['openrouter/auto', 'openai/gpt-4o-mini'].map(id => ({ id, name: id,
        context_length: 128000, pricing: { prompt: '0.0000001', completion: '0.0000002' } })) };
    await context.addInitScript(() => {
        window.__PAYMENT_MODE_E2E_ISOLATED__ = true;
        localStorage.setItem('oa-network-proxy-settings', JSON.stringify({ enabled: false, fallbackToDirect: false }));
    });
    // No anonymous test prompt or synthetic credential can reach a live provider.
    await context.route('**/*', async route => {
        const request = new URL(route.request().url());
        if (request.origin === url.origin && !request.pathname.startsWith('/zkapi-')) return route.continue();
        let body = {};
        let status = 200;
        if (request.pathname === '/chat/model-tickets') body = { 'openrouter/auto': 1, 'openai/gpt-4o-mini': 1 };
        else if (request.pathname === '/chat/pinned-models') body = { pinned_models: ['openrouter/auto', 'openai/gpt-4o-mini'], disabled_models: [] };
        else if (request.pathname.includes('models') || request.pathname === '/zkapi-model-catalog') body = models;
        else if (request.pathname.includes('/auth/')) { status = 401; body = { error: 'No fixture account' }; }
        else if (request.pathname.includes('config.json')) { status = 503; body = { error: 'Payment boundary is simulated by the E2E harness' }; }
        await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    });
    if (typeof context.routeWebSocket === 'function') await context.routeWebSocket('**', socket => socket.close());
    page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    const ready = async () => {
        await page.waitForFunction(() => Boolean(window.app?.runtime?.changeMode && window.zkapiClient));
        await page.evaluate(installFixture);
        await page.waitForFunction(() => !window.app.runtime.isModeLocked());
    };
    const selected = async mode => {
        assert.equal(await page.locator(`#payment-mode-${mode}`).getAttribute('aria-pressed'), 'true');
    };
    const changeMode = async mode => {
        await page.locator(`#payment-mode-${mode}`).click();
        await page.waitForFunction(expected => window.app.runtime.getMode() === expected && !window.app.runtime.isModeLocked(), mode);
        await selected(mode);
    };
    const transcript = () => page.evaluate(async () => {
        const session = window.app.getCurrentSession();
        return { sessionId: session?.id, backend: session?.inferenceBackend,
            messages: session ? await window.chatDB.getSessionMessages(session.id) : [] };
    });
    const send = async (prompt, expectedMode) => {
        const count = await page.evaluate(() => window.paymentModesFixture.requests.filter(item => item.stream).length);
        await page.locator('#message-input').fill(prompt);
        await page.locator('#send-btn').click();
        await page.waitForFunction(previous => window.paymentModesFixture.requests.filter(item => item.stream).length > previous, count);
        await page.waitForFunction(() => !window.app.runtime.isModeLocked());
        const current = await transcript();
        assert.equal(current.messages.at(-1).content, `Test response using ${expectedMode}.`);
        assert.equal(current.messages.filter(message => message.role === 'user').at(-1).content, prompt);
        const request = await page.evaluate(() => window.paymentModesFixture.requests.filter(item => item.stream).at(-1));
        assert.equal(request.mode, expectedMode);
        assert.deepEqual(request.body.messages.filter(message => message.role === 'user').map(message => message.content),
            current.messages.filter(message => message.role === 'user').map(message => message.content),
            'each payment source sends the same retained conversation context');
        return current;
    };
    await page.goto(url.href);
    await ready();
    await selected('tickets');
    assert.equal(await page.locator('#zkapi-composer-status').count(), 0);
    assert.equal(await page.locator('#payment-funding-btn').count(), 1);
    await page.locator('#payment-funding-btn').click();
    if (!await page.locator('#invitation-code-input').count()) await page.locator('#toggle-invitation-form-btn').click();
    const ticketInputPreserved = await page.evaluate(() => {
        const input = document.getElementById('invitation-code-input');
        // Establish this focused notification test's input and caret in the
        // same turn: the Add-form preference itself saves asynchronously.
        input.value = 'TESTONLYNOTAREALCODE';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
        input.setSelectionRange(4, 8);
        const snapshots = [];
        for (const reason of ['runtime', 'error', 'wallet-account', 'clock']) {
            window.zkapiClient.emitChange(reason);
            snapshots.push({ reason, sameNode: input === document.getElementById('invitation-code-input'),
                focused: document.activeElement === input, value: input.value, start: input.selectionStart, end: input.selectionEnd });
        }
        return snapshots;
    });
    assert.ok(ticketInputPreserved.every(item => item.sameNode && item.focused && item.value === 'TESTONLYNOTAREALCODE'
        && item.start === 4 && item.end === 8), `wallet updates cannot remount or blur ticket-code entry: ${JSON.stringify(ticketInputPreserved)}`);
    await page.locator('#invitation-code-input').fill('');
    checks.push('Ticket-code input, caret and focus survive unrelated zkAPI wallet notifications.');
    const first = await send('Remember this transcript while payment changes.', 'tickets');
    await changeMode('zkapi');
    const switched = await transcript();
    assert.equal(switched.sessionId, first.sessionId);
    assert.deepEqual(switched.messages, first.messages);
    const second = await send('Continue this same chat using zkAPI.', 'zkapi');
    assert.equal(second.sessionId, first.sessionId);
    await changeMode('tickets');
    assert.deepEqual((await transcript()).messages, second.messages);
    await send('Continue it once more using tickets.', 'tickets');
    assert.ok(await page.evaluate(id => window.paymentModesFixture.settlements.includes(id), first.sessionId));
    assert.ok(await page.evaluate(() => window.paymentModesFixture.verifications.length >= 2));
    checks.push('Both directions retain one transcript and acquire the selected payment source; zkAPI key retirement occurs.');

    await changeMode('zkapi');
    await page.locator('#new-chat-btn').click();
    await page.waitForFunction(() => !window.app.getCurrentSession());
    await selected('zkapi');
    const newChat = await send('Start a separate chat with the remembered method.', 'zkapi');
    assert.notEqual(newChat.sessionId, first.sessionId);
    checks.push('New Chat inherits the remembered mode and creates a different transcript.');

    await page.evaluate(() => { window.paymentModesFixture.holdResponses = true; });
    await page.locator('#message-input').fill('Hold this response to check switching during streaming.');
    await page.locator('#send-btn').click();
    await page.waitForFunction(() => window.app.runtime.isModeLocked());
    await page.waitForFunction(() => document.getElementById('payment-mode-tickets').disabled);
    assert.equal(await page.locator('#payment-mode-zkapi').isDisabled(), true);
    const rejected = await page.evaluate(async () => {
        try { await window.app.runtime.changeMode('tickets'); return false; }
        catch { return true; }
    });
    assert.equal(rejected, true);
    await page.evaluate(() => { window.paymentModesFixture.holdResponses = false; });
    await page.waitForFunction(() => !window.app.runtime.isModeLocked());
    await selected('zkapi');
    checks.push('Payment controls and runtime reject switching during active work.');

    const beforeReload = await transcript();
    await page.reload();
    await ready();
    await selected('zkapi');
    const afterReload = await transcript();
    assert.equal(afterReload.sessionId, beforeReload.sessionId);
    assert.deepEqual(afterReload.messages, beforeReload.messages);
    await page.locator(`.chat-session[data-session-id="${first.sessionId}"] .session-title-input`).click();
    await page.waitForFunction(id => window.app.getCurrentSession()?.id === id && !window.app.runtime.isModeLocked(), first.sessionId);
    await changeMode('tickets');
    const resumed = await send('Resume the historical chat after a full reload.', 'tickets');
    assert.equal(resumed.sessionId, first.sessionId);
    assert.ok(resumed.messages.some(message => message.content === first.messages[0].content));
    checks.push('Reload restores the same IndexedDB history and mode; historical chat resumes after another switch.');
    await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    if (await page.locator('#close-right-panel').isVisible()) await page.locator('#close-right-panel').click();
    if (await page.locator('#sidebar').evaluate(element => element.classList.contains('mobile-visible'))) {
        await page.locator('#hide-sidebar-btn').click();
    }
    assert.equal(await page.locator('#payment-mode-tickets').isVisible(), true);
    assert.equal(await page.locator('#payment-mode-zkapi').isVisible(), true);
    await page.locator('#payment-mode-tickets').click({ trial: true });
    await page.locator('#payment-mode-zkapi').click({ trial: true });
    assert.equal(await page.locator('#zkapi-composer-status').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
    checks.push('Desktop/mobile show one funding control, no redundant composer status, and no horizontal overflow.');
    assert.deepEqual(pageErrors, [], 'No uncaught application errors are permitted.');
    const report = { passed: true, url: url.href, checks, pageErrors,
        boundary: 'Payment issuance, verifier answers, blockchain funding, leases and provider replies were simulated; application, persistence, mode switching and streaming parsing were real.' };
    await fs.writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
} catch (error) {
    console.error(error);
    console.error(JSON.stringify({ passed: false, checks, pageErrors }, null, 2));
    if (page) {
        await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
        console.error(await page.evaluate(() => ({
            visibleText: document.body.innerText.slice(-5000),
            requestCount: window.paymentModesFixture?.requests.length,
            acquisitions: window.paymentModesFixture?.acquisitions,
            backend: window.app?.getCurrentSession()?.inferenceBackend,
            tickets: window.ticketClient?.getTicketCount()
        })).catch(() => ({})));
    }
    process.exitCode = 1;
} finally {
    await browser?.close();
    if (local?.server) await new Promise(resolve => local.server.close(resolve));
}
