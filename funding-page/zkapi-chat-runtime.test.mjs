import test from 'node:test';
import assert from 'node:assert/strict';
import { createZkapiChatRuntimeCore } from './services/zkapiChatRuntimeCore.mjs';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function harness(options = {}) {
    const sessions = new Map([
        ['previous', { id: 'previous', title: 'Previous conversation' }],
        ['next', { id: 'next', title: 'Next conversation' }]
    ]);
    const saved = [];
    const canceled = [];
    const progress = [];
    const refreshed = [];
    const activity = [];
    const calls = { settlement: 0, funding: 0 };
    let subscriber;
    const client = {
        activeLease: { session_id: 'previous' },
        hasNote: true,
        withdrawalBlocksChat: false,
        init: async () => {},
        subscribe(callback) { subscriber = callback; return () => { subscriber = null; }; },
        async settleActiveLease() {
            calls.settlement += 1;
            if (options.settle) await options.settle(client, calls.settlement);
            client.activeLease = null;
        },
        hasPendingLease: async () => false
    };
    const backend = { id: 'private', requestAccess: async request => ({ token: request.session.id }) };
    const context = {
        getSession: id => sessions.get(id),
        saveSession: async session => saved.push(structuredClone(session)),
        cancelSessionWork: async id => { canceled.push(id); },
        refreshPresentation: options => refreshed.push(options),
        logLocalEvent: (action, message, response) => activity.push({ action, message, response }),
        setProgress: (id, value) => progress.push({ id, value }),
        openFunding: () => { calls.funding += 1; }
    };
    const runtime = createZkapiChatRuntimeCore({
        client,
        backend,
        modelConfiguration: { getDefaultModelConfig: () => ({ defaultModelId: 'model' }) },
        createInferenceService: ({ backends }) => ({
            requestAccess: (session, options) => backends[0].requestAccess({ ...options, session })
        }),
        ...(options.runtime || {})
    });
    const detach = runtime.attach(context);
    return { runtime, client, backend, context, calls, sessions, saved, canceled, progress,
        refreshed, activity, detach, emit: (value, detail) => subscriber?.(value, detail) };
}

test('New Chat returns immediately and a fast Send waits behind one background settlement', async () => {
    const settlement = deferred();
    const h = harness({ settle: () => settlement.promise });
    assert.equal(h.runtime.onNewChat({ sessionId: 'previous' }), undefined);
    assert.equal(h.runtime.getTransition().phase, 'settling');
    let sent = false;
    const sending = h.runtime.prepareTurn({ sessionId: 'next' }).then(() => { sent = true; });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(sent, false);
    assert.equal(h.calls.settlement, 1);
    assert.deepEqual(h.canceled, ['previous']);
    assert.deepEqual(h.runtime.getSessionStatus(h.sessions.get('next')), { tone: 'waiting', label: 'Queued' });
    settlement.resolve();
    await sending;
    assert.equal(sent, true);
    assert.equal(h.runtime.getTransition().phase, 'ready');
    assert.equal(h.runtime.getSessionStatus(h.sessions.get('next')), null);
    assert.equal(h.client.activeLease, null);
    assert.deepEqual(h.activity.map(event => [event.action, event.response.sessionId]),
        [['lease-settlement-start', 'previous'], ['lease-settlement-complete', 'previous']]);
});

test('switching chats without New Chat uses the same barrier and does not settle the destination twice', async () => {
    const h = harness();
    await h.runtime.prepareTurn({ sessionId: 'next' });
    assert.equal(h.calls.settlement, 1);
    await h.runtime.prepareTurn({ sessionId: 'next' });
    assert.equal(h.calls.settlement, 1);
});

test('forks keep conversation content but never inherit key ownership or historical billing', () => {
    const h = harness();
    const original = { id: 'old-message', role: 'assistant', content: 'Earlier explanation',
        tokenCount: 42, files: [{ name: 'source.txt' }], promptTokens: 10, completionTokens: 32,
        totalTokens: 42, estimatedCostUsd: 0.002, usageProviderReported: true,
        usagePricing: { prompt: '0.1' }, zkapiUsageRecorded: true };
    const snapshot = h.runtime.transformForkMessage(original);
    assert.equal(h.runtime.reuseAccessOnFork, false);
    assert.deepEqual(snapshot, { id: 'old-message', role: 'assistant', content: 'Earlier explanation',
        tokenCount: 42, files: [{ name: 'source.txt' }] });
    snapshot.files[0].name = 'edited.txt';
    assert.equal(original.files[0].name, 'source.txt');
    assert.equal(original.estimatedCostUsd, 0.002);
});

test('canceling a queued Send removes only that waiter, not the settlement or another waiter', async () => {
    const settlement = deferred();
    const h = harness({ settle: () => settlement.promise });
    h.runtime.onNewChat({ sessionId: 'previous' });
    const controller = new AbortController();
    const canceledSend = h.runtime.prepareTurn({ sessionId: 'next', signal: controller.signal });
    const continuingSend = h.runtime.prepareTurn({ sessionId: 'other-next' });
    controller.abort();
    await assert.rejects(canceledSend, error => error.name === 'AbortError' && error.isCancelled);
    assert.equal(h.runtime.getSessionStatus({ id: 'next' }), null);
    assert.equal(h.runtime.getTransition().phase, 'settling');
    settlement.resolve();
    await continuingSend;
    assert.equal(h.calls.settlement, 1);
    assert.equal(h.runtime.getTransition().phase, 'ready');
});

test('a settlement failure is visible and retrying the same chat never cancels its new Send', async () => {
    const h = harness({ settle: async (_client, count) => {
        if (count === 1) throw new Error('Server temporarily unavailable');
    } });
    h.runtime.onNewChat({ sessionId: 'previous' });
    await assert.rejects(h.runtime.prepareTurn({ sessionId: 'next' }), /temporarily unavailable/);
    assert.equal(h.runtime.getTransition().phase, 'error');
    assert.equal(h.runtime.getSessionStatus({ id: 'previous' }).tone, 'error');
    assert.equal(h.activity.at(-1).action, 'lease-settlement-error');
    assert.equal(h.activity.at(-1).response.sessionId, 'previous');
    await h.runtime.prepareTurn({ sessionId: 'previous' });
    assert.equal(h.calls.settlement, 2);
    assert.deepEqual(h.canceled, ['previous'], 'the retry cannot abort itself');
    assert.equal(h.runtime.getTransition().phase, 'ready');
});

test('canceling one same-session waiter leaves the other visibly queued', async () => {
    const settlement = deferred();
    const h = harness({ settle: () => settlement.promise });
    const controller = new AbortController();
    const first = h.runtime.prepareTurn({ sessionId: 'next', signal: controller.signal });
    const second = h.runtime.prepareTurn({ sessionId: 'next' });
    controller.abort();
    await assert.rejects(first, /canceled/);
    assert.equal(h.runtime.getSessionStatus({ id: 'next' }).label, 'Queued');
    settlement.resolve();
    await second;
    assert.equal(h.runtime.getSessionStatus({ id: 'next' }), null);
});

test('in-flight lease requests retry settlement before releasing the next chat', async () => {
    const delays = [];
    const h = harness({
        settle: async (_client, count) => {
            if (count === 1) throw Object.assign(new Error('Requests in flight'), {
                code: 'lease_requests_in_flight', data: { retry_after_seconds: 0.5 }
            });
        },
        runtime: { retryDelay: async milliseconds => delays.push(milliseconds) }
    });
    await h.runtime.prepareTurn({ sessionId: 'next' });
    assert.equal(h.calls.settlement, 2);
    assert.deepEqual(delays, [500]);
});

test('exhausted settlement retry deadline reports a recoverable error instead of remaining queued', async () => {
    const h = harness({
        settle: async () => { throw Object.assign(new Error('Still settling'), { code: 'lease_settlement_pending' }); },
        runtime: { retirementTimeoutMs: 0, retryDelay: async () => assert.fail('deadline is exhausted') }
    });
    await assert.rejects(h.runtime.prepareTurn({ sessionId: 'next' }), /Still settling/);
    assert.equal(h.runtime.getTransition().phase, 'error');
    assert.equal(h.runtime.getSessionStatus({ id: 'next' }), null);
    assert.equal(h.calls.settlement, 1);
});

test('delete waits for current key release and refuses pending recovery instead of losing its owner', async () => {
    const settlement = deferred();
    const h = harness({ settle: () => settlement.promise });
    let deleted = false;
    const deletion = h.runtime.beforeDelete({ sessionIds: ['previous'] }).then(() => { deleted = true; });
    await Promise.resolve();
    assert.equal(deleted, false);
    settlement.resolve();
    await deletion;
    assert.equal(h.client.activeLease, null);
    h.client.hasPendingLease = async () => true;
    await assert.rejects(h.runtime.beforeDelete({ sessionIds: ['previous'] }), /still finishing/);
});

test('delete also waits when a running settlement has temporarily cleared its active-lease snapshot', async () => {
    const settlement = deferred();
    const h = harness({ settle: async client => { client.activeLease = null; await settlement.promise; } });
    h.runtime.onNewChat({ sessionId: 'previous' });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(h.client.activeLease, null);
    let deleted = false;
    const deletion = h.runtime.beforeDelete({ sessionIds: ['previous'] }).then(() => { deleted = true; });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(deleted, false);
    settlement.resolve();
    await deletion;
});

test('usage previews update only usage presentation and final usage persists without double counting', async () => {
    const h = harness();
    await Promise.resolve();
    const pricing = { prompt: '0.001', completion: '0.002' };
    h.refreshed.length = 0;
    await h.runtime.recordUsage({ sessionId: 'next', requestId: 'response-1',
        usage: { promptTokens: 10, completionTokens: 2 }, pricing, final: false });
    assert.equal(h.saved.length, 0);
    assert.equal(h.runtime.getSessionUsageSummary('next').estimatedCostUsd, 0.014);
    assert.deepEqual(h.refreshed.at(-1), { usageOnly: true });
    const metadata = await h.runtime.recordUsage({ sessionId: 'next', requestId: 'response-1',
        usage: { promptTokens: 10, completionTokens: 4, cost: 0.017 }, pricing });
    assert.equal(h.saved.length, 1);
    assert.equal(h.runtime.getSessionUsageSummary('next').requests, 1);
    assert.equal(h.runtime.getSessionUsageSummary('next').estimatedCostUsd, 0.017);
    pricing.prompt = '900';
    metadata.usagePricing.completion = '900';
    assert.deepEqual(h.sessions.get('next').zkapiUsageLedger[0].pricing, { prompt: '0.001', completion: '0.002' });
});

test('usage restores from messages once, and a deleted chat is never recreated by late usage or restore', async () => {
    const h = harness();
    const session = h.sessions.get('next');
    const messages = [{ id: 'response-1', role: 'assistant', model: 'model', zkapiUsageRecorded: true,
        promptTokens: 10, completionTokens: 5, estimatedCostUsd: 0.2 }];
    await h.runtime.restoreSession(session, messages);
    await h.runtime.restoreSession(session, messages);
    assert.equal(h.saved.length, 1);
    assert.equal(h.runtime.getSessionUsageSummary(session).estimatedCostUsd, 0.2);
    h.sessions.delete('next');
    assert.equal(await h.runtime.recordUsage({ sessionId: 'next', requestId: 'late', usage: { cost: 1 } }), null);
    await h.runtime.restoreSession({ id: 'next' }, messages);
    assert.equal(h.saved.length, 1);
});

test('failed pre-response request discards its prompt preview without touching settled usage', async () => {
    const h = harness();
    await h.runtime.recordUsage({ sessionId: 'next', requestId: 'completed', usage: { cost: 0.1 } });
    await h.runtime.recordUsage({ sessionId: 'next', requestId: 'failed', usage: { cost: 0.2 }, final: false });
    h.runtime.discardUsagePreview({ sessionId: 'next', requestId: 'failed' });
    assert.equal(h.runtime.getSessionUsageSummary('next').requests, 1);
    assert.equal(h.runtime.getSessionUsageSummary('next').estimatedCostUsd, 0.1);
    assert.equal(h.saved.length, 1);
});

test('funding gate respects cancellation, unavailable funds and withdrawal recovery', async () => {
    const h = harness();
    assert.equal(await h.runtime.checkCanSend(), true);
    h.client.withdrawalBlocksChat = true;
    assert.equal(await h.runtime.checkCanSend(), false);
    assert.equal(h.calls.funding, 1);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(h.runtime.checkCanSend({ signal: controller.signal }), /canceled/);
    assert.equal(h.calls.funding, 1);
});

test('clock ticks do not re-render the UI and detaching suppresses settlement completion renders', async () => {
    const settlement = deferred();
    const h = harness({ settle: () => settlement.promise });
    await Promise.resolve();
    h.refreshed.length = 0;
    h.emit({}, { reason: 'clock' });
    assert.equal(h.refreshed.length, 0);
    h.runtime.onNewChat({ sessionId: 'previous' });
    h.detach();
    h.refreshed.length = 0;
    settlement.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(h.refreshed.length, 0);
    await h.runtime.recordUsage({ sessionId: 'next', requestId: 'late-result', usage: { cost: 0.1 } });
    assert.equal(h.saved.length, 1, 'durable accounting may finish after view disposal');
    assert.equal(h.refreshed.length, 0, 'a disposed view cannot be repainted by a late result');
});
