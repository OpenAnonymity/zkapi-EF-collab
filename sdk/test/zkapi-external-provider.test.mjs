import assert from 'node:assert/strict';
import test from 'node:test';
import { ZkapiClient } from '../services/zkapiClient.js';
import runtime from '../services/browserWalletRuntime.js';
import codec from '../wallet.js';

const FROM = `0x${'11'.repeat(20)}`;
const VAULT = `0x${'22'.repeat(20)}`;
const TOKEN = `0x${'33'.repeat(20)}`;
const HASH = `0x${'44'.repeat(32)}`;
const COMMITMENT = `0x${'55'.repeat(32)}`;
const funding = { chain_id: 1, contract_address: VAULT, demo_billing_token_address: TOKEN };
const gate = () => {
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    return { promise, resolve };
};
const client = () => {
    const result = new ZkapiClient();
    result.config = { funding };
    result.browserMode = true;
    return result;
};

function provider(overrides = {}) {
    const calls = [];
    const result = {
        calls,
        async request(request) {
            calls.push(request);
            if (overrides[request.method]) return overrides[request.method](request);
            if (request.method === 'eth_chainId') return '0x1';
            if (request.method === 'eth_call') return '0x1';
            if (request.method === 'eth_estimateGas') return '0x5208';
            if (request.method === 'eth_getTransactionCount') return '0x5';
            if (request.method === 'eth_sendTransaction') return HASH;
            if (request.method === 'eth_getTransactionReceipt') return { transactionHash: HASH, status: '0x1' };
            assert.fail(`Unexpected RPC ${request.method}`);
        }
    };
    return result;
}

function recoveryHarness(t, kind = 'deposit') {
    const state = { pendingDeposit: null, preparedWithdrawal: null };
    for (const [key, value] of Object.entries({ runtime: state, withdrawals: [], deposits: [], manifest: { deployment_id: 'test' } })) {
        const original = runtime[key];
        runtime[key] = value;
        t.after(() => { runtime[key] = original; });
    }
    t.mock.method(runtime, 'reload', async () => runtime.runtime);
    const c = client();
    t.mock.method(c, 'refresh', async () => c.snapshot());
    const p = provider();
    p.acks = [];
    p.acknowledgeTransaction = async hash => { p.acks.push(hash); };
    c.setWalletProvider(p);
    const submission = { operationId: 'op', submissionId: 'submission', noteId: 7,
        deploymentId: 'test', chainId: 1, contractAddress: VAULT, amount: 2000000,
        commitment: COMMITMENT, mode: 'mutual', destination: FROM, finalBalance: 1500000,
        clearanceReserved: true, withdrawalNullifier: '0x7', recordId: 'record', generation: 2 };
    const deposit = { operationId: 'op', submissionId: 'submission', next_note_id: 7,
        amount: 2000000, commitment: COMMITMENT, secret: 'private-secret',
        zero_path: Array(32).fill('0x0'), submissionFrom: FROM, submissionNonce: 5 };
    const plan = { operationId: 'op', submissionId: 'submission', noteId: 7,
        mode: 'mutual', destination: FROM, submissionFrom: FROM, submissionNonce: 5,
        siblings: Array(32).fill('0x0'), proof: { backend: 'groth16_bn254', proof: Buffer.alloc(256).toString('base64') },
        public_inputs: { protocol_version: 2, chain_id: 1, contract_address: VAULT,
            active_root: '0x1', state_signing_key_x: '0x1', state_signing_key_y: '0x1',
            clearance_signing_key_x: '0x1', clearance_signing_key_y: '0x1', note_id: 7,
            final_balance: 1500000, destination: FROM, withdrawal_nullifier: '0x7',
            has_clearance: true, withdrawal_tag: '0x8' } };
    const record = { recordId: 'record', noteId: 7, destination: FROM, mode: 'mutual',
        startOperationId: 'op', startSubmissionId: 'submission', startSubmissionFrom: FROM,
        startSubmissionNonce: 5, preparedWithdrawal: plan,
        finalizeOperationId: 'op', finalizeSubmissionId: 'submission', finalizeSubmissionFrom: FROM,
        finalizeSubmissionNonce: 5, finalizeGeneration: 2 };
    let data;
    if (kind === 'deposit') {
        state.pendingDeposit = deposit;
        data = codec.encodeDeposit(deposit, 2000000n);
    } else if (kind === 'token') {
        data = codec.callData(codec.ABI.approve, [codec.addressWord(VAULT), codec.abiWord(2000000)]);
    } else {
        if (kind === 'withdrawal') state.preparedWithdrawal = plan;
        else runtime.withdrawals = [record];
        data = kind === 'finalization' ? codec.encodeFinalizeEscape(7)
            : codec.encodeWithdrawal(plan, 'mutual', FROM, VAULT);
    }
    const context = c.externalRecoveryContext(kind === 'token' ? null : { kind, submission });
    const transaction = { from: FROM, to: kind === 'token' ? TOKEN : VAULT, data, value: '0x0', nonce: '0x5' };
    const actual = { ...transaction, input: data, hash: HASH, chainId: '0x1' };
    const originalRequest = p.request;
    p.request = async request => request.method === 'eth_getTransactionByHash'
        ? actual : originalRequest(request);
    const remembers = Object.fromEntries(['rememberPendingDepositTransaction', 'rememberPreparedWithdrawalTransaction',
        'rememberBackgroundWithdrawalTransaction', 'rememberWithdrawalFinalization'].map(name => [name,
        t.mock.method(runtime, name, async () => {})]));
    return { c, p, state, deposit, plan, record, context, transaction, actual, remembers,
        resume: () => c.resumeExternalTransaction({ transaction, hash: HASH, context }) };
}

test('explicit providers are instance scoped and never change the injected provider', async t => {
    const old = globalThis.ethereum;
    const injected = provider({ eth_call: () => '0x2' });
    globalThis.ethereum = injected;
    t.after(() => { globalThis.ethereum = old; });
    const a = client(); const b = client(); const manual = provider();
    a.setWalletProvider(manual);
    assert.equal(await a.readContractUint(VAULT, '0x1234'), 1n);
    assert.equal(await b.readContractUint(VAULT, '0x1234'), 2n);
    assert.equal(globalThis.ethereum, injected);
    a.setWalletProvider(null);
    assert.equal(await a.readContractUint(VAULT, '0x1234'), 2n);
    assert.throws(() => a.setWalletProvider({}), /request/);
});

test('provider changes are blocked across RPC waits, nested journal waits and pending saved transactions', async () => {
    const wait = gate(); const c = client(); const p = provider(); const next = provider();
    c.setWalletProvider(p);
    const result = c.sendContractTransaction(FROM, VAULT, '0x1234', async () => {}, async () => wait.promise);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    assert.equal(c.walletProviderBusy, true);
    assert.equal(c.setWalletProvider(p), p);
    assert.throws(() => c.setWalletProvider(next), { code: 'wallet_provider_busy' });
    wait.resolve(); await result;
    p.hasPendingTransaction = true;
    assert.throws(() => c.setWalletProvider(next), { code: 'wallet_provider_busy' });
    p.hasPendingTransaction = false;
    c.setWalletProvider(next);
    assert.equal(c.ethereum, next);
});

test('a late injected-provider replacement cannot split one operation across providers', async t => {
    const old = globalThis.ethereum; const wait = gate();
    const original = provider({ eth_chainId: async () => { await wait.promise; return '0x1'; } });
    globalThis.ethereum = original;
    t.after(() => { globalThis.ethereum = old; });
    const c = client();
    const result = c.sendContractTransaction(FROM, VAULT, '0x1234');
    globalThis.ethereum = provider({ eth_estimateGas: () => { throw new Error('wrong provider'); } });
    wait.resolve(); await result;
    assert(original.calls.some(call => call.method === 'eth_sendTransaction'));
});

test('detached provider events do not alter the currently selected address', t => {
    const c = client(); const p = provider(); const events = new Map();
    t.mock.method(c, 'emitChange', () => {});
    p.on = (event, handler) => events.set(event, handler);
    c.setWalletProvider(p);
    events.get('accountsChanged')([FROM]);
    assert.equal(c.walletAddress, FROM);
    c.setWalletProvider(provider());
    events.get('accountsChanged')([FROM]);
    assert.equal(c.walletAddress, null);
});

test('manual request metadata excludes secrets and ack follows the SDK journal before receipt', async () => {
    const c = client(); const sequence = [];
    const p = provider({ eth_sendTransaction: request => { sequence.push('send');
        assert.equal(request.zkapiRecovery.kind, 'deposit');
        assert(!JSON.stringify(request.zkapiRecovery).includes('private-secret'));
        assert(!JSON.stringify(request.zkapiRecovery).includes('proof-bytes')); return HASH; },
    eth_getTransactionReceipt: () => { sequence.push('receipt'); return { status: '0x1' }; } });
    p.acknowledgeTransaction = async () => sequence.push('ack');
    c.setWalletProvider(p);
    await c.sendContractTransaction(FROM, VAULT, '0x1234', async () => sequence.push('journal'), null, 5,
        { kind: 'deposit', submission: { operationId: 'op', submissionId: 'sub', secret: 'private-secret', plan: { proof: 'proof-bytes' } } });
    assert.deepEqual(sequence, ['send', 'journal', 'ack', 'receipt']);
});

test('journal persistence failure retains the host transaction for reload', async () => {
    const c = client(); const p = provider(); let acked = false;
    p.acknowledgeTransaction = async () => { acked = true; }; c.setWalletProvider(p);
    await assert.rejects(c.sendContractTransaction(FROM, VAULT, '0x1234', async () => { throw new Error('disk failed'); }),
        error => error.transactionHash === HASH && error.transactionStage === 'journal');
    assert.equal(acked, false);
});

test('deposit reload rehydrates its private secret only inside the SDK journal', async t => {
    const h = recoveryHarness(t);
    assert.equal(h.context.secret, undefined);
    assert.equal((await h.resume()).status, 'submitted');
    const [hash, reference, metadata] = h.remembers.rememberPendingDepositTransaction.mock.calls[0].arguments;
    assert.equal(hash, HASH); assert.equal(reference.secret, 'private-secret');
    assert.deepEqual(metadata, { from: FROM, nonce: 5 }); assert.deepEqual(h.p.acks, [HASH]);
});

for (const kind of ['withdrawal', 'background-withdrawal', 'background-replacement', 'finalization']) {
    test(`${kind} reload uses its original SDK journal path`, async t => {
        const h = recoveryHarness(t, kind);
        assert.equal((await h.resume()).kind, kind);
        const name = kind === 'finalization' ? 'rememberWithdrawalFinalization'
            : kind === 'background-withdrawal' ? 'rememberBackgroundWithdrawalTransaction'
                : 'rememberPreparedWithdrawalTransaction';
        assert.equal(h.remembers[name].mock.calls.length, 1);
        assert.deepEqual(h.p.acks, [HASH]);
    });
}

for (const [field, value] of Object.entries({ from: TOKEN, to: TOKEN, input: '0xdeadbeef', nonce: '0x6', value: '0x1', chainId: '0x2', hash: `0x${'66'.repeat(32)}` })) {
    test(`reload rejects a transaction with mismatched ${field}`, async t => {
        const h = recoveryHarness(t); h.actual[field] = value;
        await assert.rejects(h.resume(), /does not match/);
        assert.equal(h.remembers.rememberPendingDepositTransaction.mock.calls.length, 0);
        assert.deepEqual(h.p.acks, []);
    });
}

for (const field of ['operationId', 'submissionId', 'submissionFrom', 'submissionNonce']) {
    test(`reload rejects changed durable deposit ${field}`, async t => {
        const h = recoveryHarness(t); h.deposit[field] = field === 'submissionNonce' ? 6 : 'changed';
        await assert.rejects(h.resume(), /no longer matches/); assert.deepEqual(h.p.acks, []);
    });
}

test('reload cannot attach into a different finalization generation', async t => {
    const h = recoveryHarness(t, 'finalization'); h.record.finalizeGeneration += 1;
    await assert.rejects(h.resume(), /no longer matches/); assert.deepEqual(h.p.acks, []);
});

test('SDK hash attachment remains idempotent if host acknowledgement previously failed', async t => {
    const h = recoveryHarness(t);
    h.remembers.rememberPendingDepositTransaction.mock.mockImplementation(async () => { h.deposit.transactionHash = HASH; });
    h.p.acknowledgeTransaction = async () => { throw new Error('host disk failed'); };
    await assert.rejects(h.resume(), /host disk failed/);
    h.p.acknowledgeTransaction = async hash => h.p.acks.push(hash);
    await h.resume();
    assert.equal(h.remembers.rememberPendingDepositTransaction.mock.calls.length, 1);
    assert.deepEqual(h.p.acks, [HASH]);
});

test('an active SDK sender owns hash delivery until it finishes', async t => {
    const h = recoveryHarness(t); h.c.depositPromise = Promise.resolve();
    await assert.rejects(h.resume(), /original wallet action/);
    assert.equal(h.remembers.rememberPendingDepositTransaction.mock.calls.length, 0);
});

test('token resumption waits for a successful receipt before acknowledging', async t => {
    const h = recoveryHarness(t, 'token'); const wait = gate();
    t.mock.method(h.c, 'waitForReceipt', async () => { await wait.promise; return { status: '0x1' }; });
    const result = h.resume(); for (let i = 0; i < 8; i += 1) await Promise.resolve();
    assert.deepEqual(h.p.acks, []); wait.resolve();
    assert.equal((await result).status, 'confirmed'); assert.deepEqual(h.p.acks, [HASH]);
});

for (const finalized of [false, true]) {
    test(`reverted token request is acknowledged only after finality (${finalized})`, async t => {
        const h = recoveryHarness(t, 'token');
        const error = Object.assign(new Error('reverted'), { transactionReceipt: { status: '0x0' } });
        t.mock.method(h.c, 'waitForReceipt', async () => { throw error; });
        t.mock.method(h.c, 'browserRevertedReceiptFinality', async () => ({ finalized }));
        await assert.rejects(h.resume(), /reverted/);
        assert.deepEqual(h.p.acks, finalized ? [HASH] : []);
    });
}

test('selected withdrawal hash can arrive after canonical recovery moved its plan to history', async t => {
    const h = recoveryHarness(t, 'withdrawal');
    h.state.preparedWithdrawal = null;
    runtime.withdrawals = [{ ...h.record, phase: 'closed_unconfirmed', transactionHash: null }];
    assert.equal((await h.resume()).status, 'submitted');
    assert.equal(h.remembers.rememberPreparedWithdrawalTransaction.mock.calls.length, 1,
        'the existing late-attempt journal will join the moved note');
    assert.deepEqual(h.p.acks, [HASH]);
});

test('deposit hash can arrive after read-only recovery confirmed the same saved note', async t => {
    const h = recoveryHarness(t);
    h.state.pendingDeposit = null;
    runtime.deposits = [{ operationId: 'op', noteId: 7, amount: 2000000, status: 'confirmed' }];
    const receipt = { transactionHash: HASH, status: '0x1', logs: [{ address: VAULT,
        topics: [codec.ABI.noteDeposited, `0x${codec.abiWord(7)}`, COMMITMENT],
        data: `0x${codec.abiWord(2000000)}${codec.abiWord(12345)}${codec.abiWord(123)}` }] };
    const original = h.p.request;
    h.p.request = request => request.method === 'eth_getTransactionReceipt' ? Promise.resolve(receipt) : original(request);
    await h.resume();
    assert.equal(h.remembers.rememberPendingDepositTransaction.mock.calls.length, 0);
    assert.deepEqual(h.p.acks, [HASH]);
});

for (const kind of ['background-withdrawal', 'background-replacement']) {
    test(`${kind} accepts the retained original claim after an exact-nonce takeover`, async t => {
        const h = recoveryHarness(t, kind);
        h.record.supersededStartSubmissionClaims = [{ operationId: 'op', submissionId: 'submission', from: FROM, nonce: 5 }];
        h.record.startSubmissionId = 'replacement';
        h.plan.submissionId = 'replacement';
        await h.resume();
        const name = kind === 'background-withdrawal' ? 'rememberBackgroundWithdrawalTransaction'
            : 'rememberPreparedWithdrawalTransaction';
        assert.equal(h.remembers[name].mock.calls.length, 1);
        assert.equal(h.remembers[name].mock.calls[0].arguments[1].submissionId, 'submission');
        assert.deepEqual(h.p.acks, [HASH]);
    });
}

test('a retained superseded claim still rejects a different sender nonce', async t => {
    const h = recoveryHarness(t, 'background-withdrawal');
    h.record.supersededStartSubmissionClaims = [{ operationId: 'op', submissionId: 'submission', from: FROM, nonce: 6 }];
    h.record.startSubmissionId = 'replacement'; h.plan.submissionId = 'replacement';
    await assert.rejects(h.resume(), /no longer matches/); assert.deepEqual(h.p.acks, []);
});

for (const kind of ['deposit', 'withdrawal', 'finalization']) {
    test(`${kind} accepts its retained earlier ambiguous request after explicit retry`, async t => {
        const h = recoveryHarness(t, kind);
        if (kind === 'finalization') {
            h.record.ambiguousFinalizationSubmissions = [{ operationId: 'op', submissionId: 'submission', generation: 2 }];
            h.record.finalizeSubmissionId = 'replacement'; h.record.finalizeGeneration = 3;
        } else {
            const plan = kind === 'deposit' ? h.deposit : h.plan;
            plan.ambiguousSubmissions = [{ submissionId: 'submission' }]; plan.submissionId = 'replacement';
        }
        await h.resume(); assert.deepEqual(h.p.acks, [HASH]);
    });
}
