import assert from 'node:assert/strict';
import test from 'node:test';

const clone = value => value === undefined ? undefined : structuredClone(value);

// A transactional IndexedDB boundary: writes remain private to a transaction
// until completion, including when an injected history write fails. The tests
// exercise the real wallet store and runtime rather than source-code patterns.
function memoryIndexedDb() {
    const stores = new Map([
        ['runtime', new Map()], ['archives', new Map()], ['withdrawals', new Map()]
    ]);
    const keyPaths = new Map([['archives', 'archiveId'], ['withdrawals', 'recordId']]);
    let version = 2;
    let failDepositWrite = false;
    const database = {
        close() {},
        objectStoreNames: { contains: name => stores.has(name) },
        createObjectStore(name, options = {}) {
            stores.set(name, new Map());
            keyPaths.set(name, options.keyPath);
        },
        transaction(names, mode) {
            const allowed = Array.isArray(names) ? names : [names];
            const working = new Map(allowed.map(name => [name, new Map(stores.get(name))]));
            let timer;
            const transaction = {
                aborted: false, completed: false, pending: 0,
                abort() {
                    if (this.aborted || this.completed) return;
                    this.aborted = true;
                    clearTimeout(timer);
                    setTimeout(() => this.onabort?.(), 0);
                },
                scheduleCompletion() {
                    clearTimeout(timer);
                    if (this.aborted || this.pending) return;
                    timer = setTimeout(() => {
                        if (this.aborted || this.pending) return;
                        if (mode === 'readwrite') {
                            for (const [name, values] of working) stores.set(name, values);
                        }
                        this.completed = true;
                        this.oncomplete?.();
                    }, 0);
                },
                objectStore(name) {
                    if (!working.has(name)) throw new Error(`Unknown object store: ${name}`);
                    const values = working.get(name);
                    const request = operation => {
                        const pending = {};
                        transaction.pending += 1;
                        queueMicrotask(() => {
                            try {
                                if (transaction.aborted) return;
                                pending.result = operation();
                                pending.onsuccess?.();
                            } catch (error) {
                                pending.error = error;
                                transaction.error = error;
                                pending.onerror?.();
                                transaction.abort();
                            } finally {
                                transaction.pending -= 1;
                                transaction.scheduleCompletion();
                            }
                        });
                        return pending;
                    };
                    return {
                        get: key => request(() => clone(values.get(key))),
                        getAll: () => request(() => [...values.values()].map(clone)),
                        put: (value, key) => request(() => {
                            if (name === 'deposits' && failDepositWrite) {
                                failDepositWrite = false;
                                throw new Error('Simulated history storage failure');
                            }
                            const resolved = key ?? value[keyPaths.get(name)];
                            values.set(resolved, clone(value));
                            return resolved;
                        }),
                        delete: key => request(() => values.delete(key))
                    };
                }
            };
            return transaction;
        }
    };
    return {
        stores,
        clear() { for (const values of stores.values()) values.clear(); },
        failNextDepositWrite() { failDepositWrite = true; },
        open(_name, requestedVersion) {
            const request = {};
            queueMicrotask(() => {
                request.result = database;
                if (requestedVersion > version) {
                    const oldVersion = version;
                    version = requestedVersion;
                    request.onupgradeneeded?.({ oldVersion, newVersion: version });
                }
                request.onsuccess?.();
            });
            return request;
        }
    };
}

const values = new Map();
globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value))
};
globalThis.sessionStorage = globalThis.localStorage;
globalThis.window = new EventTarget();
globalThis.window.location = { search: '', hostname: 'localhost' };
globalThis.indexedDB = memoryIndexedDb();
const {
    archiveBrowserWallet, readBrowserWallet, readBrowserWalletSnapshot, recordBrowserExpiryClaims,
    updateBrowserWithdrawal, writeBrowserWallet
} = await import('./services/browserWalletStore.js');
const { default: singleton } = await import('./services/browserWalletRuntime.js');

const DEPLOYMENT = 'deployment:sepolia';
const OTHER_DEPLOYMENT = 'deployment:mainnet';
const HASH = `0x${'ab'.repeat(32)}`;
const REPLACED_HASH = `0x${'cd'.repeat(32)}`;
const state = (noteId = 7, amount = 2_000_000) => ({
    note_id: noteId, deposit_amount: amount, current_balance: 123,
    secret: 'private-note-secret', current_commitment: 'private-commitment'
});
const plan = (overrides = {}) => ({
    operationId: 'deposit-operation', next_note_id: 7, amount: 2_000_000,
    secret: 'private-note-secret', commitment: '0x123', phase: 'submitted',
    createdAt: 1000, transactionHash: REPLACED_HASH, ...overrides
});
function seedRuntime(value) {
    indexedDB.stores.get('runtime').set('active', clone({ deploymentId: DEPLOYMENT, ...value }));
}
function makeRuntime() {
    const runtime = new singleton.constructor();
    runtime.manifest = { deployment_id: DEPLOYMENT };
    runtime.config = { wallet_core: {}, funding: {} };
    runtime.init = async () => runtime.snapshot();
    runtime.walletStatus = async () => ({ has_note: Boolean(runtime.runtime.state) });
    runtime.worker = { call: async (method, payload) => {
        assert.equal(method, 'confirmDeposit');
        return state(payload.args.note_id, payload.args.amount);
    } };
    return runtime;
}
const confirmArgs = (extra = {}) => ({
    operationId: 'deposit-operation', secret: 'private-note-secret',
    note_id: 7, amount: 2_000_000, commitment: '0x123', expiry_ts: 9999,
    ...extra
});
function assertSanitized(records) {
    assert.doesNotMatch(JSON.stringify(records), /private-note-secret|private-commitment|proof|clearance|0x123/);
}

test.beforeEach(() => indexedDB.clear());

test('v2 migration recovers original deposits from notes, archives and withdrawal states without invented dates', async () => {
    seedRuntime({ state: state(), updatedAt: 98765 });
    const original = clone(indexedDB.stores.get('runtime').get('active'));
    indexedDB.stores.get('archives').set('old', {
        archiveId: `${DEPLOYMENT}:6:4000`, archivedAt: 4001, state: state(6, 5_000_000)
    });
    indexedDB.stores.get('archives').set('duplicate', {
        archiveId: `${DEPLOYMENT}:7:7000`, archivedAt: 7000, state: state()
    });
    indexedDB.stores.get('archives').set('other', {
        archiveId: `${OTHER_DEPLOYMENT}:7:4000`, archivedAt: 4000, state: state(7, 9_000_000)
    });
    indexedDB.stores.get('withdrawals').set('withdrawal', {
        recordId: 'withdrawal', deploymentId: DEPLOYMENT, createdAt: 3000,
        state: state(5, 4_000_000), phase: 'parked'
    });
    indexedDB.stores.get('withdrawals').set('no-original-amount', {
        recordId: 'no-original-amount', deploymentId: DEPLOYMENT,
        state: { note_id: 4, current_balance: 55 }
    });
    const snapshot = await readBrowserWalletSnapshot(DEPLOYMENT);
    assert.deepEqual(snapshot.deposits.map(row => row.amount).sort(), [2_000_000, 4_000_000, 5_000_000]);
    assert.equal(snapshot.deposits.length, 3);
    for (const row of snapshot.deposits) {
        assert.equal(row.status, 'confirmed');
        assert.equal(row.createdAt, null);
        assert.equal(row.confirmedAt, null);
        assert.equal(row.transactionHash, null);
    }
    assertSanitized(snapshot.deposits);
    assert.deepEqual(indexedDB.stores.get('runtime').get('active'), original);
    indexedDB.stores.get('runtime').clear();
    indexedDB.stores.get('archives').clear();
    indexedDB.stores.get('withdrawals').clear();
    assert.deepEqual((await readBrowserWalletSnapshot(DEPLOYMENT)).deposits, snapshot.deposits);
    assert.equal((await readBrowserWalletSnapshot(OTHER_DEPLOYMENT)).deposits[0].amount, 9_000_000);
});

test('confirmed deposits retain actual receipt identity across spending, closure, replacement and runtime reload', async () => {
    seedRuntime({ pendingDeposit: plan() });
    const runtime = makeRuntime();
    await runtime.confirmDeposit(confirmArgs({ transactionHash: HASH.toUpperCase().replace('0X', '0x') }));
    const confirmed = runtime.snapshot().deposits;
    assert.equal(confirmed.length, 1);
    assert.equal(confirmed[0].status, 'confirmed');
    assert.equal(confirmed[0].transactionHash, HASH);
    assert.equal(confirmed[0].createdAt, 1000);
    assert.ok(confirmed[0].confirmedAt > 1000);
    assert.equal(confirmed[0].operationId, 'deposit-operation');
    assert.equal((await readBrowserWallet()).pendingDeposit, null);
    await writeBrowserWallet({ ...(await readBrowserWallet()), state: { ...state(), current_balance: 1 } });
    assert.deepEqual((await readBrowserWalletSnapshot(DEPLOYMENT)).deposits, confirmed);
    await archiveBrowserWallet('closed', 7);
    await writeBrowserWallet({ deploymentId: DEPLOYMENT, state: state(8, 3_000_000) });
    const reloaded = makeRuntime();
    await reloaded.reload();
    assert.equal(reloaded.snapshot().deposits.length, 2);
    assert.deepEqual(reloaded.snapshot().deposits.find(row => row.noteId === 7), confirmed[0]);
    assertSanitized(reloaded.snapshot().deposits);
});

test('unsigned preparations are omitted and durable wallet/receipt recovery remains pending until confirmation', async () => {
    const pending = plan({ phase: 'prepared', transactionHash: null });
    seedRuntime({ pendingDeposit: pending });
    assert.equal((await readBrowserWalletSnapshot(DEPLOYMENT)).deposits.length, 0);
    for (const phase of ['awaiting_wallet', 'ambiguous', 'submitted', 'dropped_or_pending']) {
        await writeBrowserWallet({ deploymentId: DEPLOYMENT, pendingDeposit: {
            ...pending, phase, ...(phase === 'submitted' ? { transactionHash: HASH } : {})
        } });
        const reloaded = makeRuntime();
        await reloaded.reload();
        const rows = reloaded.snapshot().deposits;
        assert.equal(rows.length, 1);
        assert.equal(rows[0].status, 'pending');
        assert.equal(rows[0].pendingPhase, phase);
        assert.equal(rows[0].confirmedAt, null);
        assert.equal(reloaded.snapshot().config.pending_deposit.operation_id, pending.operationId);
        assertSanitized(rows);
        assert.equal(indexedDB.stores.get('deposits').size, 0);
    }
    // Definite wallet rejection returns the same plan to the unsigned stage.
    await writeBrowserWallet({ deploymentId: DEPLOYMENT, pendingDeposit: pending });
    assert.equal((await readBrowserWalletSnapshot(DEPLOYMENT)).deposits.length, 0);
});

test('failed confirmation and failed atomic history write retain pending recovery and never record a deposit', async () => {
    seedRuntime({ pendingDeposit: plan() });
    const runtime = makeRuntime();
    await assert.rejects(runtime.confirmDeposit(confirmArgs({ amount: 1 })), /does not match/);
    runtime.worker.call = async () => { throw new Error('Invalid confirmation'); };
    await assert.rejects(runtime.confirmDeposit(confirmArgs()), /Invalid confirmation/);
    runtime.worker.call = async () => state();
    indexedDB.failNextDepositWrite();
    await assert.rejects(runtime.confirmDeposit(confirmArgs({ transactionHash: HASH })), /history storage failure/);
    const snapshot = await readBrowserWalletSnapshot(DEPLOYMENT);
    assert.equal(snapshot.runtime.state, null);
    assert.equal(snapshot.runtime.pendingDeposit.secret, plan().secret);
    assert.equal(snapshot.deposits.length, 1);
    assert.equal(snapshot.deposits[0].status, 'pending');
    assert.equal(indexedDB.stores.get('deposits').size, 0);
    // The unchanged durable plan can be confirmed successfully after retry.
    await runtime.confirmDeposit(confirmArgs({ transactionHash: HASH }));
    assert.equal(runtime.snapshot().deposits[0].status, 'confirmed');
});

test('vault-state recovery does not mislabel a replaced or unresolved saved hash as the mined transaction', async () => {
    seedRuntime({ pendingDeposit: plan() });
    const runtime = makeRuntime();
    await runtime.confirmDeposit(confirmArgs());
    assert.equal(runtime.snapshot().deposits[0].transactionHash, null);
    assert.equal(runtime.snapshot().deposits[0].status, 'confirmed');
});

test('withdrawal finality preserves legacy deposit metadata before sanitizing the last recovery state', async () => {
    indexedDB.stores.get('withdrawals').set('old-return', {
        recordId: 'old-return', deploymentId: DEPLOYMENT, revision: 1,
        state: state(1, 8_000_000), phase: 'closed_unconfirmed',
        proof: 'private-proof', withdrawalNullifier: 'private-nullifier',
        createdAt: 4000, transactionHash: HASH
    });
    await updateBrowserWithdrawal('old-return', { phase: 'closed' }, { sanitize: true });
    const snapshot = await readBrowserWalletSnapshot(DEPLOYMENT);
    assert.equal(snapshot.withdrawals[0].state, undefined);
    assert.equal(snapshot.deposits.length, 1);
    assert.equal(snapshot.deposits[0].amount, 8_000_000);
    assert.equal(snapshot.deposits[0].transactionHash, null, 'withdrawal hash is not a deposit receipt');
    assert.equal(snapshot.deposits[0].createdAt, null, 'withdrawal date is not a deposit date');
    assertSanitized(snapshot.deposits);
});

test('late replacement attempts deduplicate without turning pending deposits into success or mixing deployments', async () => {
    seedRuntime({ pendingDeposit: plan(), lateDepositAttempts: [
        { operationId: 'deposit-operation', deploymentId: DEPLOYMENT, noteId: 7,
            amount: 2_000_000, status: 'reverted', transactionHash: REPLACED_HASH, observedAt: 2000 },
        { operationId: 'other', deploymentId: OTHER_DEPLOYMENT, noteId: 7,
            amount: 9_000_000, status: 'submitted_late', transactionHash: HASH,
            secret: 'private-note-secret', observedAt: 2001 }
    ] });
    const rows = (await readBrowserWalletSnapshot(DEPLOYMENT)).deposits;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'pending');
    assert.equal(rows[0].amount, 2_000_000);
    const other = (await readBrowserWalletSnapshot(OTHER_DEPLOYMENT)).deposits;
    assert.equal(other.length, 1);
    assert.equal(other[0].status, 'pending');
    assert.equal(other[0].amount, 9_000_000);
    assertSanitized(other);
});

test('different operations sharing a vault slot retain separate attempts while rebased attempts stay one row', async () => {
    const late = { operationId: 'old-operation', deploymentId: DEPLOYMENT, noteId: 7,
        amount: 1_000_000, status: 'submitted_late', transactionHash: REPLACED_HASH, observedAt: 800 };
    seedRuntime({ pendingDeposit: plan(), lateDepositAttempts: [late, {
        ...late, operationId: 'deposit-operation', noteId: 6, amount: 2_000_000
    }] });
    const snapshot = await readBrowserWalletSnapshot(DEPLOYMENT);
    assert.equal(snapshot.deposits.length, 2);
    assert.equal(snapshot.deposits.find(row => row.operationId === 'deposit-operation').noteId, 7);
    assert.equal(snapshot.deposits.find(row => row.operationId === 'old-operation').amount, 1_000_000);
    assert.equal(new Set(snapshot.deposits.map(row => row.recordId)).size, 2);
    const runtime = makeRuntime();
    await runtime.confirmDeposit(confirmArgs({ transactionHash: HASH }));
    const rows = runtime.snapshot().deposits;
    assert.equal(rows.length, 2);
    assert.equal(rows.find(row => row.operationId === 'deposit-operation').status, 'confirmed');
    assert.equal(rows.find(row => row.operationId === 'old-operation').status, 'pending');
    const reloaded = makeRuntime();
    await reloaded.reload();
    assert.deepEqual(reloaded.snapshot().deposits, rows);
});

const EXPIRY_TS = 2_000_000;
const BLOCK_HASH = `0x${'ef'.repeat(32)}`;
const expiryClaim = (extra = {}) => ({
    noteId: 7, amount: 2_000_000, transactionHash: HASH,
    blockHash: BLOCK_HASH, blockNumber: 50, claimedAt: EXPIRY_TS * 1000,
    ...extra
});

test('expiry metadata migrates from active, archived and background states and preserves unknown legacy expiry', async () => {
    seedRuntime({ state: { ...state(), expiry_ts: EXPIRY_TS } });
    indexedDB.stores.get('archives').set('old-expiry', {
        archiveId: `${DEPLOYMENT}:8:4000`, archivedAt: 4001,
        state: { ...state(8), expiry_ts: EXPIRY_TS + 1 }
    });
    indexedDB.stores.get('withdrawals').set('expiry-withdrawal', {
        recordId: 'expiry-withdrawal', deploymentId: DEPLOYMENT,
        state: { ...state(9), expiry_ts: EXPIRY_TS + 2 }
    });
    indexedDB.stores.get('deposits').set(`${DEPLOYMENT}:deposit:7`, {
        recordId: `${DEPLOYMENT}:deposit:7`, deploymentId: DEPLOYMENT,
        type: 'deposit', status: 'confirmed', noteId: 7, amount: 2_000_000,
        transactionHash: HASH, confirmedAt: 1000
    });
    indexedDB.stores.get('deposits').set(`${DEPLOYMENT}:deposit:10`, {
        recordId: `${DEPLOYMENT}:deposit:10`, deploymentId: DEPLOYMENT,
        type: 'deposit', status: 'confirmed', noteId: 10, amount: 2_000_000
    });
    const rows = (await readBrowserWalletSnapshot(DEPLOYMENT)).deposits;
    assert.deepEqual(new Map(rows.map(row => [row.noteId, row.expiryTs])), new Map([
        [7, EXPIRY_TS], [8, EXPIRY_TS + 1], [9, EXPIRY_TS + 2], [10, null]
    ]));
    assert.equal(rows.find(row => row.noteId === 7).transactionHash, HASH);
    await writeBrowserWallet({ deploymentId: DEPLOYMENT, state: state() });
    indexedDB.stores.get('archives').clear();
    indexedDB.stores.get('withdrawals').clear();
    assert.deepEqual((await readBrowserWalletSnapshot(DEPLOYMENT)).deposits, rows);
    assert.deepEqual(await recordBrowserExpiryClaims(DEPLOYMENT, [expiryClaim({ noteId: 10 })]), []);
    assert.equal((await readBrowserWalletSnapshot(DEPLOYMENT)).deposits.find(row => row.noteId === 10).expiryClaim, undefined);
});

test('expiry claims persist sanitized evidence without changing selected wallet or private recovery state', async () => {
    seedRuntime({ state: { ...state(), expiry_ts: EXPIRY_TS },
        journal: { privateRecovery: 'private-note-secret' },
        lease: { sessionId: 'chat-a', client_request_id: 'request-a' },
        preparedWithdrawal: { proof: 'private-proof' } });
    const before = await readBrowserWallet();
    const runtime = makeRuntime();
    let notifications = 0;
    runtime.addEventListener('change', () => { notifications += 1; });
    const updated = await runtime.rememberExpiryClaims([expiryClaim({
        transactionHash: HASH.toUpperCase().replace('0X', '0x'),
        blockHash: BLOCK_HASH.toUpperCase().replace('0X', '0x'),
        secret: 'private-note-secret', proof: 'private-proof', state: state(),
        withdrawalNullifier: 'private-nullifier'
    })]);
    assert.equal(updated.length, 1);
    assert.deepEqual(updated[0].expiryClaim, {
        transactionHash: HASH, blockHash: BLOCK_HASH, blockNumber: 50,
        claimedAt: EXPIRY_TS * 1000, amount: 2_000_000
    });
    assert.deepEqual(await readBrowserWallet(), before);
    assert.equal(indexedDB.stores.get('archives').size, 0, 'recording evidence never archives a note');
    assert.equal(notifications, 1);
    assert.deepEqual(await runtime.rememberExpiryClaims([expiryClaim()]), []);
    assert.equal(notifications, 1, 'repeated observations do not create duplicate updates');
    const reloaded = makeRuntime();
    const history = await reloaded.getDepositHistory();
    assertSanitized(history);
    assert.deepEqual(history[0].expiryClaim, updated[0].expiryClaim);
    history[0].expiryClaim.amount = 1;
    assert.equal(reloaded.snapshot().deposits[0].expiryClaim.amount, 2_000_000,
        'public snapshots cannot mutate nested runtime evidence');
    await writeBrowserWallet({ ...before, state: { ...before.state, current_balance: 1 } });
    assert.deepEqual((await readBrowserWalletSnapshot(DEPLOYMENT)).deposits[0].expiryClaim, updated[0].expiryClaim);
});

test('expiry claims reject mismatched evidence atomically and cannot create or cross deployment history', async () => {
    await writeBrowserWallet({ deploymentId: DEPLOYMENT, state: { ...state(), expiry_ts: EXPIRY_TS } });
    indexedDB.stores.get('deposits').set(`${OTHER_DEPLOYMENT}:deposit:7`, {
        recordId: `${OTHER_DEPLOYMENT}:deposit:7`, deploymentId: OTHER_DEPLOYMENT,
        type: 'deposit', status: 'confirmed', noteId: 7, amount: 2_000_000, expiryTs: EXPIRY_TS
    });
    const before = clone([...indexedDB.stores.get('deposits').entries()]);
    for (const changes of [
        { amount: 1 }, { transactionHash: '0x123' }, { blockHash: '0x123' },
        { blockNumber: 0 }, { blockNumber: 1.5 }, { claimedAt: EXPIRY_TS * 1000 - 1 },
        { claimedAt: null }, { noteId: -1 }, { deploymentId: OTHER_DEPLOYMENT }
    ]) {
        await assert.rejects(recordBrowserExpiryClaims(DEPLOYMENT, [expiryClaim(), expiryClaim(changes)]),
            /invalid deployment or note identity|does not match/);
        assert.deepEqual([...indexedDB.stores.get('deposits').entries()], before);
    }
    assert.deepEqual(await recordBrowserExpiryClaims(DEPLOYMENT, [expiryClaim({ noteId: 55 })]), []);
    assert.deepEqual(await recordBrowserExpiryClaims('unrelated-deployment', [expiryClaim()]), []);
    await recordBrowserExpiryClaims(DEPLOYMENT, [expiryClaim()]);
    assert.equal((await readBrowserWalletSnapshot(OTHER_DEPLOYMENT)).deposits[0].expiryClaim, undefined);
    await assert.rejects(recordBrowserExpiryClaims(DEPLOYMENT, [expiryClaim({ transactionHash: REPLACED_HASH })]),
        /different finalized expiry claim/);
    assert.equal((await readBrowserWalletSnapshot(DEPLOYMENT)).deposits[0].expiryClaim.transactionHash, HASH);
});

test('an expiry history storage failure retains all recovery state and leaves the observation retryable', async () => {
    await writeBrowserWallet({ deploymentId: DEPLOYMENT,
        state: { ...state(), expiry_ts: EXPIRY_TS }, journal: { recovery: 'private-note-secret' } });
    const before = await readBrowserWalletSnapshot(DEPLOYMENT);
    indexedDB.failNextDepositWrite();
    await assert.rejects(recordBrowserExpiryClaims(DEPLOYMENT, [expiryClaim()]), /history storage failure/);
    assert.deepEqual(await readBrowserWalletSnapshot(DEPLOYMENT), before);
    assert.equal((await recordBrowserExpiryClaims(DEPLOYMENT, [expiryClaim()])).length, 1);
});

test('explicit claimed-note archive preserves private recovery material and durable payment evidence', async () => {
    await writeBrowserWallet({ deploymentId: DEPLOYMENT,
        state: { ...state(), expiry_ts: EXPIRY_TS },
        journal: { recovery: 'private-note-secret' },
        lease: { sessionId: 'chat-a', client_request_id: 'request-a' },
        preparedWithdrawal: { proof: 'private-proof' } });
    const before = await readBrowserWallet();
    await assert.rejects(archiveBrowserWallet('expiry-claimed', 7), /no matching confirmed expiry claim/);
    assert.deepEqual(await readBrowserWallet(), before);
    await recordBrowserExpiryClaims(DEPLOYMENT, [expiryClaim()]);
    await assert.rejects(archiveBrowserWallet('expiry-claimed', 8), /selected private note changed/);
    const runtime = makeRuntime();
    runtime.activeLease = { sessionId: 'chat-a', inFlight: 1 };
    await assert.rejects(runtime.archiveNote('expiry-claimed', 7), /Finish the current response/);
    assert.deepEqual(await readBrowserWallet(), before);
    runtime.activeLease.inFlight = 0;
    await runtime.archiveNote('expiry-claimed', 7);
    const archives = [...indexedDB.stores.get('archives').values()];
    assert.equal(archives.length, 1);
    for (const field of ['state', 'journal', 'lease', 'preparedWithdrawal', 'pendingDeposit']) {
        assert.deepEqual(archives[0][field], before[field]);
    }
    const empty = await readBrowserWallet();
    assert.equal(empty.state, null);
    assert.equal(empty.journal, null);
    assert.equal(empty.lease, null);
    assert.equal(runtime.activeLease, null);
    await writeBrowserWallet({ deploymentId: DEPLOYMENT, state: { ...state(8), expiry_ts: EXPIRY_TS + 1 } });
    const rows = (await readBrowserWalletSnapshot(DEPLOYMENT)).deposits;
    assert.equal(rows.length, 2);
    assert.equal(rows.find(row => row.noteId === 7).expiryClaim.transactionHash, HASH);
    assertSanitized(rows);
});
