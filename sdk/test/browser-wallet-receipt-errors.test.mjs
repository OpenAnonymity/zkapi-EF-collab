import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeWalletError, walletErrorMessage } from '../services/zkapiWalletError.mjs';

const values = new Map();
globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
};
globalThis.sessionStorage = globalThis.localStorage;
globalThis.window = new EventTarget();
globalThis.window.location = { search: '', hostname: 'localhost' };
globalThis.zkapiWallet = (await import('../wallet.js')).default;
const { ZkapiClient } = await import('../services/zkapiClient.js');
const { default: runtime } = await import('../services/browserWalletRuntime.js');

const HASH = '0x34e298c17052af34acbbd1f1fd0e910f023af7938c5ff1656dd4bd669140ae48';
const VAULT = `0x${'12'.repeat(20)}`;
const DESTINATION = `0x${'34'.repeat(20)}`;

function receipt(overrides = {}) {
    return {
        transactionHash: HASH,
        status: '0x1',
        blockNumber: '0x18b6939',
        logs: [{
            address: VAULT,
            topics: [globalThis.zkapiWallet.ABI.mutualCloseEvent,
                `0x${globalThis.zkapiWallet.abiWord(18)}`],
            data: `0x${globalThis.zkapiWallet.abiWord(99)}${globalThis.zkapiWallet.abiWord(1972567)}${globalThis.zkapiWallet.addressWord(DESTINATION)}`
        }],
        ...overrides
    };
}

test('plain and nested provider errors retain useful messages and transaction classification', () => {
    const plain = { code: 4001, message: 'User rejected the request.', data: { reason: 'Canceled' } };
    const error = normalizeWalletError(plain);
    assert.ok(error instanceof Error);
    assert.equal(error.message, plain.message);
    assert.equal(error.code, 4001);
    assert.equal(error.cause, plain);
    assert.equal(error.data, plain.data);
    assert.equal(walletErrorMessage({ error: { message: 'RPC temporarily unavailable' } }), 'RPC temporarily unavailable');
    assert.equal(walletErrorMessage({ message: { message: 'Receipt lookup failed' } }), 'Receipt lookup failed');
    const cyclic = {};
    cyclic.cause = cyclic;
    assert.equal(walletErrorMessage(cyclic), 'The wallet could not complete this request.');
    assert.equal(walletErrorMessage(new Error('[object Object]')), 'The wallet could not complete this request.');
});

test('a transient receipt RPC failure recovers without resending or reporting a failed payment', async t => {
    const client = new ZkapiClient();
    const mined = receipt();
    const calls = [];
    t.mock.method(globalThis, 'setTimeout', callback => { queueMicrotask(callback); return 1; });
    globalThis.ethereum = {
        async request(request) {
            calls.push(request);
            assert.equal(request.method, 'eth_getTransactionReceipt');
            assert.deepEqual(request.params, [HASH]);
            if (calls.length === 1) throw { code: -32603, message: 'Internal JSON-RPC error.' };
            if (calls.length === 2) return null;
            return mined;
        }
    };
    assert.equal(await client.waitForReceipt(HASH), mined);
    assert.equal(calls.length, 3);
});

test('unavailable receipt RPC retains the submitted hash and readable error after bounded retries', async t => {
    const client = new ZkapiClient();
    client.config = { funding: { chain_id: 1 } };
    let receiptReads = 0;
    let sends = 0;
    let journaledHash = null;
    t.mock.method(globalThis, 'setTimeout', callback => { queueMicrotask(callback); return 1; });
    globalThis.ethereum = {
        async request({ method }) {
            if (method === 'eth_chainId') return '0x1';
            if (method === 'eth_estimateGas') return '0x50000';
            if (method === 'eth_sendTransaction') { sends += 1; return HASH; }
            if (method === 'eth_getTransactionReceipt') {
                receiptReads += 1;
                throw { code: -32603, message: 'Receipt service temporarily unavailable' };
            }
            throw new Error(`Unexpected RPC ${method}`);
        }
    };
    await assert.rejects(client.sendContractTransaction(DESTINATION, VAULT, '0x00', hash => { journaledHash = hash; }), error => {
        assert.equal(error.message, 'Receipt service temporarily unavailable');
        assert.equal(error.code, -32603);
        assert.equal(error.transactionStage, 'receipt');
        assert.equal(error.transactionHash, HASH);
        assert.equal(error.broadcastPossible, true);
        return true;
    });
    assert.equal(sends, 1);
    assert.equal(receiptReads, 3);
    assert.equal(journaledHash, HASH);
});

test('definite wallet rejection preserves its code and never enters receipt polling', async () => {
    const client = new ZkapiClient();
    globalThis.ethereum = {
        async request({ method }) {
            if (method === 'eth_estimateGas') return '0x50000';
            if (method === 'eth_sendTransaction') throw { code: 4001, message: 'User rejected the request.' };
            throw new Error(`Unexpected RPC ${method}`);
        }
    };
    await assert.rejects(client.sendContractTransaction(DESTINATION, VAULT, '0x00'), error => {
        assert.equal(error.code, 4001);
        assert.equal(error.message, 'User rejected the request.');
        assert.equal(error.broadcastPossible, false);
        return true;
    });
});

test('mined reverts remain failures with their receipt attached', async () => {
    const reverted = receipt({ status: '0x0' });
    globalThis.ethereum = { request: async () => reverted };
    await assert.rejects(new ZkapiClient().waitForReceipt(HASH), error => {
        assert.match(error.message, /reverted/);
        assert.equal(error.transactionReceipt, reverted);
        return true;
    });
});

test('mutual-close recovery of a mined payment completes through event and vault verification', async t => {
    const client = new ZkapiClient();
    const plan = {
        mode: 'mutual', phase: 'submitted', destination: DESTINATION,
        transactionHash: HASH, clearanceReserved: true,
        public_inputs: { note_id: 18, final_balance: 1972567 }
    };
    client.browserMode = true;
    client.config = { funding: { chain_id: 1, contract_address: VAULT } };
    client.wallet = { has_note: true, note: { note_id: 18, current_balance: 1972567 } };
    t.mock.method(client, 'settleActiveLease', async () => {});
    t.mock.method(client, 'connectWallet', async () => DESTINATION);
    t.mock.method(client, 'waitForReceipt', async () => { throw { code: -32603, message: 'Receipt provider unavailable' }; });
    t.mock.method(client, 'refresh', async () => client.snapshot());
    let vaultChecks = 0;
    t.mock.method(client, 'readBrowserWithdrawalStatus', async noteId => {
        assert.equal(noteId, 18);
        vaultChecks += 1;
        return { status: 'closed', observed_block: 25913660 };
    });
    t.mock.method(runtime, 'currentPreparedWithdrawal', async () => plan);
    t.mock.method(runtime, 'getDepositHistory', async () => []);
    t.mock.method(runtime, 'snapshot', () => ({ runtime: { preparedWithdrawal: plan } }));
    const detached = [];
    t.mock.method(runtime, 'detachClosedWithdrawal', async record => { detached.push(record); });
    const mined = receipt();
    globalThis.ethereum = { request: async ({ method, params }) => {
        assert.equal(method, 'eth_getTransactionReceipt');
        assert.deepEqual(params, [HASH]);
        return mined;
    } };
    const result = await client.performWithdrawal('mutual');
    assert.equal(result.status, 'closed');
    assert.equal(result.receipt, mined);
    assert.equal(vaultChecks, 1);
    assert.equal(detached.length, 1);
    assert.equal(detached[0].transactionHash, HASH);
    assert.equal(detached[0].finalBalance, 1972567);
    assert.equal(detached[0].closeBlockNumber, Number(BigInt(mined.blockNumber)));
    assert.equal(detached[0].payoutVerified, true);
    assert.equal(client.withdrawal, null);

    // The matching payment is already mined; an unavailable second RPC must
    // leave its submitted plan available for background/reload reconciliation.
    const confirmedStatus = client.readBrowserWithdrawalStatus;
    client.readBrowserWithdrawalStatus = async () => { throw { code: -32603, message: 'RPC temporarily unavailable' }; };
    await assert.rejects(client.performWithdrawal('mutual'), error => {
        assert.equal(error.withdrawalConfirmationPending, true);
        assert.equal(error.transactionHash, HASH);
        assert.match(error.shortMessage, /transaction was mined.*checked automatically/i);
        assert.equal(error.message, 'RPC temporarily unavailable');
        return true;
    });
    assert.equal(detached.length, 1);
    assert.equal((await runtime.currentPreparedWithdrawal()).transactionHash, HASH);
    client.readBrowserWithdrawalStatus = confirmedStatus;

    // A successful receipt for another note is not proof of this payout.
    mined.logs[0].topics[1] = `0x${globalThis.zkapiWallet.abiWord(19)}`;
    await assert.rejects(client.performWithdrawal('mutual'), /event did not match/);
    assert.equal(detached.length, 1);
});
