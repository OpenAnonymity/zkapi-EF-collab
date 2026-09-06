// Load through agent-browser eval --stdin on an isolated localhost profile.
// Only payment/provider boundaries are simulated: the built app, runtime,
// request construction, SSE parser, IndexedDB and UI remain production code.
if (!['127.0.0.1', 'localhost'].includes(location.hostname)) {
    throw new Error('The browser fixture is restricted to localhost.');
}
if (window.ethereum) throw new Error('Use a test browser without a wallet extension.');
const app = window.app;
const client = window.zkapiClient;
const api = window.openRouterAPI;
if (!app || !client || !api) throw new Error('Wait for the composed application to initialize.');
window.compositionFixture = { requests: [], acquisitions: [], releases: [], settlements: [], holdSettlement: false };
const fixture = window.compositionFixture;
const delay = (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    signal?.addEventListener('abort', abort, { once: true });
});
client.initialized = true;
client.wallet = { has_note: true, note: { note_id: 999, deposit_amount: 5000000, current_balance: 5000000, expiry_ts: Math.floor(Date.now() / 1000) + 86400 } };
client.config = { ...client.config, active_lease: null, prepared_withdrawal: null, late_withdrawal_attempts: [] };
client.init = async () => client.snapshot();
client.refresh = async () => client.snapshot();
client.hasPendingLease = async () => Boolean(client.activeLease);
client.acquireInferenceAccess = async (sessionId, { signal, onProgress } = {}) => {
    fixture.acquisitions.push(sessionId);
    onProgress?.({ kind: 'access', phase: 'proof', message: 'Generating a private funding proof…' });
    await delay(350, signal);
    client.config.active_lease = { session_id: sessionId, expires_at: Math.floor(Date.now() / 1000) + 300, remaining_requests: 9999 };
    client.emitChange('runtime');
    return { mode: 'browser', apiKey: 'test-only-not-a-real-key', baseUrl: 'https://provider.invalid/v1',
        spendingLimitUsd: 1, headers: { 'content-type': 'application/json', authorization: 'Bearer test-only-not-a-real-key' },
        release() { fixture.releases.push(sessionId); } };
};
client.settleActiveLease = async () => {
    const owner = client.activeLease?.session_id;
    fixture.settlements.push(owner);
    while (fixture.holdSettlement) await delay(30);
    client.config.active_lease = null;
    client.emitChange('runtime');
};
api.networkTransport = {
    async fetchWithRetry(url, init, { signal } = {}) {
        const body = JSON.parse(init.body);
        fixture.requests.push({ url, body, stream: true });
        const chunks = ['HTTPS protects ', 'your connection ', 'using TLS encryption.'];
        const encoder = new TextEncoder();
        let stopped = false;
        return new Response(new ReadableStream({
            async start(controller) {
                try {
                    for (const content of chunks) {
                        await delay(300, signal);
                        if (stopped) return;
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`));
                    }
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.003 } })}\n\ndata: [DONE]\n\n`));
                    controller.close();
                } catch (error) { if (!stopped) controller.error(error); }
            },
            cancel() { stopped = true; }
        }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
    async fetchWithRetryJson(url, init) {
        fixture.requests.push({ url, body: JSON.parse(init.body), stream: false });
        const data = { choices: [{ message: { content: 'Understanding HTTPS' } }], usage: { prompt_tokens: 30, completion_tokens: 3, cost: 0.0001 } };
        return { response: new Response(JSON.stringify(data)), data, text: JSON.stringify(data) };
    }
};
app.welcomePanel?.close();
client.emitChange('runtime');
({ installed: true, backend: app.inferenceService.getDefaultBackendId(), accountsDisabled: app.features.accounts === false });
