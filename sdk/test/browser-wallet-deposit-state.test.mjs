import assert from 'node:assert/strict';
import test from 'node:test';

const values = new Map();
globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
};
globalThis.sessionStorage = globalThis.localStorage;
globalThis.window = new EventTarget();
globalThis.window.location = { search: '', hostname: 'localhost' };
const { ZkapiClient } = await import('../services/zkapiClient.js');
const { default: runtime } = await import('../services/browserWalletRuntime.js');
const { default: wallet } = await import('../wallet.js');
const { ABI, callData, addressWord } = wallet;

const ACCOUNT = `0x${'11'.repeat(20)}`;
const TOKEN = `0x${'22'.repeat(20)}`;
const VAULT = `0x${'33'.repeat(20)}`;
const BLOCK_HASH = `0x${'44'.repeat(32)}`;
const MINT_HASH = `0x${'55'.repeat(32)}`;
const DEPOSIT_HASH = `0x${'66'.repeat(32)}`;
const BLOCK = '0x123';
const RECEIPT = { status: '0x1', blockNumber: BLOCK, blockHash: BLOCK_HASH, transactionHash: MINT_HASH };
const BALANCE_CALL = callData(ABI.balanceOf, [addressWord(ACCOUNT)]);

function client() {
    const instance = new ZkapiClient();
    instance.config = { funding: {
        chain_id: 11155111, contract_address: VAULT,
        demo_billing_token_address: TOKEN, demo_mint_enabled: true
    } };
    return instance;
}

function instantSleeps(t) {
    t.mock.method(globalThis, 'setTimeout', callback => { queueMicrotask(callback); return 1; });
}

test('a mined mint continues to deposit despite stale latest balance and lagging receipt-block reads, without reminting', async t => {
    instantSleeps(t);
    const instance = client();
    instance.browserMode = true;
    const plan = { phase: 'prepared', next_note_id: 55, commitment: '0x88', zero_path: Array(32).fill('0x0') };
    t.mock.method(instance, 'connectWallet', async () => ACCOUNT);
    t.mock.method(runtime, 'pendingDeposit', async () => null);
    t.mock.method(runtime, 'prepareDeposit', async amount => { assert.equal(amount, 5_000_000); return plan; });
    t.mock.method(runtime, 'refreshPendingDeposit', async (amount, root) => {
        assert.equal(amount, 5_000_000);
        assert.equal(root, 0x77n);
        return plan;
    });
    t.mock.method(runtime, 'claimPendingDepositSubmission', async () => ({ operationId: 'test-deposit' }));
    t.mock.method(runtime, 'rememberPendingDepositSubmissionMetadata', async () => {});
    t.mock.method(runtime, 'rememberPendingDepositTransaction', async () => {});
    t.mock.method(instance, 'confirmBrowserDepositReceipt', async (_plan, receipt) => {
        assert.equal(receipt.transactionHash, DEPOSIT_HASH);
        return { status: 'confirmed' };
    });
    let pinnedBalanceReads = 0;
    let latestBalanceReads = 0;
    const sends = [];
    globalThis.ethereum = { request: async ({ method, params }) => {
        if (method === 'eth_chainId') return '0xaa36a7';
        if (method === 'eth_getBlockByNumber') {
            assert.deepEqual(params, [BLOCK, false]);
            return { hash: BLOCK_HASH };
        }
        if (method === 'eth_call') {
            const [{ data }, block] = params;
            if (data === BALANCE_CALL) {
                if (block === 'latest') { latestBalanceReads += 1; return `0x${4_992_540n.toString(16)}`; } // 4.992540
                assert.equal(block, BLOCK);
                pinnedBalanceReads += 1;
                if (pinnedBalanceReads === 1) throw { code: -32000, message: 'header not found' };
                if (pinnedBalanceReads === 2) return `0x${4_992_540n.toString(16)}`;
                return '0x4c4b40'; // 5.000000
            }
            if (data.startsWith(`0x${ABI.allowance}`)) return '0x4c4b40';
            if (data === `0x${ABI.currentRoot}`) return '0x77';
        }
        if (method === 'eth_estimateGas') return '0x50000';
        if (method === 'eth_getTransactionCount') return '0x1';
        if (method === 'eth_sendTransaction') {
            sends.push(params[0]);
            return sends.length === 1 ? MINT_HASH : DEPOSIT_HASH;
        }
        if (method === 'eth_getTransactionReceipt') return { ...RECEIPT, transactionHash: params[0] };
        throw new Error(`Unexpected RPC ${method}`);
    } };
    assert.deepEqual(await instance.performDeposit('5'), { status: 'confirmed' });
    assert.equal(latestBalanceReads, 1);
    assert.equal(pinnedBalanceReads, 3);
    assert.equal(sends.length, 2, 'only mint and deposit may be submitted');
    assert.equal(sends[0].to, TOKEN);
    assert.ok(sends[0].data.startsWith(`0x${ABI.mint}`));
    assert.equal(BigInt(`0x${sends[0].data.slice(-64)}`), 7460n);
    assert.equal(sends[1].to, VAULT);
    assert.ok(sends[1].data.startsWith(`0x${ABI.deposit}`));
});

test('post-mint balance synchronization stops after bounded reads without issuing a transaction', async t => {
    instantSleeps(t);
    let reads = 0;
    globalThis.ethereum = { request: async ({ method, params }) => {
        if (method === 'eth_chainId') return '0xaa36a7';
        if (method === 'eth_getBlockByNumber') return { hash: BLOCK_HASH };
        assert.equal(method, 'eth_call');
        assert.equal(params[1], BLOCK);
        reads += 1;
        return '0x0';
    } };
    await assert.rejects(client().readContractUintAtReceipt(TOKEN, BALANCE_CALL, RECEIPT, 5_000_000n),
        error => error.code === 'wallet_state_pending');
    assert.equal(reads, 20);
});

test('a receipt-block hash mismatch fails before trusting its token balance', async () => {
    globalThis.ethereum = { request: async ({ method }) => {
        if (method === 'eth_chainId') return '0xaa36a7';
        assert.equal(method, 'eth_getBlockByNumber');
        return { hash: `0x${'77'.repeat(32)}` };
    } };
    await assert.rejects(client().readContractUintAtReceipt(TOKEN, BALANCE_CALL, RECEIPT, 1n),
        error => error.code === 'wallet_receipt_reorg');
});

test('a temporarily unavailable receipt block is retried before reading state', async t => {
    instantSleeps(t);
    let blockReads = 0;
    let stateReads = 0;
    globalThis.ethereum = { request: async ({ method }) => {
        if (method === 'eth_chainId') return '0xaa36a7';
        if (method === 'eth_getBlockByNumber') return ++blockReads === 1 ? null : { hash: BLOCK_HASH };
        assert.equal(method, 'eth_call');
        stateReads += 1;
        return '0x4c4b40';
    } };
    assert.equal(await client().readContractUintAtReceipt(TOKEN, BALANCE_CALL, RECEIPT, 1n), 5_000_000n);
    assert.equal(blockReads, 3);
    assert.equal(stateReads, 1);
});

test('a reorg between canonical check and state read rejects an otherwise sufficient balance', async () => {
    let blockReads = 0;
    globalThis.ethereum = { request: async ({ method }) => {
        if (method === 'eth_chainId') return '0xaa36a7';
        if (method === 'eth_getBlockByNumber') return { hash: ++blockReads === 1 ? BLOCK_HASH : `0x${'77'.repeat(32)}` };
        assert.equal(method, 'eth_call');
        return '0x4c4b40';
    } };
    await assert.rejects(client().readContractUintAtReceipt(TOKEN, BALANCE_CALL, RECEIPT, 1n),
        error => error.code === 'wallet_receipt_reorg');
    assert.equal(blockReads, 2);
});

test('a different network fails before any receipt-block or token-state reads', async () => {
    globalThis.ethereum = { request: async ({ method }) => {
        assert.equal(method, 'eth_chainId');
        return '0x1';
    } };
    await assert.rejects(client().readContractUintAtReceipt(TOKEN, BALANCE_CALL, RECEIPT, 1n),
        error => error.code === 'wrong_network');
});

test('switching networks during the read never accepts the other chain’s balance', async () => {
    let switched = false;
    globalThis.ethereum = { request: async ({ method }) => {
        if (method === 'eth_chainId') return switched ? '0x1' : '0xaa36a7';
        if (method === 'eth_getBlockByNumber') return { hash: BLOCK_HASH };
        assert.equal(method, 'eth_call');
        switched = true;
        return '0x4c4b40';
    } };
    await assert.rejects(client().readContractUintAtReceipt(TOKEN, BALANCE_CALL, RECEIPT, 1n),
        error => error.code === 'wrong_network');
});

test('reverted or incomplete receipts never authorize a post-mint state read', async () => {
    globalThis.ethereum = { request: async () => { throw new Error('No RPC expected'); } };
    for (const receipt of [{ ...RECEIPT, status: '0x0' }, { ...RECEIPT, blockHash: null }, { ...RECEIPT, blockNumber: 'latest' }]) {
        await assert.rejects(client().readContractUintAtReceipt(TOKEN, BALANCE_CALL, receipt), /valid confirmed block/);
    }
});
