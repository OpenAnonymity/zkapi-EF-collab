import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.window = { location: { hostname: 'localhost' } };
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } });
const { BrowserWalletRuntime } = await import('../services/browserWalletRuntime.js');
const { withBrowserWalletLock } = await import('../services/browserWalletStore.js');

function deferred() {
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    return { promise, resolve };
}

function harness(deploymentId) {
    const runtime = new BrowserWalletRuntime();
    runtime.manifest = { deployment_id: deploymentId };
    runtime.init = async () => {};
    runtime.activeLease = null;
    let durable = { lease: { sessionId: 'chat-a', client_request_id: 'request-a' },
        journal: { client_request_id: 'request-a' }, state: { note_id: 1, current_balance: 2000000 } };
    runtime.reload = async () => { runtime.runtime = structuredClone(durable); return runtime.runtime; };
    return { runtime, getDurable: () => structuredClone(durable), setDurable: value => { durable = structuredClone(value); } };
}

test('a switch-away owner read cannot retire a newer chat lease installed before the settlement lock', async () => {
    const h = harness('payment-mode-owner-race');
    assert.equal(await h.runtime.getPendingLeaseOwner(), 'chat-a');
    const entered = deferred();
    const release = deferred();
    const replacement = { lease: { sessionId: 'chat-b', client_request_id: 'request-b' },
        journal: { client_request_id: 'request-b' }, state: { note_id: 1, current_balance: 1950000 } };
    // Model another browser tab publishing B while our A->Tickets action waits
    // for the same production wallet lock used by deposit/proof/recovery paths.
    const otherTab = withBrowserWalletLock(h.runtime.manifest.deployment_id, async () => {
        entered.resolve();
        await release.promise;
        h.setDurable(replacement);
    });
    await entered.promise;
    let recoveries = 0;
    h.runtime.recoverPendingLocked = async () => { recoveries += 1; };
    const switchAway = h.runtime.settleSessionLease('chat-a');
    await Promise.resolve();
    release.resolve();
    await Promise.all([otherTab, switchAway]);
    assert.equal(recoveries, 0);
    assert.deepEqual(h.getDurable(), replacement);
    assert.deepEqual(h.runtime.runtime, replacement);
    assert.equal(await h.runtime.getPendingLeaseOwner(), 'chat-b');
});

test('an expired owned key with no in-memory credential still recovers and settles its own durable lease', async () => {
    const h = harness('payment-mode-expired-owner');
    const recoveryCalls = [];
    h.runtime.recoverPendingLocked = async options => {
        recoveryCalls.push({ owner: h.runtime.runtime.lease.sessionId, retire: options.retireLostKey });
        const settled = { ...h.runtime.runtime, lease: null, journal: null };
        h.setDurable(settled);
        h.runtime.runtime = settled;
    };
    assert.equal(h.runtime.activeLease, null);
    assert.equal(await h.runtime.getPendingLeaseOwner(), 'chat-a');
    await h.runtime.settleSessionLease('chat-a');
    assert.deepEqual(recoveryCalls, [{ owner: 'chat-a', retire: true }]);
    assert.equal(await h.runtime.getPendingLeaseOwner(), null);
    assert.equal(h.getDurable().journal, null);
});

test('unfinished settlement reports a retryable failure while preserving its owner and recovery journal', async () => {
    const h = harness('payment-mode-pending-owner');
    const before = h.getDurable();
    h.runtime.recoverPendingLocked = async () => {};
    await assert.rejects(h.runtime.settleSessionLease('chat-a'), error =>
        error.code === 'lease_pending' && error.status === 409);
    assert.deepEqual(h.getDurable(), before);
    assert.equal(await h.runtime.getPendingLeaseOwner(), 'chat-a');
});
