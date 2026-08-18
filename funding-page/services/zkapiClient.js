import browserWalletRuntime from './browserWalletRuntime.js';
import { contractEstimateError, contractRevertSelector } from './zkapiContractError.mjs';

const WITHDRAWAL_STORAGE_KEY = 'zkapi-withdrawal-v2';
const SESSION_HEADER = 'x-zkapi-session-id';

const walletCodec = globalThis.zkapiWallet;
if (!walletCodec) {
    throw new Error('zkAPI wallet codec was not loaded before the OA Chat client.');
}

const {
    ABI,
    abiWord,
    addressWord,
    callData,
    encodeDeposit,
    encodeFinalizeEscape,
    encodeWithdrawal,
    escapePeriodBadge,
    escapePeriodLabel,
    escapePeriodPhrase,
    formatTokenAmount,
    parseNoteDeposited,
    parseTokenAmount,
    parseWithdrawalReceipt
} = walletCodec;

class ZkapiHttpError extends Error {
    constructor(message, status, code, data = null) {
        super(message);
        this.name = 'ZkapiHttpError';
        this.status = status;
        this.code = code;
        this.data = data;
    }
}

function readStoredWithdrawal() {
    try {
        const stored = JSON.parse(localStorage.getItem(WITHDRAWAL_STORAGE_KEY) || 'null');
        return stored?.noteId != null && ['prepared', 'pending'].includes(stored.phase)
            ? stored
            : null;
    } catch {
        localStorage.removeItem(WITHDRAWAL_STORAGE_KEY);
        return null;
    }
}

class ZkapiClient extends EventTarget {
    constructor() {
        super();
        this.config = null;
        this.wallet = null;
        this.walletAddress = null;
        this.withdrawal = readStoredWithdrawal();
        this.challengePeriodSeconds = 24 * 60 * 60;
        this.loading = false;
        this.lastError = null;
        this.initialized = false;
        this.initPromise = null;
        this.refreshTimer = null;
        this.clockTimer = null;
        this.browserMode = false;
        this.activities = [];
        this.activitySequence = 0;
    }

    async init() {
        if (this.initPromise) return this.initPromise;
        this.initPromise = (async () => {
            const requestedMode = new URLSearchParams(window.location.search).get('zkapiMode');
            if (requestedMode === 'browser') {
                await this.enableBrowserMode();
                await this.refresh();
            } else {
                try {
                    await this.refresh();
                } catch (error) {
                    if (requestedMode === 'daemon') throw error;
                    await this.enableBrowserMode();
                    await this.refresh();
                }
            }
            this.attachWalletEvents();
            this.refreshTimer = window.setInterval(() => this.refresh({ quiet: true }), 15_000);
            this.clockTimer = window.setInterval(() => this.emitChange('clock'), 1_000);
            this.initialized = true;
            return this.snapshot();
        })().catch((error) => {
            this.lastError = error;
            this.loading = false;
            this.emitChange('error');
            throw error;
        });
        return this.initPromise;
    }

    async enableBrowserMode() {
        await browserWalletRuntime.init();
        this.browserMode = true;
        if (!this.browserRuntimeListener) {
            this.browserRuntimeListener = () => void this.refresh({ quiet: true });
            browserWalletRuntime.addEventListener('change', this.browserRuntimeListener);
        }
    }

    attachWalletEvents() {
        if (!globalThis.ethereum?.on || this.walletEventsAttached) return;
        this.walletEventsAttached = true;
        globalThis.ethereum.on('accountsChanged', (accounts) => {
            this.walletAddress = accounts?.[0] || null;
            this.emitChange('wallet-account');
        });
        globalThis.ethereum.on('chainChanged', () => {
            this.walletAddress = null;
            this.emitChange('wallet-network');
        });
    }

    snapshot() {
        return {
            config: this.config,
            wallet: this.wallet,
            walletAddress: this.walletAddress,
            withdrawal: this.withdrawal,
            challengePeriodSeconds: this.challengePeriodSeconds,
            loading: this.loading,
            lastError: this.lastError,
            initialized: this.initialized,
            activities: this.activities.map(activity => ({ ...activity }))
        };
    }

    beginActivity(kind, details = {}) {
        const now = Date.now();
        const activity = {
            id: `zkapi-${now}-${++this.activitySequence}`,
            kind,
            phase: details.phase || 'starting',
            title: details.title || null,
            message: details.message || null,
            status: 'running',
            blocksSend: Boolean(details.blocksSend),
            sessionId: details.sessionId || null,
            startedAt: now,
            updatedAt: now,
            finishedAt: null,
            error: null
        };
        this.activities.push(activity);
        if (this.activities.length > 16) this.activities.splice(0, this.activities.length - 16);
        this.emitChange('activity-start');
        return activity.id;
    }

    updateActivity(id, changes = {}) {
        const activity = this.activities.find(entry => entry.id === id);
        if (!activity) return null;
        Object.assign(activity, changes, { updatedAt: Date.now() });
        this.emitChange('activity-update');
        return { ...activity };
    }

    completeActivity(id, changes = {}) {
        return this.updateActivity(id, {
            ...changes,
            status: 'success',
            phase: changes.phase || 'complete',
            finishedAt: Date.now(),
            blocksSend: false,
            error: null
        });
    }

    failActivity(id, error, changes = {}) {
        const message = error?.shortMessage || error?.message || String(error || 'Unknown error');
        return this.updateActivity(id, {
            ...changes,
            status: 'error',
            phase: 'error',
            finishedAt: Date.now(),
            blocksSend: Boolean(changes.blocksSend),
            error: message
        });
    }

    cancelActivity(id, message = 'Canceled. No changes were made.') {
        return this.updateActivity(id, {
            status: 'canceled',
            phase: 'canceled',
            message,
            finishedAt: Date.now(),
            blocksSend: false,
            error: null
        });
    }

    subscribe(listener) {
        const handler = (event) => listener(this.snapshot(), event.detail);
        this.addEventListener('change', handler);
        return () => this.removeEventListener('change', handler);
    }

    emitChange(reason = 'update') {
        this.dispatchEvent(new CustomEvent('change', { detail: { reason } }));
        window.dispatchEvent(new CustomEvent('zkapi-state-changed', {
            detail: { reason, snapshot: this.snapshot() }
        }));
    }

    rememberWithdrawal(value) {
        this.withdrawal = value;
        if (value) localStorage.setItem(WITHDRAWAL_STORAGE_KEY, JSON.stringify(value));
        else localStorage.removeItem(WITHDRAWAL_STORAGE_KEY);
        this.emitChange('withdrawal');
    }

    async apiJson(path, options = {}) {
        const headers = {
            ...(options.body ? { 'content-type': 'application/json' } : {}),
            ...(options.headers || {})
        };
        const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
        const text = await response.text();
        let payload = {};
        try {
            payload = text ? JSON.parse(text) : {};
        } catch {
            payload = { raw: text };
        }
        if (!response.ok) {
            const error = payload?.error || {};
            throw new ZkapiHttpError(
                error.message || payload.message || response.statusText || `HTTP ${response.status}`,
                response.status,
                error.code || payload.code,
                payload
            );
        }
        return payload;
    }

    async refresh({ quiet = false } = {}) {
        if (!quiet) {
            this.loading = true;
            this.emitChange('loading');
        }
        try {
            const [config, wallet] = this.browserMode
                ? [browserWalletRuntime.snapshot().config, await browserWalletRuntime.walletStatus()]
                : await Promise.all([
                    this.apiJson('/zkapi/v1/config'),
                    this.apiJson('/wallet/status')
                ]);
            this.config = config;
            this.wallet = wallet;
            this.lastError = null;

            const prepared = config?.prepared_withdrawal;
            if (prepared && (!this.withdrawal || Number(this.withdrawal.noteId) !== Number(prepared.note_id))) {
                this.rememberWithdrawal({
                    phase: 'prepared',
                    mode: prepared.mode,
                    noteId: prepared.note_id,
                    destination: prepared.destination
                });
            } else if (!wallet?.note && !prepared) {
                this.rememberWithdrawal(null);
            }
        } catch (error) {
            this.lastError = error;
            if (!quiet) throw error;
        } finally {
            this.loading = false;
            this.emitChange(this.lastError ? 'error' : 'runtime');
        }
        return this.snapshot();
    }

    get creditsPerUsd() {
        return Number(this.config?.credits_per_usd || 1_000_000);
    }

    get hasNote() {
        return !!this.wallet?.has_note && !!this.wallet?.note;
    }

    async acquireInferenceAccess(sessionId, options = {}) {
        const signal = options.signal || null;
        const throwIfCancelled = () => {
            if (!signal?.aborted) return;
            const error = new DOMException('The operation was aborted.', 'AbortError');
            error.isCancelled = true;
            throw error;
        };
        throwIfCancelled();
        if (!this.initialized) await this.init();
        throwIfCancelled();
        if (this.browserMode) {
            const activityId = this.beginActivity('access', {
                phase: 'checking',
                title: 'Starting private chat',
                message: 'Checking your private balance…',
                sessionId,
                blocksSend: true
            });
            try {
                const access = await browserWalletRuntime.acquireEphemeralKey(
                    sessionId,
                    (phase, message) => this.updateActivity(activityId, { phase, message }),
                    { signal }
                );
                if (signal?.aborted) {
                    access.release?.();
                    throwIfCancelled();
                }
                this.completeActivity(activityId, {
                    phase: 'ready',
                    message: 'Private chat ready.'
                });
                return access;
            } catch (error) {
                if (signal?.aborted) error.isCancelled = true;
                this.failActivity(activityId, error, { blocksSend: true });
                throw error;
            }
        }

        return {
            mode: 'daemon',
            apiKey: null,
            baseUrl: `${window.location.origin}/v1`,
            headers: {
                'content-type': 'application/json',
                [SESSION_HEADER]: sessionId
            },
            release() {}
        };
    }

    get note() {
        return this.wallet?.note || null;
    }

    get requestMode() {
        return this.config?.request_mode || 'proxy';
    }

    get isDirectMode() {
        return this.requestMode === 'direct_openrouter';
    }

    get suggestedDeposit() {
        return Number(this.config?.funding?.suggested_deposit_amount || 2_000_000) / this.creditsPerUsd;
    }

    get billingTokenSymbol() {
        return this.config?.funding?.billing_token_symbol || 'billing token';
    }

    get isMainnetFunding() {
        return Number(this.config?.funding?.chain_id) === 1;
    }

    get activeLease() {
        const lease = this.config?.active_lease;
        return lease && Number(lease.expires_at) * 1000 > Date.now() ? lease : null;
    }

    get withdrawalBlocksChat() {
        return !!this.config?.prepared_withdrawal || ['prepared', 'pending'].includes(this.withdrawal?.phase);
    }

    formatMoney(credits) {
        if (credits == null) return '—';
        const value = Number(credits) / this.creditsPerUsd;
        const digits = value > 0 && value < 0.01 ? 6 : 2;
        return new Intl.NumberFormat(undefined, {
            style: 'currency',
            currency: 'USD',
            minimumFractionDigits: 2,
            maximumFractionDigits: digits
        }).format(value);
    }

    formatExpiry(timestamp) {
        if (!timestamp) return '—';
        const remaining = Number(timestamp) * 1000 - Date.now();
        if (remaining <= 0) return 'expired';
        const days = Math.floor(remaining / 86_400_000);
        if (days > 1) return `${days} days`;
        const hours = Math.floor(remaining / 3_600_000);
        if (hours > 0) return `${hours}h`;
        return `${Math.max(1, Math.ceil(remaining / 60_000))}m`;
    }

    compact(value, width = 7) {
        if (!value) return '—';
        const text = String(value);
        return text.length > width * 2 + 2
            ? `${text.slice(0, width)}…${text.slice(-width)}`
            : text;
    }

    networkName(chainId = this.config?.funding?.chain_id) {
        const names = { 1: 'Ethereum Mainnet', 11155111: 'Sepolia', 31337: 'Local Anvil' };
        return names[Number(chainId)] || `Chain ${chainId ?? '—'}`;
    }

    chainParameters(chainId, rpcUrl) {
        const known = {
            1: { chainName: 'Ethereum Mainnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, blockExplorerUrls: ['https://etherscan.io'] },
            11155111: { chainName: 'Sepolia', nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 }, blockExplorerUrls: ['https://sepolia.etherscan.io'] },
            31337: { chainName: 'Local Anvil', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, blockExplorerUrls: [] }
        };
        return {
            chainId: `0x${Number(chainId).toString(16)}`,
            ...(known[Number(chainId)] || {
                chainName: `Chain ${chainId}`,
                nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
                blockExplorerUrls: []
            }),
            rpcUrls: rpcUrl ? [rpcUrl] : []
        };
    }

    async ensureNetwork() {
        const wanted = Number(this.config?.funding?.chain_id);
        if (!Number.isFinite(wanted)) throw new Error('The payment deployment did not advertise a chain ID.');
        const current = Number.parseInt(await globalThis.ethereum.request({ method: 'eth_chainId' }), 16);
        if (current === wanted) return;
        const chainId = `0x${wanted.toString(16)}`;
        try {
            await globalThis.ethereum.request({
                method: 'wallet_switchEthereumChain',
                params: [{ chainId }]
            });
        } catch (error) {
            if (error.code !== 4902) throw error;
            await globalThis.ethereum.request({
                method: 'wallet_addEthereumChain',
                params: [this.chainParameters(wanted, this.config?.funding?.demo_rpc_url)]
            });
        }
    }

    async connectWallet() {
        if (!globalThis.ethereum) {
            throw new Error('MetaMask was not detected. Install or enable it, then reload this page.');
        }
        if (!this.config) await this.refresh();
        const accounts = await globalThis.ethereum.request({ method: 'eth_requestAccounts' });
        await this.ensureNetwork();
        this.walletAddress = accounts?.[0] || null;
        if (!this.walletAddress) throw new Error('MetaMask did not return an account.');
        await this.loadChallengePeriod();
        this.emitChange('wallet-connected');
        return this.walletAddress;
    }

    async readContractUint(to, data) {
        const value = await globalThis.ethereum.request({
            method: 'eth_call',
            params: [{ to, data }, 'latest']
        });
        return BigInt(value || '0x0');
    }

    async loadChallengePeriod() {
        const vault = this.config?.funding?.contract_address;
        if (!vault || !globalThis.ethereum) return;
        for (const selector of [ABI.challengePeriod, ABI.legacyChallengePeriod]) {
            try {
                const value = await this.readContractUint(vault, `0x${selector}`);
                if (value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
                    this.challengePeriodSeconds = Number(value);
                    this.emitChange('challenge-period');
                    return;
                }
            } catch {
                // Older deployments expose a differently named constant getter.
            }
        }
    }

    async waitForReceipt(hash) {
        for (let attempt = 0; attempt < 180; attempt += 1) {
            const receipt = await globalThis.ethereum.request({
                method: 'eth_getTransactionReceipt',
                params: [hash]
            });
            if (receipt) {
                if (BigInt(receipt.status || '0x0') !== 1n) {
                    throw new Error(`Transaction ${this.compact(hash)} reverted.`);
                }
                return receipt;
            }
            await new Promise(resolve => setTimeout(resolve, 1_000));
        }
        throw new Error(`Timed out waiting for transaction ${this.compact(hash)}.`);
    }

    async sendContractTransaction(from, to, data, onSubmitted = null) {
        const transaction = { from, to, data };
        try {
            // Do not set `gas`, `gasPrice`, or EIP-1559 fee fields. MetaMask
            // simulates the exact transaction and lets the user choose its fee
            // policy. A client-side buffer previously inflated the displayed
            // maximum cost for zkAPI's gas-heavy Poseidon Merkle updates.
            const hash = await globalThis.ethereum.request({
                method: 'eth_sendTransaction',
                params: [transaction]
            });
            if (onSubmitted) await onSubmitted(hash);
            return this.waitForReceipt(hash);
        } catch (error) {
            if (error?.code === 4001 || !contractRevertSelector(error)) throw error;
            throw contractEstimateError(error);
        }
    }

    async confirmBrowserDepositReceipt(plan, receipt, vaultAddress, onStatus) {
        const deposited = parseNoteDeposited(receipt, vaultAddress);
        if (!deposited) {
            throw new Error('The transaction succeeded, but its NoteDeposited event was not found.');
        }
        if (deposited.noteId !== BigInt(plan.next_note_id)
            || deposited.amount !== BigInt(plan.amount)
            || BigInt(deposited.commitment) !== BigInt(plan.commitment)) {
            throw new Error('The mined deposit did not match this browser’s durable private note.');
        }
        onStatus('Saving the private note securely in this browser…');
        await browserWalletRuntime.confirmDeposit({
            secret: plan.secret,
            note_id: Number(deposited.noteId),
            amount: Number(plan.amount),
            expiry_ts: Number(deposited.expiryTs)
        });
        await this.refresh();
        onStatus(`Private note #${Number(deposited.noteId)} is ready.`);
        return {
            noteId: Number(deposited.noteId),
            amount: Number(plan.amount),
            receipt
        };
    }

    async addBillingTokenToWallet(onStatus = () => {}) {
        const funding = this.config?.funding;
        const tokenAddress = funding?.demo_billing_token_address;
        if (!tokenAddress) throw new Error('This deployment does not advertise a billing token.');
        onStatus('Connecting to MetaMask…');
        await this.connectWallet();
        onStatus('Confirm “Add token” in MetaMask…');
        const added = await globalThis.ethereum.request({
            method: 'wallet_watchAsset',
            params: {
                type: 'ERC20',
                options: {
                    address: tokenAddress,
                    symbol: this.billingTokenSymbol,
                    decimals: Number(funding.billing_token_decimals || 6)
                }
            }
        });
        if (!added) throw new Error(`MetaMask did not add ${this.billingTokenSymbol}.`);
        onStatus(`${this.billingTokenSymbol} is now visible in MetaMask on ${this.networkName()}.`);
        return true;
    }

    async mintDemoTokens(amountInput = '10', onStatus = () => {}) {
        const funding = this.config?.funding;
        if (!funding?.demo_mint_enabled || Number(funding.chain_id) !== 11155111) {
            throw new Error('Free test ZKAPI is not enabled for this deployment.');
        }
        if (!funding.demo_billing_token_address) {
            throw new Error('This deployment does not advertise a billing token.');
        }
        const amount = parseTokenAmount(amountInput);
        if (amount <= 0n || amount > 1_000_000_000n) {
            throw new Error('Choose a test-token amount between 0 and 1,000 ZKAPI.');
        }

        onStatus('Connecting to MetaMask…');
        const address = await this.connectWallet();
        onStatus(`Confirm minting ${formatTokenAmount(amount)} test ZKAPI in MetaMask…`);
        const receipt = await this.sendContractTransaction(
            address,
            funding.demo_billing_token_address,
            callData(ABI.mint, [addressWord(address), abiWord(amount)])
        );
        const balance = await this.readContractUint(
            funding.demo_billing_token_address,
            callData(ABI.balanceOf, [addressWord(address)])
        );
        onStatus(`${formatTokenAmount(balance)} test ZKAPI is available in MetaMask.`);
        return { address, balance, receipt };
    }

    async deposit(amountInput, onStatus = () => {}) {
        if (this.hasNote) throw new Error('This client already has an active private note.');
        const funding = this.config?.funding;
        if (!funding?.demo_billing_token_address || !funding.contract_address) {
            throw new Error('This deployment does not advertise an ERC-20 billing token.');
        }

        onStatus('Connecting to MetaMask…');
        const address = await this.connectWallet();
        const amount = parseTokenAmount(amountInput);
        if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new Error('Choose a smaller positive deposit amount.');
        }

        const tokenAddress = funding.demo_billing_token_address;
        const vaultAddress = funding.contract_address;
        const pendingDeposit = this.browserMode
            ? await browserWalletRuntime.pendingDeposit()
            : null;
        if (pendingDeposit?.transactionHash) {
            if (Number(pendingDeposit.amount) !== Number(amount)) {
                throw new Error('A different deposit transaction is already pending in MetaMask. Finish it before changing the amount.');
            }
            onStatus(`Recovering the pending deposit from ${this.networkName()}…`);
            try {
                const receipt = await this.waitForReceipt(pendingDeposit.transactionHash);
                return this.confirmBrowserDepositReceipt(
                    pendingDeposit,
                    receipt,
                    vaultAddress,
                    onStatus
                );
            } catch (error) {
                // A reverted transaction may be retried with the same durable
                // secret and commitment. A still-pending transaction retains
                // its hash because waitForReceipt times out instead of reverting.
                const receipt = await globalThis.ethereum.request({
                    method: 'eth_getTransactionReceipt',
                    params: [pendingDeposit.transactionHash]
                });
                if (receipt && BigInt(receipt.status || '0x0') !== 1n) {
                    await browserWalletRuntime.rememberPendingDepositTransaction(null);
                }
                throw error;
            }
        }
        let tokenBalance = await this.readContractUint(
            tokenAddress,
            callData(ABI.balanceOf, [addressWord(address)])
        );

        if (tokenBalance < amount) {
            if (!funding.demo_mint_enabled) {
                throw new Error(`Your wallet has ${formatTokenAmount(tokenBalance)} ${this.billingTokenSymbol}; this deposit needs ${formatTokenAmount(amount)} ${this.billingTokenSymbol}.`);
            }
            onStatus('Minting free test billing tokens… confirm in MetaMask.');
            await this.sendContractTransaction(
                address,
                tokenAddress,
                callData(ABI.mint, [addressWord(address), abiWord(amount - tokenBalance)])
            );
            tokenBalance = await this.readContractUint(
                tokenAddress,
                callData(ABI.balanceOf, [addressWord(address)])
            );
            if (tokenBalance < amount) {
                throw new Error('The test-token mint completed, but the balance is still too low.');
            }
        }

        onStatus('Generating the private note commitment locally…');
        const plan = this.browserMode
            ? await browserWalletRuntime.prepareDeposit(Number(amount))
            : await this.apiJson('/deposit/prepare', {
                method: 'POST',
                body: JSON.stringify({ amount: Number(amount) })
            });

        const allowance = await this.readContractUint(
            tokenAddress,
            callData(ABI.allowance, [addressWord(address), addressWord(vaultAddress)])
        );
        if (allowance < amount) {
            if (allowance > 0n) {
                onStatus('Resetting the existing token allowance… confirm in MetaMask.');
                await this.sendContractTransaction(
                    address,
                    tokenAddress,
                    callData(ABI.approve, [addressWord(vaultAddress), abiWord(0n)])
                );
            }
            onStatus(`Approving ${this.billingTokenSymbol}… confirm in MetaMask.`);
            await this.sendContractTransaction(
                address,
                tokenAddress,
                callData(ABI.approve, [addressWord(vaultAddress), abiWord(amount)])
            );
        }

        onStatus('Depositing into the private-note vault… confirm in MetaMask.');
        const receipt = await this.sendContractTransaction(
            address,
            vaultAddress,
            encodeDeposit(plan, amount),
            this.browserMode
                ? hash => browserWalletRuntime.rememberPendingDepositTransaction(hash)
                : null
        );
        if (this.browserMode) {
            return this.confirmBrowserDepositReceipt(plan, receipt, vaultAddress, onStatus);
        }
        const deposited = parseNoteDeposited(receipt, vaultAddress);
        if (!deposited) {
            throw new Error('The transaction succeeded, but its NoteDeposited event was not found.');
        }

        onStatus('Saving the private note in the local payment service…');
        const confirmation = {
            secret: plan.secret,
            note_id: Number(deposited.noteId),
            amount: Number(amount),
            expiry_ts: Number(deposited.expiryTs)
        };
        await this.apiJson('/deposit/confirm', {
            method: 'POST',
            body: JSON.stringify(confirmation)
        });
        await this.refresh();
        onStatus(`Private note #${Number(deposited.noteId)} is ready.`);
        return { noteId: Number(deposited.noteId), amount: Number(amount), receipt };
    }

    async withdraw(mode, onStatus = () => {}) {
        const note = this.note;
        if (!note) throw new Error('There is no active private note to withdraw.');
        if (!['mutual', 'escape'].includes(mode)) throw new Error('Choose a valid withdrawal mode.');

        await this.settleActiveLease(onStatus);

        onStatus('Connecting to MetaMask…');
        const destination = await this.connectWallet();
        const prepared = this.config?.prepared_withdrawal;
        if (prepared?.destination && prepared.destination.toLowerCase() !== destination.toLowerCase()) {
            throw new Error(`Reconnect ${this.compact(prepared.destination, 9)}, the account bound to this prepared withdrawal.`);
        }

        const withdrawal = {
            phase: 'prepared',
            mode,
            noteId: Number(note.note_id),
            destination
        };

        let plan;
        let receipt;
        const attempts = this.browserMode ? 3 : 1;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            onStatus(attempt === 0
                ? (mode === 'mutual'
                    ? 'Requesting server clearance and generating the withdrawal proof…'
                    : 'Generating a unilateral escape proof locally…')
                : 'The vault changed during preparation. Refreshing the Merkle path and proof…');
            const expectedActiveRoot = this.browserMode
                ? await this.readContractUint(
                    this.config.funding.contract_address,
                    `0x${ABI.currentRoot}`
                )
                : null;
            plan = this.browserMode
                ? await browserWalletRuntime.prepareWithdrawal(mode, destination, { expectedActiveRoot })
                : await this.apiJson('/wallet/withdraw', {
                    method: 'POST',
                    body: JSON.stringify({ mode, destination })
                });
            if (Number(plan.public_inputs?.note_id) !== Number(note.note_id)) {
                throw new Error('The private wallet returned a withdrawal for a different note.');
            }
            this.rememberWithdrawal(withdrawal);
            if (this.config) {
                this.config.prepared_withdrawal = {
                    mode,
                    note_id: withdrawal.noteId,
                    destination
                };
            }
            const calldata = encodeWithdrawal(
                plan,
                mode,
                destination,
                this.config.funding.contract_address
            );
            onStatus(mode === 'mutual'
                ? 'Confirm the mutual close in MetaMask…'
                : 'Confirm the escape-hatch start in MetaMask…');
            try {
                receipt = await this.sendContractTransaction(
                    destination,
                    this.config.funding.contract_address,
                    calldata
                );
                break;
            } catch (error) {
                if (!this.browserMode || error?.code !== 'stale_root' || attempt + 1 >= attempts) throw error;
            }
        }
        const event = parseWithdrawalReceipt(receipt, this.config.funding.contract_address, mode);
        if (!event || event.noteId !== BigInt(note.note_id)
            || event.destination.toLowerCase() !== destination.toLowerCase()
            || event.finalBalance !== BigInt(plan.public_inputs.final_balance)) {
            throw new Error('The transaction succeeded, but its withdrawal event did not match the prepared note.');
        }

        onStatus(this.browserMode
            ? 'Confirming the vault state and updating this browser…'
            : 'Confirming the vault state and updating the private wallet…');
        const confirmed = this.browserMode
            ? await this.confirmBrowserWithdrawal()
            : await this.apiJson('/wallet/withdraw/confirm', { method: 'POST' });
        if (mode === 'mutual') {
            if (confirmed.status !== 'closed') {
                throw new Error(`The vault still reports note #${note.note_id} as ${confirmed.status}.`);
            }
            this.rememberWithdrawal(null);
            await this.refresh();
            onStatus('Withdrawal complete. The closed note was archived locally.');
            return { status: 'closed', event, receipt };
        }

        const deadline = Number(confirmed.challenge_deadline || event.challengeDeadline);
        if (confirmed.status !== 'pending_withdrawal' || !deadline) {
            throw new Error('The escape transaction mined, but the vault did not report its safety deadline.');
        }
        this.rememberWithdrawal({
            ...withdrawal,
            phase: 'pending',
            challengeDeadline: deadline
        });
        await this.refresh();
        onStatus('Escape started. Return after the safety window to finalize.');
        return { status: 'pending_withdrawal', deadline, event, receipt };
    }

    async settleActiveLease(onStatus = () => {}) {
        const hasPendingRequest = Boolean(this.activeLease || this.wallet?.pending_request);
        const activityId = hasPendingRequest ? this.beginActivity('settlement', {
            phase: 'settling',
            title: 'Finishing previous chat',
            message: 'Closing its temporary key…',
            sessionId: this.activeLease?.session_id || null,
            blocksSend: true
        }) : null;
        const report = (phase, message) => {
            if (activityId) this.updateActivity(activityId, { phase, message });
            onStatus(message);
        };
        if (hasPendingRequest) {
            report('settling', 'Finishing the active chat and confirming its usage…');
        }
        try {
            const settled = this.browserMode
                ? await browserWalletRuntime.settleActiveLease((phase, message) => report(phase, message))
                : await this.apiJson('/wallet/settle', { method: 'POST' });
            await this.refresh({ quiet: true });
            if (this.activeLease || this.wallet?.pending_request) {
                throw new Error('The private key usage is still settling. Try again shortly.');
            }
            if (hasPendingRequest) {
                report('complete', 'Previous chat finished. Balance updated.');
                this.completeActivity(activityId, { message: 'Previous chat finished. Balance updated.' });
            }
            return settled;
        } catch (error) {
            if (activityId) this.failActivity(activityId, error, { blocksSend: true });
            throw error;
        }
    }

    async hasPendingLease() {
        if (!this.initialized) await this.init();
        if (this.browserMode) return browserWalletRuntime.hasPendingLease();
        await this.refresh({ quiet: true });
        return Boolean(this.activeLease || this.wallet?.pending_request);
    }

    async syncWithdrawal(onStatus = () => {}) {
        if (!this.note) return { status: 'no_note' };
        onStatus('Checking the vault’s canonical note status…');
        const before = this.withdrawal;
        const result = this.browserMode
            ? await this.confirmBrowserWithdrawal()
            : await this.apiJson('/wallet/withdraw/confirm', { method: 'POST' });
        if (result.status === 'closed') {
            this.rememberWithdrawal(null);
            onStatus('Withdrawal complete. The private wallet archived the closed note.');
        } else if (result.status === 'pending_withdrawal') {
            this.rememberWithdrawal({
                phase: 'pending',
                mode: 'escape',
                noteId: result.note_id,
                destination: before?.destination || this.config?.prepared_withdrawal?.destination || this.walletAddress || 'Unknown',
                challengeDeadline: Number(result.challenge_deadline)
            });
            onStatus('The escape is pending until its safety deadline.');
        } else if (result.status === 'active' && before?.mode === 'escape') {
            this.rememberWithdrawal(null);
            onStatus(before.phase === 'pending'
                ? 'The escape was challenged. The note is active again and chat spending is restored.'
                : 'No escape transaction is pending. You may prepare a fresh withdrawal.');
        } else {
            onStatus('The note is active. Retry the prepared mutual close or choose the escape hatch.');
        }
        await this.refresh();
        return result;
    }

    async finalizeEscape(onStatus = () => {}) {
        const withdrawal = this.withdrawal;
        if (withdrawal?.phase !== 'pending') throw new Error('There is no pending escape withdrawal.');
        if (Date.now() < Number(withdrawal.challengeDeadline) * 1000) {
            throw new Error(`The safety window has ${this.formatExpiry(withdrawal.challengeDeadline)} remaining.`);
        }

        onStatus('Connecting to MetaMask for finalization…');
        const from = await this.connectWallet();
        onStatus('Confirm finalization in MetaMask…');
        const receipt = await this.sendContractTransaction(
            from,
            this.config.funding.contract_address,
            encodeFinalizeEscape(withdrawal.noteId)
        );
        const event = parseWithdrawalReceipt(receipt, this.config.funding.contract_address, 'finalize');
        if (!event || event.noteId !== BigInt(withdrawal.noteId)
            || event.destination.toLowerCase() !== withdrawal.destination.toLowerCase()) {
            throw new Error('The finalization event did not match the pending withdrawal.');
        }
        const confirmed = this.browserMode
            ? await this.confirmBrowserWithdrawal()
            : await this.apiJson('/wallet/withdraw/confirm', { method: 'POST' });
        if (confirmed.status !== 'closed') {
            throw new Error(`The vault reports ${confirmed.status} after finalization.`);
        }
        this.rememberWithdrawal(null);
        await this.refresh();
        onStatus('Escape withdrawal finalized. The closed note was archived locally.');
        return { status: 'closed', event, receipt };
    }

    async confirmBrowserWithdrawal() {
        const note = this.note;
        if (!note) return { status: 'no_note', challenge_deadline: null };
        const noteId = Number(note.note_id);
        const encodedNote = await globalThis.ethereum.request({
            method: 'eth_call',
            params: [{
                to: this.config.funding.contract_address,
                data: `0x9f18e4ed${abiWord(noteId)}`
            }, 'latest']
        });
        const words = String(encodedNote || '').replace(/^0x/, '').match(/.{64}/g) || [];
        if (words.length < 4) throw new Error('The vault returned a truncated note record.');
        const status = Number(BigInt(`0x${words[3]}`));
        if (status === 3) {
            await browserWalletRuntime.archiveNote('withdrawn');
            return { status: 'closed', note_id: noteId, challenge_deadline: null };
        }
        if (status === 1) {
            await browserWalletRuntime.clearPreparedWithdrawal();
            return { status: 'active', note_id: noteId, challenge_deadline: null };
        }
        if (status !== 2) throw new Error(`The vault returned unknown note status ${status}.`);
        const encodedPending = await globalThis.ethereum.request({
            method: 'eth_call',
            params: [{
                to: this.config.funding.contract_address,
                data: `0xa2f9f1ce${abiWord(noteId)}`
            }, 'latest']
        });
        const pendingWords = String(encodedPending || '').replace(/^0x/, '').match(/.{64}/g) || [];
        if (pendingWords.length < 6 || BigInt(`0x${pendingWords[0]}`) !== 1n) {
            throw new Error('The vault pending-withdrawal record is missing.');
        }
        return {
            status: 'pending_withdrawal',
            note_id: noteId,
            challenge_deadline: Number(BigInt(`0x${pendingWords[5]}`))
        };
    }

    escapePeriodLabel() {
        return escapePeriodLabel(this.challengePeriodSeconds);
    }

    escapePeriodPhrase() {
        return escapePeriodPhrase(this.challengePeriodSeconds);
    }

    escapePeriodBadge() {
        return escapePeriodBadge(this.challengePeriodSeconds);
    }

    sessionHeaders(sessionId) {
        return { [SESSION_HEADER]: sessionId };
    }
}

const zkapiClient = new ZkapiClient();
globalThis.zkapiClient = zkapiClient;

export { SESSION_HEADER, ZkapiHttpError };
export default zkapiClient;
