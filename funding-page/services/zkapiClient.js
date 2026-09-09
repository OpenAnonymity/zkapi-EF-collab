import browserWalletRuntime from './browserWalletRuntime.js';
import { contractEstimateError, contractRevertSelector } from './zkapiContractError.mjs';
import { bufferedGasLimit } from './zkapiGas.mjs';
import { normalizeWalletError, walletErrorMessage } from './zkapiWalletError.mjs';
import { backgroundWithdrawalClaims, isUnsubmittedParkedMutualWithdrawal } from './zkapiWithdrawalRecovery.mjs';
import { deriveExpiryRecords, readFinalizedExpiryClaims } from './zkapiExpiryHistory.mjs';

const WITHDRAWAL_STORAGE_KEY = 'zkapi-withdrawal-v2';
const SESSION_HEADER = 'x-zkapi-session-id';
// Ethereum's `finalized` block tag is authoritative when the wallet RPC
// supports it. A confirmation-depth fallback keeps recovery moving on older
// providers without ever blocking the user from selecting a fresh note.
const CLOSE_FINALITY_FALLBACK_BLOCKS = 64;

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
        return stored?.noteId != null && ['prepared', 'submitted', 'pending'].includes(stored.phase)
            ? stored
            : null;
    } catch {
        localStorage.removeItem(WITHDRAWAL_STORAGE_KEY);
        return null;
    }
}

function walletErrorCode(error) {
    return error?.code
        ?? error?.cause?.code
        ?? error?.data?.originalError?.code
        ?? error?.error?.code
        ?? null;
}

function isWalletRejection(error) {
    const code = walletErrorCode(error);
    return code === 4001
        || code === 'ACTION_REJECTED'
        || /(?:user|wallet).*(?:reject|denied|cancel)|request rejected/i.test(error?.message || '');
}

function isDefinitelyPreBroadcastSendFailure(error) {
    const code = walletErrorCode(error);
    // EIP-1193 authorization/connectivity failures and JSON-RPC request-shape
    // failures are rejected by the provider before it can accept a signed
    // transaction. Broad -32000 errors are intentionally classified only by
    // narrow messages because that code also covers ambiguous node failures.
    if ([4100, 4200, 4900, 4901, -32600, -32601, -32602].includes(Number(code))) {
        return true;
    }
    const message = [
        error?.message,
        error?.shortMessage,
        error?.data?.message,
        error?.data?.originalError?.message,
        error?.error?.message
    ].filter(Boolean).join(' ');
    return /insufficient funds(?: for gas| to pay)|intrinsic gas too low|exceeds (?:the )?block gas limit|transaction gas limit too high|gas limit (?:is )?too high|sender account not recognized|unknown account/i.test(message);
}

function tagTransactionError(error, stage, broadcastPossible, transactionHash = null) {
    const tagged = normalizeWalletError(error);
    tagged.transactionStage = stage;
    tagged.broadcastPossible = Boolean(broadcastPossible);
    if (transactionHash) tagged.transactionHash = transactionHash;
    return tagged;
}

// EIP-1193 normally exposes JSON-RPC quantities as 0x-prefixed strings, but
// MetaMask's pending-nonce middleware can return a number directly. Other
// injected-provider compatibility layers also surface bigints, decimal
// strings, ethers-style {_hex}, or an unwrapped RPC result.
// Normalize only exact non-negative integers; never coerce floats, signs, or
// arbitrary objects into a wallet nonce.
function walletNonceNumber(value, depth = 0) {
    if (depth > 2) return null;
    if (value && typeof value === 'object') {
        if (Object.prototype.hasOwnProperty.call(value, 'error')) return null;
        for (const field of ['result', '_hex', 'hex']) {
            if (Object.prototype.hasOwnProperty.call(value, field)) {
                return walletNonceNumber(value[field], depth + 1);
            }
        }
        return null;
    }

    let quantity;
    if (typeof value === 'bigint') {
        quantity = value;
    } else if (typeof value === 'number') {
        if (!Number.isSafeInteger(value)) return null;
        quantity = BigInt(value);
    } else if (typeof value === 'string') {
        const text = value.trim();
        if (!/^(?:0[xX][0-9a-fA-F]+|(?:0|[1-9][0-9]*))$/.test(text)) return null;
        try {
            quantity = BigInt(text);
        } catch {
            return null;
        }
    } else {
        return null;
    }

    if (quantity < 0n || quantity > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(quantity);
}

class ZkapiClient extends EventTarget {
    constructor() {
        super();
        this.config = null;
        this.wallet = null;
        this.walletAddress = null;
        this.withdrawal = readStoredWithdrawal();
        this.withdrawals = [];
        this.deposits = [];
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
        this.withdrawPromise = null;
        this.withdrawPromiseKey = null;
        this.finalizePromise = null;
        this.finalizePromiseKey = null;
        this.depositPromise = null;
        this.depositPromiseKey = null;
        this.backgroundReconciliationPromise = null;
        this.visibilityHandler = null;
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
                    // The same OA bundle is served by both clientd and static
                    // browser deployments. Probe the same-origin daemon first,
                    // but do not publish its expected 404 while a static site
                    // is falling back to the browser wallet.
                    await this.refresh({ speculative: requestedMode !== 'daemon' });
                } catch (error) {
                    if (requestedMode === 'daemon') throw error;
                    await this.enableBrowserMode();
                    await this.refresh();
                }
            }
            if (this.browserMode) await this.reconcileBrowserWithdrawalsOnLoad();
            this.attachWalletEvents();
            this.refreshTimer = window.setInterval(
                () => void this.reconcileBrowserWalletInBackground(),
                15_000
            );
            if (this.browserMode && typeof document !== 'undefined' && !this.visibilityHandler) {
                this.visibilityHandler = () => {
                    if (document.visibilityState !== 'hidden') {
                        void this.reconcileBrowserWalletInBackground();
                    }
                };
                document.addEventListener('visibilitychange', this.visibilityHandler);
                window.addEventListener?.('focus', this.visibilityHandler);
            }
            // Time-only ticks have their own channel. Publishing them as a
            // semantic state change caused every subscriber to rebuild UI once
            // per second, disconnecting animated nodes and resetting focus.
            this.clockTimer = window.setInterval(() => this.emitClock(), 1_000);
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

    async reconcileBrowserWithdrawalsOnLoad() {
        if (!globalThis.ethereum || !this.config?.funding?.chain_id) return false;
        try {
            const currentChain = Number.parseInt(
                await globalThis.ethereum.request({ method: 'eth_chainId' }),
                16
            );
            if (currentChain !== Number(this.config.funding.chain_id)) return false;
            const reconcile = async (label, action) => {
                try {
                    await action();
                    return true;
                } catch (error) {
                    // Each durable record is an independent recovery capability.
                    // One malformed receipt or temporarily unavailable RPC path
                    // must not starve every other withdrawal during startup.
                    console.warn(`Unable to reconcile ${label} on load.`, error);
                    return false;
                }
            };
            let complete = await reconcile(
                'late withdrawal transactions',
                () => this.syncLateWithdrawalAttempts(() => {})
            );
            complete = await reconcile(
                'the selected wallet snapshot',
                () => this.refresh({ quiet: true })
            ) && complete;
            complete = await reconcile(
                'the selected MetaMask request',
                () => browserWalletRuntime.recoverPreparedWithdrawalSubmissionClaim()
            ) && complete;
            complete = await reconcile(
                'the selected wallet state',
                () => this.refresh({ quiet: true })
            ) && complete;
            if (this.note && (this.config?.prepared_withdrawal || this.withdrawal)) {
                complete = await reconcile(
                    'the selected withdrawal',
                    () => this.syncWithdrawal(() => {})
                ) && complete;
            }
            if (this.withdrawals.some(record => record.phase !== 'closed'
                || record.finalizeTransactionHash
                || record.finalizeSubmissionId)) {
                complete = await reconcile(
                    'background withdrawals',
                    () => this.syncEscapeWithdrawals(() => {})
                ) && complete;
            }
            complete = await reconcile('expiry payments', () => this.syncExpiryHistory()) && complete;
            return complete;
        } catch (error) {
            // Startup recovery must never summon MetaMask or prevent OA Chat
            // from loading. The exact durable state remains available through
            // the explicit status action in the balance panel.
            console.warn('Unable to reconcile browser withdrawals on load.', error);
            return false;
        }
    }

    async reconcileBrowserWalletInBackground() {
        if (this.backgroundReconciliationPromise) return this.backgroundReconciliationPromise;
        const operation = (async () => {
            await this.refresh({ quiet: true });
            if (!this.browserMode || !globalThis.ethereum || !this.config?.funding?.chain_id) {
                return false;
            }
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
                return false;
            }
            const currentChain = Number.parseInt(
                await globalThis.ethereum.request({ method: 'eth_chainId' }),
                16
            );
            if (currentChain !== Number(this.config.funding.chain_id)) return false;

            // These paths only read the connected chain and reconcile durable
            // browser state. They never request accounts or open MetaMask.
            const reconcile = async (label, action) => {
                try {
                    await action();
                    return true;
                } catch (error) {
                    // Keep independent recovery records making progress. In
                    // particular, a broken deposit RPC response must not leave
                    // an unrelated withdrawal looking frozen forever.
                    console.warn(`Unable to reconcile ${label} in the background.`, error);
                    return false;
                }
            };
            let complete = true;
            if (this.config?.pending_deposit) {
                complete = await reconcile(
                    'the pending deposit',
                    () => this.recoverBrowserDeposit(() => {})
                ) && complete;
            }
            complete = await reconcile(
                'late withdrawal transactions',
                () => this.syncLateWithdrawalAttempts(() => {})
            ) && complete;
            complete = await reconcile(
                'the wallet snapshot',
                () => this.refresh({ quiet: true })
            ) && complete;
            if (this.note && (this.config?.prepared_withdrawal || this.withdrawal)) {
                complete = await reconcile(
                    'the selected withdrawal',
                    () => this.syncWithdrawal(() => {})
                ) && complete;
            }
            if (this.withdrawals.some(record => record.phase !== 'closed'
                || record.finalizeTransactionHash
                || record.finalizeSubmissionId)) {
                complete = await reconcile(
                    'background withdrawals',
                    () => this.syncEscapeWithdrawals(() => {})
                ) && complete;
            }
            complete = await reconcile('expiry payments', () => this.syncExpiryHistory()) && complete;
            return complete;
        })().catch(error => {
            // A background provider outage is not a new wallet failure. The
            // durable recovery card remains available for an explicit check.
            console.warn('Unable to reconcile browser wallet in the background.', error);
            return false;
        }).finally(() => {
            if (this.backgroundReconciliationPromise === operation) {
                this.backgroundReconciliationPromise = null;
            }
        });
        this.backgroundReconciliationPromise = operation;
        return operation;
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
            withdrawals: this.withdrawals.map(record => ({ ...record })),
            deposits: this.deposits.map(record => ({ ...record })),
            challengePeriodSeconds: this.challengePeriodSeconds,
            loading: this.loading,
            lastError: this.lastError,
            initialized: this.initialized,
            activities: this.activities.map(activity => ({ ...activity }))
        };
    }

    runtimeStateSignature() {
        const error = this.lastError ? {
            name: this.lastError.name || null,
            code: this.lastError.code || null,
            status: this.lastError.status || null,
            message: walletErrorMessage(this.lastError)
        } : null;
        return JSON.stringify({
            config: this.config,
            wallet: this.wallet,
            withdrawal: this.withdrawal,
            withdrawals: this.withdrawals,
            deposits: this.deposits,
            error
        });
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
        const message = walletErrorMessage(error);
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

    subscribeClock(listener) {
        const handler = (event) => listener(event.detail);
        this.addEventListener('clock', handler);
        return () => this.removeEventListener('clock', handler);
    }

    emitClock() {
        this.dispatchEvent(new CustomEvent('clock', {
            detail: { now: Date.now() }
        }));
    }

    emitChange(reason = 'update') {
        this.dispatchEvent(new CustomEvent('change', { detail: { reason } }));
        window.dispatchEvent(new CustomEvent('zkapi-state-changed', {
            detail: { reason, snapshot: this.snapshot() }
        }));
    }

    rememberWithdrawal(value, { emit = true } = {}) {
        this.withdrawal = value;
        if (value) localStorage.setItem(WITHDRAWAL_STORAGE_KEY, JSON.stringify(value));
        else localStorage.removeItem(WITHDRAWAL_STORAGE_KEY);
        if (emit) this.emitChange('withdrawal');
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

    async refresh({ quiet = false, speculative = false } = {}) {
        const stateBeforeRefresh = this.runtimeStateSignature();
        if (!quiet && !speculative) {
            this.loading = true;
            this.emitChange('loading');
        }
        let succeeded = false;
        try {
            let browserSnapshot = null;
            const [config, wallet] = this.browserMode
                ? [(browserSnapshot = browserWalletRuntime.snapshot()).config, await browserWalletRuntime.walletStatus()]
                : await Promise.all([
                    this.apiJson('/zkapi/v1/config'),
                    this.apiJson('/wallet/status')
                ]);
            this.config = config;
            this.wallet = wallet;
            if (this.browserMode) {
                // walletStatus is worker-only, but take a fresh snapshot in
                // case another tab updated recovery records during that call.
                browserSnapshot = browserWalletRuntime.snapshot();
                this.config = browserSnapshot.config;
                this.withdrawals = browserSnapshot.withdrawals || [];
                this.deposits = browserSnapshot.deposits || [];
            } else {
                this.withdrawals = [];
                this.deposits = [];
            }
            this.lastError = null;

            const prepared = this.config?.prepared_withdrawal;
            if (prepared) {
                const mirror = {
                    phase: prepared.phase || (prepared.transaction_hash ? 'submitted' : 'prepared'),
                    mode: prepared.mode,
                    noteId: prepared.note_id,
                    destination: prepared.destination,
                    transactionHash: prepared.transaction_hash || null,
                    clearanceReserved: prepared.clearance_reserved === true || prepared.mode === 'mutual'
                };
                if (JSON.stringify(this.withdrawal) !== JSON.stringify(mirror)) {
                    this.rememberWithdrawal(mirror, { emit: false });
                }
            } else if (this.browserMode && this.withdrawal) {
                // IndexedDB is authoritative in browser mode. localStorage is
                // only a presentation mirror and must never resurrect a
                // canceled/prepared marker after the durable plan is cleared.
                this.rememberWithdrawal(null, { emit: false });
            } else if (!wallet?.note && !prepared && this.withdrawal) {
                this.rememberWithdrawal(null, { emit: false });
            }
            succeeded = true;
        } catch (error) {
            // A speculative daemon miss is an implementation detail of
            // automatic transport selection, not an actionable user error.
            // If browser initialization also fails, init() publishes that
            // real failure through its existing outer catch.
            if (!speculative) this.lastError = error;
            if (!quiet || speculative) throw error;
        } finally {
            this.loading = false;
            // Periodic/browser-runtime refreshes often return byte-for-byte
            // equivalent state. Do not fan those out as semantic UI changes;
            // full panel/modal renders would otherwise replay animations even
            // though nothing users can act on changed.
            if ((!speculative || succeeded)
                && (!quiet || stateBeforeRefresh !== this.runtimeStateSignature())) {
                this.emitChange(this.lastError ? 'error' : 'runtime');
            }
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
                progressKind: 'access',
                sessionId,
                blocksSend: true
            });
            let lastProgressPhase = 'checking';
            let lastProgressKind = 'access';
            const notifyProgress = (phase, message, kind = 'access', metadata = {}) => {
                try {
                    options.onProgress?.({
                        kind,
                        phase,
                        message,
                        sessionId,
                        ...metadata
                    });
                } catch (error) {
                    console.warn('The assistant private-access trace could not update.', error);
                }
            };
            const reportProgress = (phase, message, kind = 'access') => {
                lastProgressPhase = phase;
                lastProgressKind = kind;
                this.updateActivity(activityId, { phase, message, progressKind: kind });
                notifyProgress(phase, message, kind);
            };
            notifyProgress('checking', 'Checking your private balance…');
            try {
                const access = await browserWalletRuntime.acquireEphemeralKey(
                    sessionId,
                    reportProgress,
                    { signal, spendingLimitUsd: options.spendingLimitUsd }
                );
                if (signal?.aborted) {
                    access.release?.();
                    throwIfCancelled();
                }
                if (lastProgressPhase !== 'ready') {
                    reportProgress('ready', 'Private chat ready.', lastProgressKind);
                }
                this.completeActivity(activityId, {
                    phase: 'ready',
                    message: 'Private chat ready.',
                    progressKind: lastProgressKind
                });
                return access;
            } catch (error) {
                if (signal?.aborted) error.isCancelled = true;
                this.failActivity(activityId, error, { blocksSend: true });
                notifyProgress(
                    error?.isCancelled ? 'canceled' : 'error',
                    'Private access was not created.',
                    lastProgressKind,
                    { failedPhase: lastProgressPhase }
                );
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

    get noteExpiryClaim() {
        if (this.note?.note_id == null) return null;
        return this.deposits.find(record => record.status === 'confirmed'
            && record.noteId === Number(this.note.note_id))?.expiryClaim || null;
    }

    get expiryHistory() {
        return deriveExpiryRecords(this.deposits, this.withdrawals);
    }

    async syncExpiryHistory() {
        if (this.expiryHistoryPromise) return this.expiryHistoryPromise;
        if (!this.browserMode || !this.config?.funding) return { complete: true, claims: [] };
        const operation = (async () => {
            this.deposits = await browserWalletRuntime.getDepositHistory();
            // A generic Closed vault status may itself be an expiry claim.
            // Never let a withdrawal's phase suppress checking actual payments.
            if (!deriveExpiryRecords(this.deposits).some(record => record.status === 'expired')) {
                return { complete: true, claims: [] };
            }
            if (!globalThis.ethereum?.request) throw new Error('Open MetaMask on the balance’s network to check expiry payments. No transaction is needed.');
            const funding = this.config.funding;
            const deploymentId = browserWalletRuntime.manifest.deployment_id;
            const historyIdentity = JSON.stringify(this.deposits.filter(record => record.status === 'confirmed')
                .map(record => [record.recordId, record.expiryTs, record.amount]).sort());
            const scan = this.expiryScan?.deploymentId === deploymentId
                && this.expiryScan.historyIdentity === historyIdentity ? this.expiryScan : null;
            const result = await readFinalizedExpiryClaims({
                request: request => globalThis.ethereum.request(request),
                vaultAddress: funding.contract_address,
                chainId: funding.chain_id,
                deposits: this.deposits,
                fromBlock: scan ? scan.scannedTo + 1 : 0,
                deploymentBlock: scan?.deploymentBlock ?? null
            });
            // Advance only after durable history succeeds. A failed save can
            // safely rescan the same public events without losing a payment.
            if (result.claims.length) await browserWalletRuntime.rememberExpiryClaims(result.claims);
            this.expiryScan = { deploymentId, historyIdentity, scannedTo: result.scannedTo,
                deploymentBlock: result.deploymentBlock };
            await this.refresh({ quiet: true });
            return result;
        })();
        this.expiryHistoryPromise = operation;
        try { return await operation; }
        finally { if (this.expiryHistoryPromise === operation) this.expiryHistoryPromise = null; }
    }

    async archiveClaimedBalance() {
        if (!this.noteExpiryClaim) throw new Error('The balance has no verified expiry payment.');
        await browserWalletRuntime.archiveNote('expiry-claimed', Number(this.note.note_id));
        await this.refresh();
    }

    async assertBalanceNotClaimed(noteId) {
        if (this.browserMode) this.deposits = await browserWalletRuntime.getDepositHistory();
        if (this.deposits.some(record => record.status === 'confirmed'
            && record.noteId === Number(noteId) && record.expiryClaim)) {
            throw new Error('This balance was claimed after expiry. Open Balance details to start a new balance.');
        }
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

    get activeLateWithdrawal() {
        const noteId = this.note?.note_id;
        if (noteId == null) return null;
        return (this.config?.late_withdrawal_attempts || []).find(attempt =>
            Number(attempt.note_id) === Number(noteId)) || null;
    }

    get withdrawalBlocksChat() {
        return !!this.activeLateWithdrawal
            || !!this.config?.prepared_withdrawal
            || ['prepared', 'submitted', 'pending'].includes(this.withdrawal?.phase);
    }

    get activeWithdrawal() {
        return this.config?.prepared_withdrawal
            || this.withdrawal
            || (this.activeLateWithdrawal ? {
                phase: 'late_submitted',
                mode: this.activeLateWithdrawal.mode,
                noteId: this.activeLateWithdrawal.note_id,
                destination: this.activeLateWithdrawal.destination,
                transactionHash: this.activeLateWithdrawal.transaction_hash
            } : null);
    }

    get openWithdrawals() {
        return this.withdrawals.filter(record => record.phase !== 'closed'
            || record.finalizeTransactionHash
            || record.finalizeSubmissionId);
    }

    get unresolvedLateWithdrawals() {
        return [...(this.config?.late_withdrawal_attempts || [])];
    }

    get withdrawalRecoveryCount() {
        return this.openWithdrawals.length + this.unresolvedLateWithdrawals.length;
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

    formatBillingAmount(credits) {
        return formatTokenAmount(BigInt(credits || 0));
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

    async assertFundingChain() {
        const wanted = Number(this.config?.funding?.chain_id);
        if (!Number.isFinite(wanted) || !globalThis.ethereum) return;
        const current = Number.parseInt(
            await globalThis.ethereum.request({ method: 'eth_chainId' }),
            16
        );
        if (current !== wanted) {
            const error = new Error(`MetaMask changed networks. Switch back to ${this.networkName()} and try again.`);
            error.code = 'wrong_network';
            throw error;
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
        // Both published v2 vaults expose the original CHALLENGE_PERIOD()
        // getter. Probe it first so MetaMask does not report a benign
        // `execution reverted` RPC warning while connecting. Keep the newer
        // challengePeriod() getter as a forward-compatible fallback.
        for (const selector of [ABI.legacyChallengePeriod, ABI.challengePeriod]) {
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
        let consecutiveReadFailures = 0;
        for (let attempt = 0; attempt < 180; attempt += 1) {
            let receipt;
            try {
                receipt = await globalThis.ethereum.request({
                    method: 'eth_getTransactionReceipt',
                    params: [hash]
                });
                consecutiveReadFailures = 0;
            } catch (failure) {
                const error = normalizeWalletError(failure);
                // Receipt reads can briefly fail while the wallet switches
                // from its submitted transaction to the mined RPC record.
                // Retry reads only; the transaction hash is already journaled.
                consecutiveReadFailures += 1;
                if ([4001, 4100, 4200, 4901, -32600, -32601, -32602].includes(Number(walletErrorCode(error)))
                    || consecutiveReadFailures >= 3) {
                    throw error;
                }
                await new Promise(resolve => setTimeout(resolve, 1_000));
                continue;
            }
            if (receipt) {
                if (BigInt(receipt.status || '0x0') !== 1n) {
                    const error = new Error(`Transaction ${this.compact(hash)} reverted.`);
                    error.transactionReceipt = receipt;
                    throw error;
                }
                return receipt;
            }
            await new Promise(resolve => setTimeout(resolve, 1_000));
        }
        throw new Error(`Timed out waiting for transaction ${this.compact(hash)}.`);
    }

    async submittedTransactionMetadata(transactionHash, fallbackFrom = null) {
        try {
            const transaction = await globalThis.ethereum.request({
                method: 'eth_getTransactionByHash',
                params: [transactionHash]
            });
            const nonce = walletNonceNumber(transaction?.nonce);
            const from = transaction.from || fallbackFrom;
            if (nonce == null
                || !/^0x[0-9a-fA-F]{40}$/.test(from || '')) {
                return null;
            }
            return { from: from.toLowerCase(), nonce };
        } catch {
            // The hash itself is the critical write-ahead record. Metadata is
            // best-effort and can be retried while the transaction is visible.
            return null;
        }
    }

    async sendContractTransaction(
        from,
        to,
        data,
        onSubmitted = null,
        onPrepared = null,
        preparedNonce = null
    ) {
        const normalizedPreparedNonce = preparedNonce == null
            ? null
            : Number(preparedNonce);
        if (normalizedPreparedNonce != null
            && (!Number.isSafeInteger(normalizedPreparedNonce)
                || normalizedPreparedNonce < 0)) {
            throw tagTransactionError(
                new Error('The replacement transaction nonce is invalid.'),
                'journal',
                false
            );
        }
        const transaction = {
            from,
            to,
            data,
            ...(normalizedPreparedNonce == null
                ? {}
                : { nonce: `0x${normalizedPreparedNonce.toString(16)}` })
        };
        try {
            await this.assertFundingChain();
            // MetaMask falls back to a percentage of the block limit when its
            // own simulation fails. Since Ethereum's block limit can now be
            // higher than the EIP-7825 per-transaction cap, that fallback can
            // create an invalid 21M-gas transaction. Preflight the exact call
            // and set only a bounded gas limit; MetaMask still chooses all
            // EIP-1559 fee fields and the user remains in control of the rate.
            const estimate = await globalThis.ethereum.request({
                method: 'eth_estimateGas',
                params: [transaction]
            });
            transaction.gas = bufferedGasLimit(estimate);
        } catch (error) {
            if (error?.code === 'wrong_network'
                || error?.code === 'transaction_gas_limit_exceeded') {
                throw tagTransactionError(error, 'estimate', false);
            }
            throw tagTransactionError(contractEstimateError(error), 'estimate', false);
        }
        let hash;
        try {
            await this.assertFundingChain();
        } catch (error) {
            throw tagTransactionError(error, 'network-check', false);
        }
        if (onPrepared) {
            try {
                let nonce = normalizedPreparedNonce;
                if (nonce == null) {
                    const pendingNonce = await globalThis.ethereum.request({
                        method: 'eth_getTransactionCount',
                        params: [from, 'pending']
                    });
                    nonce = walletNonceNumber(pendingNonce);
                    if (nonce == null) {
                        throw new Error('MetaMask returned an invalid pending transaction nonce.');
                    }
                    transaction.nonce = `0x${nonce.toString(16)}`;
                }
                await onPrepared({ from: from.toLowerCase(), nonce });
            } catch (error) {
                throw tagTransactionError(error, 'journal', false);
            }
        }
        try {
            hash = await globalThis.ethereum.request({
                method: 'eth_sendTransaction',
                params: [transaction]
            });
        } catch (error) {
            if (isWalletRejection(error)) {
                throw tagTransactionError(error, 'send', false);
            }
            if (isDefinitelyPreBroadcastSendFailure(error)) {
                throw tagTransactionError(error, 'send', false);
            }
            if (contractRevertSelector(error)) {
                throw tagTransactionError(contractEstimateError(error), 'send', false);
            }
            // Some providers time out after accepting a transaction but
            // before returning its hash. Do not report that as cancellation.
            throw tagTransactionError(error, 'send', true);
        }
        try {
            if (onSubmitted) await onSubmitted(hash);
        } catch (error) {
            throw tagTransactionError(error, 'journal', true, hash);
        }
        try {
            return await this.waitForReceipt(hash);
        } catch (error) {
            throw tagTransactionError(error, 'receipt', true, hash);
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
            operationId: plan.operationId,
            secret: plan.secret,
            note_id: Number(deposited.noteId),
            amount: Number(plan.amount),
            commitment: plan.commitment,
            transactionHash: receipt.transactionHash,
            expiry_ts: Number(deposited.expiryTs)
        });
        await this.refresh();
        onStatus('Private balance is ready.');
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

    async readBrowserNote(noteId, requestedBlock = 'latest') {
        await this.assertFundingChain();
        const blockTag = requestedBlock || 'latest';
        const encoded = await globalThis.ethereum.request({
            method: 'eth_call',
            params: [{
                to: this.config.funding.contract_address,
                data: callData(ABI.notes, [abiWord(noteId)])
            }, blockTag]
        });
        const words = String(encoded || '').replace(/^0x/, '').match(/.{64}/g) || [];
        if (words.length < 4) throw new Error('The vault returned a truncated note record.');
        return {
            noteId: Number(noteId),
            commitment: `0x${words[0]}`,
            amount: BigInt(`0x${words[1]}`),
            expiryTs: Number(BigInt(`0x${words[2]}`)),
            status: Number(BigInt(`0x${words[3]}`)),
            observedBlock: /^0x[0-9a-fA-F]+$/.test(String(blockTag))
                ? Number(BigInt(blockTag))
                : null
        };
    }

    async recoverBrowserDeposit(onStatus = () => {}) {
        if (!this.browserMode) return null;
        const plan = await browserWalletRuntime.pendingDeposit();
        if (!plan) return null;
        onStatus('Checking the private-vault deposit…');
        const note = await this.readBrowserNote(plan.next_note_id);
        const matches = note.status !== 0
            && note.amount === BigInt(plan.amount)
            && BigInt(note.commitment) === BigInt(plan.commitment);
        if (matches) {
            if (note.status !== 1) {
                throw new Error('The recovered deposit exists, but its private note is no longer active.');
            }
            // Wait for the privacy-preserving whole-tree mirror before making
            // the recovered note available to chat requests.
            await browserWalletRuntime.treePath(Number(plan.next_note_id), true);
            await browserWalletRuntime.confirmDeposit({
                operationId: plan.operationId,
                secret: plan.secret,
                note_id: Number(plan.next_note_id),
                amount: Number(plan.amount),
                commitment: plan.commitment,
                expiry_ts: note.expiryTs
            });
            await this.refresh();
            onStatus('Deposit recovered. Your private balance is ready.');
            return {
                status: 'confirmed',
                noteId: Number(plan.next_note_id),
                amount: Number(plan.amount),
                receipt: null
            };
        }
        if (note.status !== 0) {
            const conflictFinality = await this.browserDepositSlotConflictFinality(plan);
            if (!conflictFinality.finalized) {
                await this.refresh({ quiet: true });
                onStatus('Another deposit currently occupies this slot. Waiting for chain finality before retrying safely.');
                return { status: 'slot_conflict_unconfirmed' };
            }
            // The exact append slot was consumed by a different commitment;
            // this plan can no longer succeed, so rebasing it is now safe.
            await browserWalletRuntime.resolvePendingDepositSlotConflict({
                operationId: plan.operationId,
                noteId: Number(plan.next_note_id),
                amount: Number(plan.amount),
                commitment: plan.commitment,
                phase: plan.phase || null,
                submissionId: plan.submissionId || null,
                transactionHashes: Array.isArray(plan.transactionHashes)
                    ? plan.transactionHashes
                    : plan.transactionHash ? [plan.transactionHash] : []
            });
            await this.refresh({ quiet: true });
            onStatus('The old deposit slot was used by another transaction. The deposit is ready to retry safely.');
            return { status: 'slot_consumed' };
        }

        const hashes = Array.isArray(plan.transactionHashes)
            ? plan.transactionHashes
            : plan.transactionHash ? [plan.transactionHash] : [];
        let pendingHash = null;
        const missingReceiptHashes = [];
        for (const hash of hashes) {
            let receipt = null;
            try {
                receipt = await globalThis.ethereum.request({
                    method: 'eth_getTransactionReceipt',
                    params: [hash]
                });
            } catch {
                // A replacement/cancel can make the original hash disappear.
                // Resolve it only from finalized nonce + empty-slot evidence.
            }
            if (!receipt) {
                const transactionAttempt = (plan.transactionAttempts || []).find(attempt =>
                    String(attempt.hash || '').toLowerCase() === String(hash).toLowerCase());
                const nonceStatus = await this.browserDepositNonceConsumed(
                    transactionAttempt,
                    Number(plan.next_note_id)
                );
                if (nonceStatus.consumed) {
                    await browserWalletRuntime.markPendingDepositRetryable(hash);
                } else {
                    pendingHash = pendingHash || hash;
                    missingReceiptHashes.push(hash);
                }
            } else if (BigInt(receipt.status || '0x0') !== 1n) {
                const finality = await this.browserRevertedReceiptFinality(hash, receipt);
                if (finality.finalized) {
                    await browserWalletRuntime.markPendingDepositRetryable(hash);
                } else {
                    // A status-0 receipt can disappear in a short reorg and
                    // later become a successful canonical deposit. Retain its
                    // exact WAL until the revert itself is finalized.
                    pendingHash = pendingHash || hash;
                }
            } else {
                throw new Error('The deposit transaction mined, but the latest vault read has not caught up yet. Check again shortly.');
            }
        }
        if (!pendingHash && plan.submissionId && plan.submissionFrom
            && Number.isSafeInteger(Number(plan.submissionNonce))) {
            const nonceStatus = await this.browserDepositNonceConsumed({
                from: plan.submissionFrom,
                nonce: Number(plan.submissionNonce)
            }, Number(plan.next_note_id));
            if (nonceStatus.consumed) {
                await browserWalletRuntime.markPendingDepositRetryable(null, {
                    operationId: plan.operationId,
                    submissionId: plan.submissionId,
                    noteId: Number(plan.next_note_id),
                    amount: Number(plan.amount),
                    commitment: plan.commitment,
                    deploymentId: browserWalletRuntime.manifest?.deployment_id,
                    chainId: Number(this.config.funding.chain_id),
                    contractAddress: this.config.funding.contract_address
                });
            }
        }
        await this.refresh({ quiet: true });
        if (pendingHash) {
            const current = await browserWalletRuntime.pendingDeposit();
            const currentHashes = Array.isArray(current?.transactionHashes)
                ? current.transactionHashes
                : current?.transactionHash ? [current.transactionHash] : [];
            const missingSet = new Set(missingReceiptHashes.map(hash => hash.toLowerCase()));
            const allReceiptsMissing = currentHashes.length > 0
                && currentHashes.every(hash => missingSet.has(hash.toLowerCase()));
            let marked = current;
            if (allReceiptsMissing) {
                marked = await browserWalletRuntime.markPendingDepositMissingReceipts(
                    currentHashes
                );
                await this.refresh({ quiet: true });
            }
            const hashSet = new Set(currentHashes.map(hash => String(hash).toLowerCase()));
            const replacementIdentities = new Set((marked?.transactionAttempts || [])
                .filter(attempt => hashSet.has(String(attempt.hash || '').toLowerCase())
                    && /^0x[0-9a-fA-F]{40}$/.test(attempt.from || '')
                    && Number.isSafeInteger(Number(attempt.nonce))
                    && Number(attempt.nonce) >= 0)
                .map(attempt => `${attempt.from.toLowerCase()}:${Number(attempt.nonce)}`));
            return {
                status: allReceiptsMissing ? 'dropped_or_pending' : 'submitted',
                transactionHash: pendingHash,
                replacement_available: allReceiptsMissing
                    && replacementIdentities.size === 1
                    && !marked?.submissionId
            };
        }
        const current = await browserWalletRuntime.pendingDeposit();
        return {
            status: current?.phase === 'ambiguous'
                ? 'ambiguous'
                : current?.phase || 'prepared'
        };
    }

    async recoverUnknownDeposit(onStatus = () => {}) {
        if (!this.browserMode) throw new Error('Wallet-request recovery is available in the browser wallet.');
        await browserWalletRuntime.markPendingDepositUnknown();
        await this.refresh();
        onStatus('The old wallet prompt was marked unresolved. Check the vault before retrying.');
        return this.config?.pending_deposit || null;
    }

    async retryUnknownDeposit(onStatus = () => {}) {
        if (!this.browserMode) throw new Error('Wallet-request recovery is available in the browser wallet.');
        const recovery = await this.recoverBrowserDeposit(onStatus);
        if (recovery?.status === 'confirmed') return recovery;
        const pending = await browserWalletRuntime.pendingDeposit();
        if (pending?.phase !== 'ambiguous') {
            throw new Error('There is no unresolved deposit request to retry.');
        }
        await browserWalletRuntime.authorizePendingDepositRetry();
        await this.refresh({ quiet: true });
        onStatus('Retry authorized. Opening the same deposit in MetaMask…');
        return this.deposit(formatTokenAmount(BigInt(pending.amount)), onStatus);
    }

    async retryDroppedDeposit(onStatus = () => {}) {
        if (!this.browserMode) {
            throw new Error('Deposit transaction replacement is available in the browser wallet.');
        }
        const current = await browserWalletRuntime.pendingDeposit();
        if (!current || current.phase !== 'dropped_or_pending') {
            throw new Error('Check the submitted deposit before replacing it.');
        }
        onStatus('Connecting to the MetaMask account that submitted this deposit…');
        const from = await this.connectWallet();
        const submission = await browserWalletRuntime.claimPendingDepositReplacement(from);
        const plan = submission.plan;
        let submittedHash = null;
        let submissionMetadata = {
            from: submission.replacementFrom,
            nonce: Number(submission.replacementNonce)
        };
        let receipt;
        try {
            onStatus('Confirm the exact same deposit in MetaMask. It reuses the original nonce, so only one version can execute.');
            receipt = await this.sendContractTransaction(
                from,
                this.config.funding.contract_address,
                encodeDeposit(plan, BigInt(plan.amount)),
                async hash => {
                    submittedHash = hash;
                    await browserWalletRuntime.rememberPendingDepositTransaction(
                        hash,
                        submission,
                        submissionMetadata
                    );
                    onStatus(`Deposit replacement submitted ${this.compact(hash)} · checking confirmation…`);
                },
                async metadata => {
                    submissionMetadata = metadata;
                    await browserWalletRuntime.rememberPendingDepositSubmissionMetadata(
                        submission,
                        metadata
                    );
                },
                submission.replacementNonce
            );
        } catch (error) {
            if (error?.transactionHash) {
                submittedHash = error.transactionHash;
                try {
                    await browserWalletRuntime.rememberPendingDepositTransaction(
                        submittedHash,
                        submission,
                        submissionMetadata
                    );
                } catch (journalError) {
                    error.journalRecoveryError = journalError;
                }
            } else {
                await browserWalletRuntime.releasePendingDepositReplacementClaim(
                    submission,
                    error?.message || 'MetaMask did not return a deposit replacement transaction ID.'
                );
                error.shortMessage = error?.broadcastPossible === false || isWalletRejection(error)
                    ? 'The deposit replacement was canceled before broadcast. The original transaction remains saved and can be replaced again.'
                    : 'MetaMask did not return a replacement transaction ID. The original deposit remains saved, and you can safely resubmit it with the same nonce.';
            }
            await this.refresh({ quiet: true });
            throw error;
        }
        return this.confirmBrowserDepositReceipt(
            plan,
            receipt,
            this.config.funding.contract_address,
            onStatus
        );
    }

    async deposit(amountInput, onStatus = () => {}) {
        const key = String(amountInput).trim();
        if (this.depositPromise) {
            if (this.depositPromiseKey === key) return this.depositPromise;
            throw new Error('A different deposit action is already running.');
        }
        const operation = this.performDeposit(amountInput, onStatus);
        this.depositPromise = operation;
        this.depositPromiseKey = key;
        try {
            return await operation;
        } finally {
            if (this.depositPromise === operation) {
                this.depositPromise = null;
                this.depositPromiseKey = null;
            }
        }
    }

    async performDeposit(amountInput, onStatus = () => {}) {
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
        let pendingDeposit = this.browserMode
            ? await browserWalletRuntime.pendingDeposit()
            : null;
        if (pendingDeposit) {
            const recovery = await this.recoverBrowserDeposit(onStatus);
            if (recovery?.status === 'confirmed') return recovery;
            pendingDeposit = await browserWalletRuntime.pendingDeposit();
            if (Number(pendingDeposit.amount) !== Number(amount)) {
                throw new Error('A previous deposit is unfinished. Recover or cancel its MetaMask prompt before changing the amount.');
            }
            if (recovery?.status === 'submitted') {
                throw new Error(`Deposit ${this.compact(recovery.transactionHash)} is still waiting for confirmation.`);
            }
            if (pendingDeposit.phase === 'awaiting_wallet') {
                throw new Error('This deposit may still be open in MetaMask. Check its status or mark the prompt closed.');
            }
            if (pendingDeposit.phase === 'ambiguous') {
                throw new Error('MetaMask did not return a deposit transaction ID. Check its status before explicitly retrying the same deposit.');
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
        let plan = this.browserMode
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

        let receipt;
        let submission = null;
        let submissionMetadata = null;
        const attempts = this.browserMode ? 3 : 1;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            if (this.browserMode && plan.phase !== 'retry_exact') {
                onStatus(attempt === 0
                    ? 'Checking the latest private-vault state…'
                    : 'The vault changed. Refreshing the deposit before retrying…');
                const expectedActiveRoot = await this.readContractUint(
                    vaultAddress,
                    `0x${ABI.currentRoot}`
                );
                plan = await browserWalletRuntime.refreshPendingDeposit(
                    Number(amount),
                    expectedActiveRoot
                );
            }
            if (this.browserMode) {
                submission = await browserWalletRuntime.claimPendingDepositSubmission();
                if (submission.transactionHash) {
                    onStatus(`Checking submitted deposit ${this.compact(submission.transactionHash)}…`);
                    receipt = await this.waitForReceipt(submission.transactionHash);
                    break;
                }
            }
            onStatus('Depositing into the private-note vault… confirm in MetaMask.');
            try {
                receipt = await this.sendContractTransaction(
                    address,
                    vaultAddress,
                    encodeDeposit(plan, amount),
                    this.browserMode
                        ? async hash => {
                            await browserWalletRuntime.rememberPendingDepositTransaction(
                                hash,
                                submission,
                                submissionMetadata
                            );
                            onStatus(`Deposit submitted ${this.compact(hash)} · waiting for confirmation…`);
                        }
                        : null,
                    this.browserMode
                        ? async metadata => {
                            submissionMetadata = metadata;
                            await browserWalletRuntime.rememberPendingDepositSubmissionMetadata(
                                submission,
                                metadata
                            );
                        }
                        : null
                );
                break;
            } catch (error) {
                if (this.browserMode && !error?.transactionHash && submission) {
                    if (error?.broadcastPossible === false || isWalletRejection(error)) {
                        await browserWalletRuntime.markPendingDepositRetryable(null, submission);
                    } else if (error?.broadcastPossible === true) {
                        await browserWalletRuntime.markPendingDepositAmbiguous(
                            submission,
                            error?.message || 'MetaMask did not return a transaction ID.'
                        );
                        error.shortMessage = 'MetaMask did not return a deposit transaction ID. Check the deposit status before retrying.';
                    }
                } else if (this.browserMode && error?.transactionHash) {
                    try {
                        await browserWalletRuntime.rememberPendingDepositTransaction(
                            error.transactionHash,
                            submission,
                            submissionMetadata
                        );
                    } catch (journalError) {
                        error.journalRecoveryError = journalError;
                    }
                }
                if (this.browserMode) await this.refresh({ quiet: true });
                if (!this.browserMode || error?.code !== 'stale_root' || attempt + 1 >= attempts) throw error;
                const recovery = await this.recoverBrowserDeposit(onStatus);
                if (recovery?.status === 'confirmed') return recovery;
                plan = await browserWalletRuntime.pendingDeposit();
                submission = null;
                submissionMetadata = null;
            }
        }
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
        onStatus('Private balance is ready.');
        return { noteId: Number(deposited.noteId), amount: Number(amount), receipt };
    }

    async withdraw(mode, onStatus = () => {}) {
        if (this.withdrawPromise) {
            if (this.withdrawPromiseKey === mode) return this.withdrawPromise;
            throw new Error('A different withdrawal action is already running.');
        }
        const operation = this.performWithdrawal(mode, onStatus);
        this.withdrawPromise = operation;
        this.withdrawPromiseKey = mode;
        try {
            return await operation;
        } finally {
            if (this.withdrawPromise === operation) {
                this.withdrawPromise = null;
                this.withdrawPromiseKey = null;
            }
        }
    }

    async performWithdrawal(mode, onStatus = () => {}) {
        const note = this.note;
        if (!note) throw new Error('There is no active private note to withdraw.');
        if (!['mutual', 'escape'].includes(mode)) throw new Error('Choose a valid withdrawal mode.');
        await this.assertBalanceNotClaimed(note.note_id);

        await this.settleActiveLease(onStatus);

        onStatus('Connecting to MetaMask…');
        const from = await this.connectWallet();
        // MetaMask connection can outlive a cross-tab update. Re-read the
        // durable plan under the wallet lock instead of trusting the UI/config
        // snapshot that existed before the prompt opened.
        const durablePrepared = this.browserMode
            ? await browserWalletRuntime.currentPreparedWithdrawal()
            : null;
        const prepared = this.browserMode && durablePrepared
            ? {
                mode: durablePrepared.mode,
                phase: durablePrepared.phase,
                destination: durablePrepared.destination,
                transaction_hash: durablePrepared.transactionHash || null,
                clearance_reserved: durablePrepared.clearanceReserved === true
                    || durablePrepared.mode === 'mutual'
            }
            : this.config?.prepared_withdrawal;
        if (prepared?.transaction_hash) mode = prepared.mode;
        // The connected account only pays gas. A resumed plan keeps its
        // original payout destination, so recovery remains permissionless and
        // a harmless account switch cannot strand the note.
        const destination = prepared?.destination || from;

        const withdrawal = {
            phase: 'prepared',
            mode,
            noteId: Number(note.note_id),
            destination
        };

        let plan;
        let receipt;
        let submittedHash = prepared?.transaction_hash || null;
        let submission = null;
        let submissionMetadata = null;
        const attempts = this.browserMode ? 3 : 1;
        try {
            if (this.browserMode && submittedHash) {
                // A broadcast hash owns recovery. Never read a new root or
                // replace its proof while the receipt is unknown: doing so can
                // sever the only durable link to a transaction already in the
                // mempool.
                plan = durablePrepared;
                if (!plan?.public_inputs) {
                    throw new Error('The submitted withdrawal proof is missing from this browser.');
                }
                onStatus(`Checking submitted transaction ${this.compact(submittedHash)}…`);
                receipt = await this.waitForReceipt(submittedHash);
            } else for (let attempt = 0; attempt < attempts; attempt += 1) {
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
                submittedHash = plan.transactionHash || submittedHash;
                this.rememberWithdrawal({
                    ...withdrawal,
                    phase: submittedHash ? 'submitted' : 'prepared',
                    transactionHash: submittedHash,
                    clearanceReserved: plan.clearanceReserved === true || mode === 'mutual'
                });
                if (this.config) {
                    this.config.prepared_withdrawal = {
                        mode,
                        phase: submittedHash ? 'submitted' : 'prepared',
                        note_id: withdrawal.noteId,
                        destination,
                        transaction_hash: submittedHash,
                        clearance_reserved: plan.clearanceReserved === true || mode === 'mutual'
                    };
                }
                const calldata = encodeWithdrawal(
                    plan,
                    mode,
                    destination,
                    this.config.funding.contract_address
                );
                if (this.browserMode) {
                    const claim = await browserWalletRuntime.claimPreparedWithdrawalSubmission();
                    submission = claim;
                    submittedHash = claim.transactionHash || submittedHash;
                }
                if (submittedHash) {
                    onStatus(`Checking submitted transaction ${this.compact(submittedHash)}…`);
                    receipt = await this.waitForReceipt(submittedHash);
                    break;
                }
                onStatus(mode === 'mutual'
                    ? 'Confirm the mutual close in MetaMask…'
                    : 'Confirm the escape-hatch start in MetaMask…');
                try {
                    receipt = await this.sendContractTransaction(
                        from,
                        this.config.funding.contract_address,
                        calldata,
                        this.browserMode
                            ? async hash => {
                                submittedHash = hash;
                                await browserWalletRuntime.rememberPreparedWithdrawalTransaction(
                                    hash,
                                    submission,
                                    submissionMetadata
                                );
                                const metadata = await this.submittedTransactionMetadata(hash, from);
                                if (metadata) {
                                    await browserWalletRuntime.rememberPreparedWithdrawalTransaction(
                                        hash,
                                        submission,
                                        metadata
                                    );
                                }
                                this.rememberWithdrawal({
                                    ...withdrawal,
                                    phase: 'submitted',
                                    transactionHash: hash,
                                    clearanceReserved: plan.clearanceReserved === true || mode === 'mutual'
                                });
                                onStatus(`Withdrawal submitted ${this.compact(hash)} · waiting for confirmation…`);
                            }
                            : null,
                        this.browserMode
                            ? async metadata => {
                                submissionMetadata = metadata;
                                await browserWalletRuntime.rememberPreparedWithdrawalSubmissionMetadata(
                                    submission,
                                    metadata
                                );
                            }
                            : null
                    );
                    break;
                } catch (error) {
                    if (!this.browserMode || error?.code !== 'stale_root' || attempt + 1 >= attempts) throw error;
                    await browserWalletRuntime.markPreparedWithdrawalRetryable(null, submission);
                    submission = null;
                    submissionMetadata = null;
                }
            }
        } catch (failure) {
            const error = normalizeWalletError(failure);
            if (this.browserMode) {
                const recoveredReceipt = await this.recoverFailedWithdrawalSubmission({
                    mode,
                    error,
                    submittedHash,
                    submission,
                    submissionMetadata,
                    from
                });
                // A polling failure can race mining. Recovery reads the saved
                // hash again; a successful receipt must continue through the
                // exact same event/identity and canonical-vault checks below.
                if (recoveredReceipt && BigInt(recoveredReceipt.status || '0x0') === 1n) {
                    receipt = recoveredReceipt;
                }
            }
            if (!receipt) throw error;
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
        const confirmed = await this.confirmMinedWithdrawalStatus(Number(note.note_id), receipt);
        if (mode === 'mutual') {
            if (confirmed.status !== 'closed') {
                throw new Error(`The vault still reports this private balance as ${confirmed.status}.`);
            }
            if (this.browserMode) {
                await browserWalletRuntime.detachClosedWithdrawal({
                    mode: 'mutual',
                    payoutVerified: true,
                    noteId: Number(note.note_id),
                    destination,
                    finalBalance: Number(event.finalBalance),
                    transactionHash: submittedHash || receipt?.transactionHash || null,
                    closeBlockNumber: Number(BigInt(receipt?.blockNumber || '0x0')),
                    lastObservedBlock: Number(confirmed.observed_block || 0),
                    clearanceReserved: true,
                    createdAt: plan.createdAt
                });
            }
            this.rememberWithdrawal(null);
            await this.refresh();
            onStatus(this.browserMode
                ? 'Withdrawal returned. Finality is being checked safely in the background.'
                : 'Withdrawal complete. The closed note was archived locally.');
            return { status: 'closed', event, receipt };
        }

        const deadline = Number(confirmed.challenge_deadline || event.challengeDeadline);
        if (confirmed.status !== 'pending_withdrawal' || !deadline) {
            throw new Error('The escape transaction mined, but the vault did not report its safety deadline.');
        }
        if (this.browserMode) {
            const record = await browserWalletRuntime.detachEscapeWithdrawal({
                noteId: Number(note.note_id),
                destination,
                finalBalance: Number(event.finalBalance),
                challengeDeadline: deadline,
                transactionHash: submittedHash || receipt?.transactionHash || null,
                startBlockNumber: Number(BigInt(receipt?.blockNumber || '0x0')),
                lastObservedBlock: Number(confirmed.observed_block || 0),
                createdAt: plan.createdAt
            });
            this.rememberWithdrawal(null);
            await this.refresh();
            onStatus('Escape started. You can add a new private balance while the safety window runs.');
            return {
                status: 'pending_withdrawal',
                deadline,
                event,
                receipt,
                recordId: record.recordId
            };
        }
        this.rememberWithdrawal({ ...withdrawal, phase: 'pending', challengeDeadline: deadline });
        await this.refresh();
        onStatus('Escape started. Return after the safety window to finalize.');
        return { status: 'pending_withdrawal', deadline, event, receipt };
    }

    async recoverFailedWithdrawalSubmission({
        mode,
        error,
        submittedHash,
        submission,
        submissionMetadata = null,
        from = null
    }) {
        if (error?.transactionHash) {
            // onSubmitted assigns the in-memory hash before its IndexedDB
            // write. Retry that idempotent write even when submittedHash is
            // already populated, so a one-shot journal failure cannot lose a
            // MetaMask transaction across reload.
            submittedHash = error.transactionHash;
            try {
                await browserWalletRuntime.rememberPreparedWithdrawalTransaction(
                    submittedHash,
                    submission,
                    submissionMetadata
                );
                const metadata = await this.submittedTransactionMetadata(submittedHash, from);
                if (metadata) {
                    await browserWalletRuntime.rememberPreparedWithdrawalTransaction(
                        submittedHash,
                        submission,
                        metadata
                    );
                }
            } catch (journalError) {
                error.journalRecoveryError = journalError;
            }
        }
        const prepared = browserWalletRuntime.snapshot().runtime?.preparedWithdrawal;
        // A takeover can leave another tab's hash in the durable plan while
        // this tab's MetaMask prompt is still open. Reconcile only the hash
        // owned by this operation; never mistake the other transaction for a
        // successful response to the prompt that just failed.
        const operationHash = submittedHash
            || (!submission ? prepared?.transactionHash : null)
            || null;
        let receipt = null;
        if (operationHash) {
            try {
                receipt = await globalThis.ethereum.request({
                    method: 'eth_getTransactionReceipt',
                    params: [operationHash]
                });
            } catch {
                // Provider ambiguity is not evidence that the transaction was
                // rejected. Keep the submitted hash for deterministic recovery.
            }
        }
        const reverted = receipt && BigInt(receipt.status || '0x0') !== 1n;
        const rejectedBeforeSubmission = !submittedHash && isWalletRejection(error);
        const definitelyNotSubmitted = !submittedHash && submission
            && (error?.broadcastPossible === false || rejectedBeforeSubmission);
        const clearanceReserved = prepared?.clearanceReserved === true
            || submission?.clearanceReserved === true
            || mode === 'mutual';
        let releasedBackgroundClaim = false;

        if (reverted) {
            const finality = await this.browserRevertedReceiptFinality(operationHash, receipt);
            if (finality.finalized) {
                await browserWalletRuntime.markPreparedWithdrawalRetryable(operationHash, submission);
            } else {
                error.shortMessage = 'The transaction currently shows as reverted, but that block is not final yet. It remains tracked and will be checked automatically.';
                error.withdrawalNeedsAction = true;
            }
        } else if (definitelyNotSubmitted) {
            // A failed estimate, wrong network, or explicit wallet rejection
            // happened before broadcast, so this exact claim is safe to release.
            const released = await browserWalletRuntime
                .releaseBackgroundWithdrawalStartSubmission(submission);
            releasedBackgroundClaim = ['background', 'both'].includes(released?.location);
        } else if (!submittedHash && submission && error?.broadcastPossible === true) {
            if (submission.replacementNonce != null
                && Number.isSafeInteger(Number(submission.replacementNonce))) {
                // Every replacement deliberately reuses the same account
                // nonce. Even if this call was accepted before the provider
                // timed out, another exact replacement cannot execute twice.
                await browserWalletRuntime.releaseBackgroundWithdrawalStartSubmission(
                    submission,
                    {
                        replacementUnknown: true,
                        message: error?.message
                            || 'MetaMask did not return a replacement transaction ID.'
                    }
                );
                error.shortMessage = 'MetaMask did not return a replacement transaction ID. The original hashes remain saved, and you can check or safely resubmit with the same nonce.';
            } else {
                // A first submission has no prior nonce-equivalent hash to
                // constrain an explicit retry. Preserve its claim until the
                // user checks the vault and deliberately authorizes retry.
                await browserWalletRuntime.markPreparedWithdrawalAmbiguous(
                    submission,
                    error?.message || 'MetaMask did not return a transaction ID.'
                );
                error.shortMessage = 'MetaMask did not return a transaction ID. Check the withdrawal status; retry only if the vault still shows this balance as active.';
            }
            error.withdrawalNeedsAction = true;
        }
        if (definitelyNotSubmitted && mode === 'escape' && !clearanceReserved) {
            if (releasedBackgroundClaim) {
                this.rememberWithdrawal(null, { emit: false });
                error.shortMessage = 'MetaMask canceled this prompt before broadcast. The earlier submitted withdrawal remains saved in the background and does not block a new private balance.';
                error.withdrawalNeedsAction = true;
                await this.refresh({ quiet: true });
                return;
            }
            const remaining = browserWalletRuntime.snapshot().runtime?.preparedWithdrawal;
            const remainingHashes = Array.isArray(remaining?.transactionHashes)
                ? remaining.transactionHashes
                : remaining?.transactionHash ? [remaining.transactionHash] : [];
            if (!remainingHashes.length) {
                await browserWalletRuntime.clearPreparedWithdrawal();
                this.rememberWithdrawal(null, { emit: false });
                error.shortMessage = rejectedBeforeSubmission
                    ? 'MetaMask canceled the escape. No funds moved, and your private balance is ready to use.'
                    : 'The wallet refused the escape before broadcast. No funds moved, and your private balance is ready to use.';
            } else {
                error.shortMessage = 'MetaMask canceled this prompt. Another submitted withdrawal is still being checked.';
            }
        } else if (definitelyNotSubmitted) {
            error.shortMessage = releasedBackgroundClaim
                ? 'MetaMask canceled this prompt before broadcast. The earlier submitted withdrawal remains saved in the background.'
                : rejectedBeforeSubmission
                    ? 'MetaMask canceled the transaction. No funds moved; this balance is safely ready to withdraw. Finish the close or switch to the escape hatch.'
                    : 'The wallet refused the transaction before broadcast. No funds moved; this balance remains safely ready to withdraw.';
            error.withdrawalNeedsAction = true;
        }
        await this.refresh({ quiet: true });
        return receipt
            && String(receipt.transactionHash || '').toLowerCase() === String(operationHash || '').toLowerCase()
            ? receipt
            : null;
    }

    async recoverUnknownWithdrawal(onStatus = () => {}) {
        if (!this.browserMode) throw new Error('Wallet-request recovery is available in the browser wallet.');
        await browserWalletRuntime.markPreparedWithdrawalUnknown();
        await this.refresh();
        onStatus('The old wallet prompt was marked unresolved. Check the vault before retrying.');
        return this.withdrawal;
    }

    async retryUnknownWithdrawal(onStatus = () => {}) {
        if (!this.browserMode) throw new Error('Wallet-request recovery is available in the browser wallet.');
        const prepared = this.config?.prepared_withdrawal;
        if (prepared?.phase !== 'ambiguous') {
            throw new Error('There is no unresolved withdrawal request to retry.');
        }
        await browserWalletRuntime.authorizePreparedWithdrawalRetry();
        await this.refresh({ quiet: true });
        onStatus('Retry authorized. Opening a new MetaMask request…');
        return this.withdraw(prepared.mode, onStatus);
    }

    async retryDroppedWithdrawal(onStatus = () => {}) {
        if (!this.browserMode) {
            throw new Error('Transaction replacement is available in the browser wallet.');
        }
        const current = await browserWalletRuntime.currentPreparedWithdrawal();
        if (!current || current.phase !== 'dropped_or_pending') {
            throw new Error('Check the withdrawal before replacing it.');
        }
        await this.assertBalanceNotClaimed(current.noteId ?? current.public_inputs?.note_id ?? this.note?.note_id);
        onStatus('Connecting to the MetaMask account that submitted this withdrawal…');
        const from = await this.connectWallet();
        const submission = await browserWalletRuntime.claimPreparedWithdrawalReplacement(from);
        const plan = submission.plan;
        const mode = plan.mode === 'mutual' ? 'mutual' : 'escape';
        let submittedHash = null;
        let submissionMetadata = {
            from: submission.replacementFrom,
            nonce: Number(submission.replacementNonce)
        };
        try {
            onStatus('Confirm the exact same withdrawal in MetaMask. It reuses the original nonce, so only one version can execute.');
            await this.sendContractTransaction(
                from,
                this.config.funding.contract_address,
                encodeWithdrawal(
                    plan,
                    mode,
                    plan.destination,
                    this.config.funding.contract_address
                ),
                async hash => {
                    submittedHash = hash;
                    await browserWalletRuntime.rememberPreparedWithdrawalTransaction(
                        hash,
                        submission,
                        submissionMetadata
                    );
                    onStatus(`Replacement submitted ${this.compact(hash)} · checking confirmation…`);
                },
                async metadata => {
                    submissionMetadata = metadata;
                    await browserWalletRuntime.rememberPreparedWithdrawalSubmissionMetadata(
                        submission,
                        metadata
                    );
                },
                submission.replacementNonce
            );
        } catch (error) {
            await this.recoverFailedWithdrawalSubmission({
                mode,
                error,
                submittedHash,
                submission,
                submissionMetadata,
                from
            });
            throw error;
        }
        await this.refresh({ quiet: true });
        return this.syncWithdrawal(onStatus);
    }

    async withdrawBackground(recordId, onStatus = () => {}) {
        if (!this.browserMode) throw new Error('Background withdrawals require the browser wallet.');
        this.backgroundWithdrawalPromises ||= new Map();
        if (this.backgroundWithdrawalPromises.has(recordId)) {
            return this.backgroundWithdrawalPromises.get(recordId);
        }
        const operation = this.performBackgroundWithdrawal(recordId, onStatus);
        this.backgroundWithdrawalPromises.set(recordId, operation);
        try {
            return await operation;
        } finally {
            if (this.backgroundWithdrawalPromises.get(recordId) === operation) {
                this.backgroundWithdrawalPromises.delete(recordId);
            }
        }
    }

    async cancelBackgroundWithdrawalPreparation(recordId, onStatus = () => {}) {
        if (!this.browserMode) throw new Error('This recovery belongs to the browser wallet.');
        await browserWalletRuntime.cancelBackgroundWithdrawalPreparation(recordId);
        await this.refresh({ quiet: true });
        onStatus('Preparation canceled. The set-aside balance is ready to withdraw again.');
    }

    async performBackgroundWithdrawal(recordId, onStatus) {
        onStatus('Checking the set-aside balance…', 'preparing');
        await this.syncEscapeWithdrawals(() => {}, recordId);
        const record = await browserWalletRuntime.currentWithdrawal(recordId);
        if (!record || record.mode !== 'mutual'
            || !['parked', 'restored'].includes(record.phase)) {
            throw new Error('Check this withdrawal’s status before trying to finish it.');
        }
        // This path deliberately never selects the old note or settles the
        // current chat. The retained destination receives the old balance;
        // the connected account only authorizes and pays for this transaction.
        const noteId = Number(record.noteId);
        const destination = record.destination;
        await this.assertBalanceNotClaimed(noteId);
        onStatus('Connecting to MetaMask for the set-aside balance…');
        const from = await this.connectWallet();
        let receipt;
        let plan;
        let submittedHash = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            let submission = null;
            let metadata = null;
            try {
                const canonical = await this.readBrowserWithdrawalStatus(noteId);
                if (canonical.status !== 'active' || Number(canonical.observed_block || 0)
                    < Math.max(Number(record.startBlockNumber || 0), Number(record.lastObservedBlock || 0))) {
                    await this.syncEscapeWithdrawals(() => {}, recordId);
                    throw new Error('The vault state changed. Check this withdrawal’s status before retrying.');
                }
                onStatus(attempt === 0
                    ? 'Preparing the old balance’s withdrawal proof…'
                    : 'The vault changed. Updating the old balance’s proof…', 'preparing');
                const expectedActiveRoot = await this.readContractUint(
                    this.config.funding.contract_address, `0x${ABI.currentRoot}`
                );
                plan = await browserWalletRuntime.prepareBackgroundWithdrawal(recordId, { expectedActiveRoot });
                if (plan.mode !== 'mutual' || Number(plan.public_inputs?.note_id) !== noteId
                    || plan.destination?.toLowerCase() !== destination?.toLowerCase()
                    || Number(plan.public_inputs?.final_balance) !== Number(record.finalBalance)) {
                    throw new Error('The withdrawal proof does not match this set-aside balance.');
                }
                const calldata = encodeWithdrawal(plan, 'mutual', destination, this.config.funding.contract_address);
                submission = await browserWalletRuntime.claimBackgroundWithdrawalSubmission(recordId, plan.operationId);
                onStatus('Confirm the set-aside withdrawal in MetaMask. Your current balance is unchanged.', 'wallet');
                receipt = await this.sendContractTransaction(
                    from, this.config.funding.contract_address, calldata,
                    async hash => {
                        submittedHash = hash;
                        await browserWalletRuntime.rememberBackgroundWithdrawalTransaction(hash, submission, metadata);
                        onStatus('Withdrawal submitted. Checking confirmation…', 'confirming');
                    },
                    async value => {
                        metadata = value;
                        await browserWalletRuntime.rememberBackgroundWithdrawalSubmissionMetadata(submission, value);
                    }
                );
                break;
            } catch (failure) {
                const error = normalizeWalletError(failure);
                submittedHash = submittedHash || error.transactionHash || null;
                if (submission && submittedHash) {
                    // A returned hash owns recovery even if its first journal
                    // write or the receipt poll failed. Never prepare a new
                    // proof/nonce after this boundary.
                    try {
                        await browserWalletRuntime.rememberBackgroundWithdrawalTransaction(submittedHash, submission, metadata);
                    } catch (journalError) {
                        error.journalRecoveryError = journalError;
                    }
                    error.shortMessage = 'The submitted withdrawal is saved for recovery. Check its status; your current balance is unchanged.';
                } else if (submission && (error.broadcastPossible === false || isWalletRejection(error))) {
                    await browserWalletRuntime.releaseBackgroundWithdrawalSubmission(submission);
                    if (error.code === 'stale_root' && attempt < 2) continue;
                    if (isWalletRejection(error)) {
                        error.shortMessage = 'Canceled. The old balance is still set aside and can be withdrawn later.';
                    }
                } else if (submission) {
                    await browserWalletRuntime.markBackgroundWithdrawalAmbiguous(submission, error.message);
                    error.shortMessage = 'MetaMask did not return a transaction ID. Check this withdrawal’s status before retrying; your current balance is unchanged.';
                }
                await this.refresh({ quiet: true });
                throw error;
            }
        }
        const event = parseWithdrawalReceipt(receipt, this.config.funding.contract_address, 'mutual');
        if (!event || event.noteId !== BigInt(noteId)
            || event.destination.toLowerCase() !== destination.toLowerCase()
            || event.finalBalance !== BigInt(plan.public_inputs.final_balance)) {
            throw new Error('The transaction receipt did not match the set-aside withdrawal. Its transaction remains saved for checking.');
        }
        const confirmed = await this.confirmMinedWithdrawalStatus(noteId, receipt);
        if (confirmed.status !== 'closed'
            || Number(confirmed.observed_block || 0) < Number(BigInt(receipt.blockNumber || '0x0'))) {
            const error = new Error('The withdrawal transaction was mined. Its current vault status is still being checked.');
            error.withdrawalConfirmationPending = true;
            throw error;
        }
        // Reconciliation validates the same receipt and updates only the
        // background record. Recovery material is retained until finality.
        await this.syncEscapeWithdrawals(() => {}, recordId);
        await this.refresh({ quiet: true });
        onStatus(`${this.formatMoney(event.finalBalance)} returned. Your current balance is unchanged.`);
        return { status: 'closed', event, receipt, recordId };
    }

    async retryDroppedBackgroundWithdrawal(recordId, onStatus = () => {}) {
        if (!this.browserMode) {
            throw new Error('Background transaction replacement is available in the browser wallet.');
        }
        const current = await browserWalletRuntime.currentWithdrawal(recordId);
        const hasReplaceableLiveClaim = Boolean(current?.startSubmissionId
            && /^0x[0-9a-fA-F]{40}$/.test(current.startSubmissionFrom || '')
            && Number.isSafeInteger(Number(current.startSubmissionNonce))
            && Number(current.startSubmissionNonce) >= 0);
        const hasSavedRetryIdentity = Boolean(!current?.startSubmissionId
            && /^0x[0-9a-fA-F]{40}$/.test(current?.startRetryFrom || '')
            && Number.isSafeInteger(Number(current?.startRetryNonce))
            && Number(current.startRetryNonce) >= 0);
        if (!current || current.phase !== 'submitted_unconfirmed'
            || current.chainStatus !== 'active'
            || (!hasReplaceableLiveClaim && !hasSavedRetryIdentity
                && !['receipt_missing', 'replacement_result_unknown']
                    .includes(current.startSubmissionOutcome))) {
            throw new Error('Check the background withdrawal before replacing it.');
        }
        await this.assertBalanceNotClaimed(current.noteId);
        onStatus('Connecting to the MetaMask account that submitted this withdrawal…');
        const from = await this.connectWallet();
        const submission = await browserWalletRuntime
            .claimBackgroundWithdrawalStartReplacement(recordId, from);
        const plan = submission.plan;
        const mode = plan.mode === 'mutual' ? 'mutual' : 'escape';
        let submittedHash = null;
        const submissionMetadata = {
            from: submission.replacementFrom,
            nonce: Number(submission.replacementNonce)
        };
        try {
            onStatus('Confirm the same background withdrawal in MetaMask. It reuses the original nonce, so only one version can execute.');
            await this.sendContractTransaction(
                from,
                this.config.funding.contract_address,
                encodeWithdrawal(
                    plan,
                    mode,
                    plan.destination,
                    this.config.funding.contract_address
                ),
                async hash => {
                    submittedHash = hash;
                    // The selected slot may contain a fresh note. Journal this
                    // returned hash as a late attempt; the background reconciler
                    // atomically joins it to the retained old-note record.
                    await browserWalletRuntime.rememberPreparedWithdrawalTransaction(
                        hash,
                        submission,
                        submissionMetadata
                    );
                    onStatus(`Background replacement submitted ${this.compact(hash)} · checking confirmation…`);
                },
                null,
                submission.replacementNonce
            );
        } catch (error) {
            if (error?.transactionHash) {
                submittedHash = error.transactionHash;
                try {
                    await browserWalletRuntime.rememberPreparedWithdrawalTransaction(
                        submittedHash,
                        submission,
                        submissionMetadata
                    );
                } catch (journalError) {
                    error.journalRecoveryError = journalError;
                }
                error.shortMessage = 'The replacement transaction remains saved in the background and will keep being checked.';
            } else {
                const replacementUnknown = error?.broadcastPossible !== false
                    && !isWalletRejection(error);
                await browserWalletRuntime.releaseBackgroundWithdrawalStartSubmission(
                    submission,
                    {
                        replacementUnknown,
                        message: error?.message
                            || 'MetaMask did not return a background replacement transaction ID.'
                    }
                );
                error.shortMessage = error?.broadcastPossible === false || isWalletRejection(error)
                    ? 'The background replacement was canceled before broadcast. Its original transaction remains saved and can be replaced again.'
                    : 'MetaMask did not return a replacement transaction ID. The original background transaction remains saved, and the same nonce can be retried.';
            }
            await this.refresh({ quiet: true });
            throw error;
        }
        await this.refresh({ quiet: true });
        const lateResults = await this.syncLateWithdrawalAttempts(onStatus);
        const backgroundResults = await this.syncEscapeWithdrawals(onStatus, recordId);
        return backgroundResults[0]
            || lateResults.find(result => result?.attempt?.operationId === submission.operationId)
            || { status: 'submitted', transaction_hash: submittedHash };
    }

    async settleActiveLease(onStatus = () => {}, { sessionId = null } = {}) {
        // The legacy daemon's settlement endpoint has no expected-owner
        // parameter. Never issue a global settlement for a mode change.
        if (sessionId && !this.browserMode) {
            if (await this.getPendingLeaseOwner() !== sessionId) return;
            throw new Error('Close the active private key in the local daemon before using zkAPI again.');
        }
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
                ? sessionId
                    ? await browserWalletRuntime.settleSessionLease(sessionId, report)
                    : await browserWalletRuntime.settleActiveLease(report)
                : await this.apiJson('/wallet/settle', { method: 'POST' });
            await this.refresh({ quiet: true });
            if (sessionId ? await this.getPendingLeaseOwner() === sessionId
                : this.activeLease || this.wallet?.pending_request) {
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

    async getPendingLeaseOwner() {
        await this.init();
        if (this.browserMode) {
            return browserWalletRuntime.getPendingLeaseOwner();
        }
        return this.config?.active_lease?.session_id || null;
    }

    async syncLateWithdrawalAttempts(onStatus = () => {}) {
        if (!this.browserMode) return [];
        const terminal = new Set([
            'closed',
            'detached',
            'reverted',
            'challenged',
            'superseded',
            'quarantined'
        ]);
        const attempts = (await browserWalletRuntime.currentLateWithdrawalAttempts())
            .filter(attempt => !terminal.has(attempt.status));
        const results = [];
        let changed = false;
        const transferCanonicalAttempt = async (attempt, canonical, metadata = {}) => {
            const mode = attempt.mode === 'mutual' ? 'mutual' : 'escape';
            const recordId = browserWalletRuntime.withdrawalRecordId(attempt.noteId);
            const background = await browserWalletRuntime.currentWithdrawal(recordId);
            const selectedState = browserWalletRuntime.snapshot().runtime?.state;
            const selectedOwns = Number(selectedState?.note_id) === Number(attempt.noteId);
            const destination = canonical.destination
                || background?.destination
                || attempt.destination
                || null;
            const finalBalance = Number(canonical.final_balance
                ?? background?.finalBalance
                ?? attempt.finalBalance
                ?? (selectedOwns ? selectedState?.current_balance : NaN));
            if (!/^0x[0-9a-fA-F]{40}$/.test(destination || '')
                || !Number.isSafeInteger(finalBalance)) {
                return null;
            }
            if (canonical.status === 'closed') {
                await browserWalletRuntime.transferLateWithdrawalAttempt(attempt, {
                    recordId,
                    mode,
                    phase: 'closed_unconfirmed',
                    chainStatus: 'closed',
                    payoutVerified: false,
                    noteId: Number(attempt.noteId),
                    destination,
                    finalBalance,
                    transactionHash: background?.transactionHash || attempt.transactionHash,
                    closeBlockNumber: Math.max(
                        Number(background?.closeBlockNumber || 0),
                        Number(metadata.receiptBlock || 0),
                        Number(canonical.observed_block || 0)
                    ),
                    lastObservedBlock: Math.max(
                        Number(background?.lastObservedBlock || 0),
                        Number(canonical.observed_block || 0)
                    ),
                    canonicalRecovery: true,
                    clearanceReserved: attempt.clearanceReserved === true || mode === 'mutual',
                    closedAt: Number(background?.closedAt || Date.now()),
                    error: metadata.error || null
                });
                return { ...canonical, attempt, recoveredByCanonicalState: true };
            }
            if (canonical.status === 'pending_withdrawal' && mode === 'escape') {
                await browserWalletRuntime.transferLateWithdrawalAttempt(attempt, {
                    recordId,
                    mode: 'escape',
                    phase: 'pending',
                    chainStatus: 'pending_withdrawal',
                    noteId: Number(attempt.noteId),
                    destination,
                    finalBalance,
                    challengeDeadline: Number(canonical.challenge_deadline),
                    transactionHash: background?.transactionHash || attempt.transactionHash,
                    startBlockNumber: Math.max(
                        Number(background?.startBlockNumber || 0),
                        Number(metadata.receiptBlock || 0)
                    ),
                    lastObservedBlock: Math.max(
                        Number(background?.lastObservedBlock || 0),
                        Number(canonical.observed_block || 0)
                    ),
                    canonicalRecovery: true,
                    clearanceReserved: attempt.clearanceReserved === true,
                    error: metadata.error || null
                });
                return { ...canonical, attempt, recoveredByCanonicalState: true };
            }
            if (canonical.status === 'active' && metadata.allowActive === true
                && ((selectedOwns && !background) || background?.state)) {
                await browserWalletRuntime.transferLateWithdrawalAttempt(attempt, {
                    recordId,
                    mode,
                    phase: 'submitted_unconfirmed',
                    chainStatus: 'active',
                    noteId: Number(attempt.noteId),
                    destination,
                    finalBalance,
                    transactionHash: attempt.transactionHash,
                    lastObservedBlock: Number(canonical.observed_block || 0),
                    clearanceReserved: attempt.clearanceReserved === true || mode === 'mutual',
                    error: null
                });
                return {
                    ...canonical,
                    status: 'submitted_unconfirmed',
                    attempt,
                    recordId,
                    movedToBackground: true
                };
            }
            return null;
        };
        const resolveFinalizedReplacement = async (attempt, canonical) => {
            if (canonical.status !== 'active') return null;
            const nonceStatus = await this.browserTransactionNonceConsumed(
                attempt,
                attempt.noteId,
                'active',
                Number(canonical.observed_block || 0)
            );
            if (!nonceStatus.consumed) return null;
            if (attempt.clearanceReserved === true || attempt.mode === 'mutual') {
                await browserWalletRuntime.resolveLateChallengedWithdrawalAttempt(attempt);
            } else {
                await browserWalletRuntime.updateLateWithdrawalAttempt(
                    attempt.operationId,
                    attempt.transactionHash,
                    {
                        status: 'superseded',
                        resolvedAt: Date.now(),
                        resolution: 'finalized_nonce_consumed',
                        finalityCheckedBlock: nonceStatus.checkedBlock,
                        finalitySource: nonceStatus.source,
                        error: null
                    },
                    { expectedStatus: attempt.status }
                );
            }
            return {
                status: 'replaced_or_canceled',
                canonicalStatus: canonical.status,
                finalityCheckedBlock: nonceStatus.checkedBlock,
                attempt
            };
        };

        for (const attempt of attempts) {
            try {
            const sameDeployment = attempt.deploymentId === browserWalletRuntime.manifest?.deployment_id
                && Number(attempt.chainId) === Number(this.config?.funding?.chain_id)
                && String(attempt.contractAddress || '').toLowerCase()
                    === String(this.config?.funding?.contract_address || '').toLowerCase();
            if (!sameDeployment || !/^0x[0-9a-fA-F]{64}$/.test(attempt.transactionHash || '')) {
                await browserWalletRuntime.updateLateWithdrawalAttempt(
                    attempt.operationId,
                    attempt.transactionHash,
                    {
                        status: 'quarantined',
                        resolvedAt: Date.now(),
                        error: 'This saved wallet callback did not match the active zkAPI deployment.'
                    },
                    { expectedStatus: attempt.status }
                );
                results.push({ status: 'invalid_identity', attempt });
                changed = true;
                continue;
            }

            let receipt = null;
            try {
                receipt = await globalThis.ethereum.request({
                    method: 'eth_getTransactionReceipt',
                    params: [attempt.transactionHash]
                });
            } catch (error) {
                // A wallet can throw for a pruned or replaced hash even while
                // ordinary vault reads still work. Canonical note state can
                // safely recover a replacement that moved this exact note.
                try {
                    const canonical = await this.readBrowserWithdrawalStatus(attempt.noteId);
                    const recovered = await transferCanonicalAttempt(attempt, canonical, {
                        error: `The saved transaction hash was unavailable: ${error.message}`,
                        allowActive: true
                    });
                    if (recovered) {
                        results.push({ ...recovered, replaced: true });
                        changed = true;
                        continue;
                    }
                    const resolvedReplacement = await resolveFinalizedReplacement(
                        attempt,
                        canonical
                    );
                    if (resolvedReplacement) {
                        results.push(resolvedReplacement);
                        changed = true;
                        continue;
                    }
                    results.push({
                        status: 'provider_unavailable',
                        canonicalStatus: canonical.status,
                        attempt,
                        error: error.message
                    });
                } catch (canonicalError) {
                    results.push({
                        status: 'provider_unavailable',
                        attempt,
                        error: `${error.message}; vault check failed: ${canonicalError.message}`
                    });
                }
                continue;
            }
            const mode = attempt.mode === 'mutual' ? 'mutual' : 'escape';
            if (!receipt) {
                // MetaMask replacement/speed-up transactions use a new hash.
                // The original hash may therefore have no receipt even though
                // the exact note has already moved on-chain. Canonical vault
                // state is sufficient to transfer the recovery material; the
                // closed state is still retained through Ethereum finality.
                const canonical = await this.readBrowserWithdrawalStatus(attempt.noteId);
                const resolvedReplacement = await resolveFinalizedReplacement(
                    attempt,
                    canonical
                );
                if (resolvedReplacement) {
                    results.push(resolvedReplacement);
                    changed = true;
                    continue;
                }
                const recovered = await transferCanonicalAttempt(attempt, canonical, {
                    allowActive: true
                });
                if (recovered) {
                    results.push({ ...recovered, replaced: true });
                    changed = true;
                    continue;
                }
                results.push({ status: 'submitted', canonicalStatus: canonical.status, attempt });
                continue;
            }
            if (BigInt(receipt.status || '0x0') !== 1n) {
                const finality = await this.browserRevertedReceiptFinality(
                    attempt.transactionHash,
                    receipt
                );
                await browserWalletRuntime.updateLateWithdrawalAttempt(
                    attempt.operationId,
                    attempt.transactionHash,
                    {
                        status: finality.finalized
                            ? 'reverted'
                            : 'reverted_unconfirmed',
                        receiptBlockNumber: receipt.blockNumber
                            ? Number(BigInt(receipt.blockNumber))
                            : null,
                        receiptBlockHash: receipt.blockHash || null,
                        finalityCheckedBlock: Number(finality.checkedBlock || 0),
                        finalitySource: finality.source,
                        resolvedAt: finality.finalized ? Date.now() : null,
                        error: null
                    },
                    { expectedStatus: attempt.status }
                );
                results.push({
                    status: finality.finalized ? 'reverted' : 'reverted_unconfirmed',
                    attempt,
                    finalityPending: !finality.finalized
                });
                changed = true;
                continue;
            }
            const event = parseWithdrawalReceipt(
                receipt,
                this.config.funding.contract_address,
                mode
            );
            const expectedFinalBalance = Number(attempt.finalBalance);
            if (!event || event.noteId !== BigInt(attempt.noteId)
                || event.destination.toLowerCase() !== String(attempt.destination || '').toLowerCase()
                || (Number.isSafeInteger(expectedFinalBalance)
                    && event.finalBalance !== BigInt(expectedFinalBalance))) {
                const receiptBlock = Number(BigInt(receipt.blockNumber || '0x0'));
                let canonical = await this.readBrowserWithdrawalStatus(attempt.noteId);
                if (Number(canonical.observed_block || 0) < receiptBlock) {
                    canonical = await this.readBrowserWithdrawalStatus(attempt.noteId);
                }
                if (Number(canonical.observed_block || 0) >= receiptBlock) {
                    const recoveryError = 'The saved transaction receipt did not match this withdrawal; the canonical vault state was used for recovery.';
                    const recovered = await transferCanonicalAttempt(attempt, canonical, {
                        receiptBlock,
                        error: recoveryError
                    });
                    if (recovered) {
                        results.push(recovered);
                        changed = true;
                        continue;
                    }
                    if (canonical.status === 'active') {
                        await browserWalletRuntime.updateLateWithdrawalAttempt(
                            attempt.operationId,
                            attempt.transactionHash,
                            {
                                status: 'superseded',
                                resolvedAt: Date.now(),
                                error: null
                            },
                            { expectedStatus: attempt.status }
                        );
                        results.push({ status: 'unrelated_transaction', attempt });
                        changed = true;
                        continue;
                    }
                }
                await browserWalletRuntime.updateLateWithdrawalAttempt(
                    attempt.operationId,
                    attempt.transactionHash,
                    {
                        status: 'receipt_mismatch',
                        error: 'The transaction receipt does not match its saved withdrawal identity.'
                    },
                    { expectedStatus: attempt.status }
                );
                results.push({ status: 'receipt_mismatch', attempt });
                changed = true;
                continue;
            }

            const receiptBlock = Number(BigInt(receipt.blockNumber || '0x0'));
            let canonical = await this.readBrowserWithdrawalStatus(attempt.noteId);
            if (Number(canonical.observed_block || 0) < receiptBlock) {
                canonical = await this.readBrowserWithdrawalStatus(attempt.noteId);
            }
            if (Number(canonical.observed_block || 0) < receiptBlock) {
                results.push({ status: 'rpc_behind', attempt });
                continue;
            }

            const recordId = browserWalletRuntime.withdrawalRecordId(attempt.noteId);
            const background = await browserWalletRuntime.currentWithdrawal(recordId);
            if (canonical.status === 'closed') {
                await browserWalletRuntime.transferLateWithdrawalAttempt(attempt, {
                    recordId,
                    mode,
                    phase: 'closed_unconfirmed',
                    chainStatus: 'closed',
                    noteId: Number(attempt.noteId),
                    destination: event.destination,
                    finalBalance: Number(event.finalBalance),
                    payoutVerified: mode === 'mutual',
                    transactionHash: background?.transactionHash || attempt.transactionHash,
                    closeBlockNumber: Math.max(
                        Number(background?.closeBlockNumber || 0),
                        mode === 'mutual' ? receiptBlock : Number(canonical.observed_block)
                    ),
                    lastObservedBlock: Math.max(
                        Number(background?.lastObservedBlock || 0),
                        Number(canonical.observed_block)
                    ),
                    clearanceReserved: attempt.clearanceReserved === true || mode === 'mutual',
                    closedAt: Number(background?.closedAt || Date.now()),
                    error: null
                });
                results.push({ ...canonical, attempt });
                changed = true;
                continue;
            }

            if (canonical.status === 'pending_withdrawal' && mode === 'escape') {
                await browserWalletRuntime.transferLateWithdrawalAttempt(attempt, {
                    recordId,
                    mode: 'escape',
                    phase: 'pending',
                    chainStatus: 'pending_withdrawal',
                    noteId: Number(attempt.noteId),
                    destination: canonical.destination || background?.destination || event.destination,
                    finalBalance: Number(canonical.final_balance
                        ?? background?.finalBalance
                        ?? event.finalBalance),
                    challengeDeadline: Number(canonical.challenge_deadline),
                    transactionHash: background?.transactionHash || attempt.transactionHash,
                    startBlockNumber: Math.max(
                        Number(background?.startBlockNumber || 0),
                        receiptBlock
                    ),
                    lastObservedBlock: Math.max(
                        Number(background?.lastObservedBlock || 0),
                        Number(canonical.observed_block)
                    ),
                    clearanceReserved: attempt.clearanceReserved === true,
                    error: null
                });
                changed = true;
                results.push({ ...canonical, attempt });
                continue;
            }

            if (canonical.status === 'active' && mode === 'escape') {
                const selectedOwns = Number(browserWalletRuntime.snapshot().runtime?.state?.note_id)
                    === Number(attempt.noteId);
                if (!selectedOwns && !background?.state) {
                    results.push({ status: 'missing_recovery_state', attempt });
                    continue;
                }
                await browserWalletRuntime.transferLateWithdrawalAttempt(attempt, {
                    recordId,
                    mode: 'escape',
                    phase: 'challenged_unconfirmed',
                    chainStatus: 'active',
                    noteId: Number(attempt.noteId),
                    destination: background?.destination || event.destination,
                    finalBalance: Number(background?.finalBalance ?? event.finalBalance),
                    transactionHash: background?.transactionHash || attempt.transactionHash,
                    startBlockNumber: Math.max(
                        Number(background?.startBlockNumber || 0),
                        receiptBlock
                    ),
                    challengeObservedBlock: Number(canonical.observed_block),
                    lastObservedBlock: Math.max(
                        Number(background?.lastObservedBlock || 0),
                        Number(canonical.observed_block)
                    ),
                    clearanceReserved: attempt.clearanceReserved === true,
                    error: null
                });
                results.push({ ...canonical, attempt, finalityPending: true });
                changed = true;
                continue;
            }

            results.push({ ...canonical, attempt });
            } catch (error) {
                if (error?.code === 'wrong_network') throw error;
                results.push({
                    status: 'error',
                    attempt,
                    error: error?.message || String(error)
                });
                // A single damaged or temporarily unreadable late receipt must
                // stay visible, but it must not prevent later independent
                // attempts from reconciling during every future poll.
                try {
                    await browserWalletRuntime.updateLateWithdrawalAttempt(
                        attempt.operationId,
                        attempt.transactionHash,
                        { error: error?.message || String(error) },
                        { expectedStatus: attempt.status }
                    );
                    changed = true;
                } catch (updateError) {
                    if (!/changed|no longer available/i.test(updateError?.message || '')) {
                        console.warn('Unable to retain a late withdrawal recovery error.', updateError);
                    }
                }
            }
        }

        if (changed) await this.refresh({ quiet: true });
        if (attempts.length) {
            const needsAttention = results.some(entry => [
                'error',
                'receipt_mismatch',
                'invalid_identity',
                'missing_recovery_state'
            ].includes(entry.status));
            const stillChecking = results.some(entry => [
                'submitted',
                'submitted_unconfirmed',
                'reverted_unconfirmed',
                'provider_unavailable',
                'rpc_behind'
            ].includes(entry.status));
            onStatus(needsAttention
                ? 'This withdrawal still needs attention. Open Payment history for details.'
                : stillChecking
                    ? 'The withdrawal from another tab is still being checked.'
                    : 'Withdrawal recovery is up to date.');
        }
        return results;
    }

    async syncWithdrawal(onStatus = () => {}) {
        if (!this.browserMode) {
            if (!this.note) return { status: 'no_note' };
            onStatus('Checking the vault’s canonical note status…');
            const result = await this.apiJson('/wallet/withdraw/confirm', { method: 'POST' });
            if (result.status === 'closed') {
                this.rememberWithdrawal(null);
                onStatus('Withdrawal complete. The private wallet archived the closed note.');
            } else if (result.status === 'pending_withdrawal') {
                this.rememberWithdrawal({
                    phase: 'pending',
                    mode: 'escape',
                    noteId: result.note_id,
                    destination: this.withdrawal?.destination || this.walletAddress || 'Unknown',
                    challengeDeadline: Number(result.challenge_deadline)
                });
                onStatus('The escape is pending until its safety deadline.');
            }
            await this.refresh();
            return result;
        }

        if (this.activeLateWithdrawal) {
            onStatus('Checking the transaction returned by the earlier MetaMask window…');
            const results = await this.syncLateWithdrawalAttempts(onStatus);
            await this.refresh({ quiet: true });
            // A stale/pruned hash must not hide the canonical state of the
            // selected note. If late recovery already detached the note, the
            // background record owns it now; otherwise continue below and
            // reconcile the selected durable withdrawal directly.
            if (!this.note) {
                return results.find(entry => Number(entry.attempt?.noteId)
                    === Number(this.activeLateWithdrawal?.note_id))
                    || results[0]
                    || { status: 'submitted' };
            }
        }

        if (!this.note) {
            const synced = await this.syncEscapeWithdrawals(onStatus);
            return synced[0]?.status ? synced[0] : { status: 'no_note' };
        }

        onStatus('Checking the vault’s canonical note status…');
        const noteId = Number(this.note.note_id);
        const before = this.withdrawal;
        const prepared = this.config?.prepared_withdrawal;
        const result = await this.readBrowserWithdrawalStatus(noteId);
        if (result.status === 'closed') {
            const durable = await browserWalletRuntime.currentPreparedWithdrawal();
            const mode = durable?.mode || prepared?.mode || before?.mode || 'mutual';
            const destination = durable?.destination || prepared?.destination || before?.destination;
            const finalBalance = Number(durable?.public_inputs?.final_balance
                ?? this.note.current_balance);
            const transactionHash = durable?.transactionHash
                || prepared?.transaction_hash
                || before?.transactionHash
                || null;
            let closeBlockNumber = Number(result.observed_block || 0);
            let payoutVerified = false;
            if (transactionHash && mode === 'mutual') {
                try {
                    const receipt = await globalThis.ethereum.request({
                        method: 'eth_getTransactionReceipt',
                        params: [transactionHash]
                    });
                    const event = receipt && BigInt(receipt.status || '0x0') === 1n
                        ? parseWithdrawalReceipt(receipt, this.config.funding.contract_address, mode)
                        : null;
                    const receiptBlock = Number(BigInt(receipt?.blockNumber || '0x0'));
                    if (String(receipt?.transactionHash || '').toLowerCase() === transactionHash.toLowerCase()
                        && event?.noteId === BigInt(noteId)
                        && event.destination.toLowerCase() === String(destination || '').toLowerCase()
                        && event.finalBalance === BigInt(finalBalance)
                        && Number.isSafeInteger(receiptBlock) && receiptBlock > 0
                        && receiptBlock <= closeBlockNumber) {
                        // Reloading long after payment must not restart the
                        // finality window at the current head. Only a matching
                        // mined withdrawal can supply the earlier checkpoint.
                        closeBlockNumber = receiptBlock;
                        payoutVerified = true;
                    }
                } catch {
                    // The canonical Closed observation is still sufficient
                    // for background recovery; retain its conservative block.
                }
            }
            await browserWalletRuntime.detachClosedWithdrawal({
                mode,
                noteId,
                destination,
                finalBalance,
                transactionHash,
                closeBlockNumber,
                payoutVerified,
                lastObservedBlock: Number(result.observed_block || 0),
                clearanceReserved: durable?.clearanceReserved === true
                    || durable?.mode === 'mutual'
            });
            this.rememberWithdrawal(null);
            onStatus(payoutVerified
                ? 'Withdrawal returned. Finality is being checked safely in the background.'
                : 'This balance is closed. Its payment is being checked in Payment history.');
        } else if (result.status === 'pending_withdrawal') {
            const destination = result.destination
                || before?.destination
                || prepared?.destination;
            if (!destination) {
                throw new Error('The vault did not return the escape payout destination.');
            }
            const record = await browserWalletRuntime.detachEscapeWithdrawal({
                noteId,
                destination,
                finalBalance: Number(result.final_balance),
                challengeDeadline: Number(result.challenge_deadline),
                transactionHash: prepared?.transaction_hash || before?.transactionHash || null,
                lastObservedBlock: Number(result.observed_block || 0)
            });
            this.rememberWithdrawal(null);
            result.recordId = record.recordId;
            onStatus('Escape confirmed. You can add a new private balance while it waits.');
        } else {
            // Reconcile the durable write-ahead journal, not its localStorage
            // mirror. A late hash from another tab must win over a stale
            // "Active" read and can never be discarded as a canceled prompt.
            await browserWalletRuntime.recoverPreparedWithdrawalSubmissionClaim();
            let durable = browserWalletRuntime.snapshot().runtime?.preparedWithdrawal || null;
            const hashes = Array.isArray(durable?.transactionHashes)
                ? durable.transactionHashes
                : durable?.transactionHash ? [durable.transactionHash] : [];
            const pendingHashes = [];
            const missingReceiptHashes = [];
            let successfulAttempts = [];
            for (const hash of hashes) {
                let receipt = null;
                try {
                    receipt = await globalThis.ethereum.request({
                        method: 'eth_getTransactionReceipt',
                        params: [hash]
                    });
                } catch {
                    // A pruned/replaced hash can still be resolved below from
                    // its finalized sender nonce and canonical note state.
                }
                if (!receipt) {
                    const transactionAttempt = (durable?.transactionAttempts || []).find(attempt =>
                        String(attempt.hash || '').toLowerCase() === String(hash).toLowerCase());
                    const nonceStatus = await this.browserTransactionNonceConsumed(
                        transactionAttempt,
                        noteId,
                        'active',
                        Number(result.observed_block || 0)
                    );
                    if (nonceStatus.consumed) {
                        await browserWalletRuntime.markPreparedWithdrawalRetryable(hash);
                    } else {
                        pendingHashes.push(hash);
                        missingReceiptHashes.push(hash);
                    }
                } else if (BigInt(receipt.status || '0x0') === 1n) {
                    successfulAttempts.push({ hash, receipt });
                } else {
                    const finality = await this.browserRevertedReceiptFinality(hash, receipt);
                    if (finality.finalized) {
                        await browserWalletRuntime.markPreparedWithdrawalRetryable(hash);
                    } else {
                        pendingHashes.push(hash);
                    }
                }
            }
            durable = browserWalletRuntime.snapshot().runtime?.preparedWithdrawal || null;
            const clearanceReserved = durable?.clearanceReserved === true
                || durable?.mode === 'mutual'
                || prepared?.clearance_reserved === true
                || before?.clearanceReserved === true;
            const durableMode = durable?.mode || prepared?.mode || before?.mode;
            if (successfulAttempts.length && durableMode) {
                const matchingAttempts = [];
                for (const attempt of successfulAttempts) {
                    const { receipt, hash } = attempt;
                    const event = parseWithdrawalReceipt(
                        receipt,
                        this.config.funding.contract_address,
                        durableMode
                    );
                    if (!event || event.noteId !== BigInt(noteId)
                        || event.destination.toLowerCase() !== durable?.destination?.toLowerCase()
                        || (durable?.public_inputs?.final_balance != null
                            && event.finalBalance !== BigInt(durable.public_inputs.final_balance))) {
                        // A malformed/stale sibling hash must not poison a
                        // valid withdrawal saved for the same note. Its mined
                        // receipt conclusively cannot later become this plan.
                        await browserWalletRuntime.markPreparedWithdrawalRetryable(hash);
                        continue;
                    }
                    matchingAttempts.push(attempt);
                }
                successfulAttempts = matchingAttempts;
            }
            if (successfulAttempts.length && durableMode) {
                const receiptBlock = successfulAttempts.reduce((highest, attempt) => {
                    const value = Number(BigInt(attempt.receipt.blockNumber || '0x0'));
                    return Math.max(highest, value);
                }, 0);
                let consistent = result;
                if (Number(result.observed_block || 0) < receiptBlock) {
                    consistent = await this.readBrowserWithdrawalStatus(noteId);
                }
                if (Number(consistent.observed_block || 0) < receiptBlock) {
                    const transactionHash = pendingHashes[0] || successfulAttempts[0].hash;
                    onStatus('The chain receipt is newer than the vault snapshot. Check again shortly.');
                    await this.refresh();
                    return { ...result, status: 'submitted', transaction_hash: transactionHash };
                }
                if (consistent.status === 'closed') {
                    const matchedEvent = parseWithdrawalReceipt(
                        successfulAttempts[0].receipt,
                        this.config.funding.contract_address,
                        durableMode
                    );
                    await browserWalletRuntime.detachClosedWithdrawal({
                        mode: durableMode,
                        payoutVerified: durableMode === 'mutual',
                        noteId,
                        destination: durable?.destination || matchedEvent.destination,
                        finalBalance: Number(durable?.public_inputs?.final_balance
                            ?? matchedEvent.finalBalance),
                        transactionHash: successfulAttempts[0].hash,
                        closeBlockNumber: durableMode === 'mutual'
                            ? receiptBlock
                            : Number(consistent.observed_block),
                        lastObservedBlock: Number(consistent.observed_block),
                        clearanceReserved,
                        createdAt: durable?.createdAt
                    });
                    this.rememberWithdrawal(null);
                    await this.refresh();
                    onStatus(durableMode === 'mutual'
                        ? 'Withdrawal returned. Finality is being checked safely in the background.'
                        : 'This balance is closed. Its payment is being checked in Payment history.');
                    return consistent;
                }
                if (consistent.status === 'pending_withdrawal') {
                    const destination = consistent.destination || durable?.destination;
                    const record = await browserWalletRuntime.detachEscapeWithdrawal({
                        noteId,
                        destination,
                        finalBalance: Number(consistent.final_balance),
                        challengeDeadline: Number(consistent.challenge_deadline),
                        transactionHash: successfulAttempts[0].hash,
                        startBlockNumber: receiptBlock,
                        lastObservedBlock: Number(consistent.observed_block)
                    });
                    this.rememberWithdrawal(null);
                    await this.refresh();
                    onStatus('Escape confirmed. You can add a new private balance while it waits.');
                    return { ...consistent, recordId: record.recordId };
                }
                // Active at/after a successful escape-start receipt means the
                // escape was challenged (or its short-lived block reorged).
                // Move the complete note into a nonblocking background record
                // until a finalized historical read proves which case won.
                if (durableMode === 'escape') {
                    if (durable?.submissionId) {
                        // Another MetaMask window may still return a second
                        // hash. Never erase its write-ahead claim merely
                        // because an earlier escape was challenged.
                        onStatus('The earlier escape was challenged, but another MetaMask request is still open. Close or finish that prompt before this balance is released.');
                        await this.refresh();
                        return {
                            ...consistent,
                            status: durable.phase === 'ambiguous'
                                ? 'ambiguous'
                                : 'awaiting_wallet'
                        };
                    }
                    const matchedEvent = parseWithdrawalReceipt(
                        successfulAttempts[0].receipt,
                        this.config.funding.contract_address,
                        'escape'
                    );
                    const record = await browserWalletRuntime.detachEscapeWithdrawal({
                        phase: 'challenged_unconfirmed',
                        chainStatus: 'active',
                        noteId,
                        destination: durable?.destination || matchedEvent.destination,
                        finalBalance: Number(durable?.public_inputs?.final_balance
                            ?? matchedEvent.finalBalance),
                        transactionHash: successfulAttempts[0].hash,
                        startBlockNumber: receiptBlock,
                        challengeObservedBlock: Number(consistent.observed_block),
                        lastObservedBlock: Number(consistent.observed_block),
                        clearanceReserved,
                        createdAt: durable?.createdAt
                    });
                    this.rememberWithdrawal(null);
                    await this.refresh();
                    onStatus('The escape was challenged. Its final chain status is being checked in the background, and you can add a new private balance now.');
                    return { ...consistent, recordId: record.recordId, finalityPending: true };
                }
            }
            if (pendingHashes.length) {
                const transactionHash = pendingHashes[0];
                const currentHashes = Array.isArray(durable?.transactionHashes)
                    ? durable.transactionHashes
                    : durable?.transactionHash ? [durable.transactionHash] : [];
                const missingSet = new Set(missingReceiptHashes.map(hash => hash.toLowerCase()));
                const allReceiptsMissing = currentHashes.length > 0
                    && currentHashes.every(hash => missingSet.has(hash.toLowerCase()));
                let marked = durable;
                if (allReceiptsMissing) {
                    marked = await browserWalletRuntime.markPreparedWithdrawalMissingReceipts(
                        currentHashes
                    );
                }
                const replacementIdentities = new Set((marked?.transactionAttempts || [])
                    .filter(attempt => /^0x[0-9a-fA-F]{40}$/.test(attempt.from || '')
                        && Number.isSafeInteger(Number(attempt.nonce))
                        && Number(attempt.nonce) >= 0)
                    .map(attempt => `${attempt.from.toLowerCase()}:${Number(attempt.nonce)}`));
                const replacementAvailable = allReceiptsMissing
                    && replacementIdentities.size === 1
                    && !marked?.submissionId;
                onStatus(allReceiptsMissing
                    ? replacementAvailable
                        ? 'No receipt was found. The exact withdrawal can be safely resubmitted with its original nonce.'
                        : 'No receipt was found. Check or cancel the pending transaction in MetaMask, then check again.'
                    : `Transaction ${this.compact(transactionHash)} is not final yet.`);
                await this.refresh();
                return {
                    ...result,
                    status: allReceiptsMissing
                        ? (marked?.submissionId ? 'awaiting_wallet' : 'dropped_or_pending')
                        : 'submitted',
                    transaction_hash: transactionHash,
                    replacement_available: replacementAvailable
                };
            }
            if (durable?.submissionId && durable.submissionFrom
                && Number.isSafeInteger(Number(durable.submissionNonce))) {
                const nonceStatus = await this.browserTransactionNonceConsumed({
                    from: durable.submissionFrom,
                    nonce: Number(durable.submissionNonce)
                }, noteId, 'active', Number(result.observed_block || 0));
                if (nonceStatus.consumed) {
                    await browserWalletRuntime.markPreparedWithdrawalRetryable(null, {
                        operationId: durable.operationId,
                        submissionId: durable.submissionId
                    });
                    durable = browserWalletRuntime.snapshot().runtime?.preparedWithdrawal || null;
                }
            }
            if (durable?.submissionId) {
                const ambiguous = durable.phase === 'ambiguous';
                onStatus(ambiguous
                    ? 'MetaMask did not return a transaction ID. The balance is held safely until you check or explicitly retry.'
                    : 'MetaMask may still be open in this or another tab. No transaction ID has been returned yet.');
                await this.refresh();
                return { ...result, status: ambiguous ? 'ambiguous' : 'awaiting_wallet' };
            }
            if (durableMode === 'escape' && !clearanceReserved) {
                await browserWalletRuntime.clearPreparedWithdrawal();
                onStatus('No escape transaction was submitted. Your private balance is ready to use.');
                this.rememberWithdrawal(null);
            } else if (successfulAttempts.length) {
                onStatus('A mutual-close transaction mined, but the latest vault state has not caught up yet. Check again shortly.');
            } else {
                onStatus('No transaction is moving. This balance is ready to withdraw by mutual close or escape hatch.');
            }
        }
        await this.refresh();
        return result;
    }

    async browserWithdrawalStateFinality(
        noteId,
        expectedStatus,
        transitionBlockNumber,
        observedBlock = 0
    ) {
        const transitionBlock = Number(transitionBlockNumber || 0);
        if (!['active', 'closed'].includes(expectedStatus)
            || !Number.isSafeInteger(transitionBlock) || transitionBlock <= 0) {
            return { finalized: false, checkedBlock: 0, source: 'unknown' };
        }

        let finalityTag = null;
        let source = 'finalized';
        try {
            const finalizedBlock = await globalThis.ethereum.request({
                method: 'eth_getBlockByNumber',
                params: ['finalized', false]
            });
            if (finalizedBlock?.number
                && /^0x[0-9a-fA-F]+$/.test(String(finalizedBlock.number))) {
                finalityTag = finalizedBlock.number;
            }
        } catch {
            // Some injected providers do not expose Ethereum's finalized tag.
            // Fall back to a conservative historical confirmation checkpoint.
        }

        if (!finalityTag) {
            source = 'confirmations';
            let head = Number(observedBlock || 0);
            try {
                const latest = await globalThis.ethereum.request({ method: 'eth_blockNumber' });
                if (/^0x[0-9a-fA-F]+$/.test(String(latest || ''))) {
                    head = Math.max(head, Number(BigInt(latest)));
                }
            } catch {
                // The already-observed chain head is sufficient for a bounded
                // fallback check; otherwise recovery simply remains retained.
            }
            const checkpoint = head - CLOSE_FINALITY_FALLBACK_BLOCKS;
            if (checkpoint < transitionBlock) {
                return { finalized: false, checkedBlock: Math.max(0, checkpoint), source };
            }
            finalityTag = `0x${checkpoint.toString(16)}`;
        }

        const checkedBlock = Number(BigInt(finalityTag));
        if (checkedBlock < transitionBlock) {
            return { finalized: false, checkedBlock, source };
        }
        try {
            const status = await this.readBrowserWithdrawalStatus(noteId, finalityTag);
            return {
                finalized: status.status === expectedStatus,
                checkedBlock,
                source,
                status
            };
        } catch {
            // Archive only when a historical canonical read proves the note is
            // closed. An RPC without archive-state support keeps the encrypted
            // recovery material in the background instead of risking loss.
            return { finalized: false, checkedBlock, source };
        }
    }

    async browserWithdrawalCloseFinality(noteId, closeBlockNumber, observedBlock = 0) {
        return this.browserWithdrawalStateFinality(
            noteId,
            'closed',
            closeBlockNumber,
            observedBlock
        );
    }

    async browserRevertedReceiptFinality(transactionHash, receipt) {
        const receiptBlock = receipt?.blockNumber
            && /^0x[0-9a-fA-F]+$/.test(String(receipt.blockNumber))
            ? Number(BigInt(receipt.blockNumber))
            : 0;
        if (!/^0x[0-9a-fA-F]{64}$/.test(transactionHash || '')
            || !Number.isSafeInteger(receiptBlock) || receiptBlock <= 0
            || BigInt(receipt?.status || '0x1') === 1n) {
            return { finalized: false, checkedBlock: 0, source: 'invalid_receipt' };
        }

        let checkedBlock = 0;
        let source = 'finalized';
        try {
            const finalizedBlock = await globalThis.ethereum.request({
                method: 'eth_getBlockByNumber',
                params: ['finalized', false]
            });
            if (finalizedBlock?.number
                && /^0x[0-9a-fA-F]+$/.test(String(finalizedBlock.number))) {
                checkedBlock = Number(BigInt(finalizedBlock.number));
            }
        } catch {
            // Fall through to a conservative confirmation-depth checkpoint.
        }
        if (!checkedBlock) {
            source = 'confirmations';
            try {
                const latest = await globalThis.ethereum.request({ method: 'eth_blockNumber' });
                if (/^0x[0-9a-fA-F]+$/.test(String(latest || ''))) {
                    checkedBlock = Math.max(
                        0,
                        Number(BigInt(latest)) - CLOSE_FINALITY_FALLBACK_BLOCKS
                    );
                }
            } catch {
                // Missing finality evidence deliberately leaves the WAL live.
            }
        }
        if (checkedBlock < receiptBlock) {
            return { finalized: false, checkedBlock, source };
        }

        try {
            const canonicalReceipt = await globalThis.ethereum.request({
                method: 'eth_getTransactionReceipt',
                params: [transactionHash]
            });
            const sameBlock = canonicalReceipt
                && Number(BigInt(canonicalReceipt.blockNumber || '0x0')) === receiptBlock
                && (!receipt.blockHash || !canonicalReceipt.blockHash
                    || String(canonicalReceipt.blockHash).toLowerCase()
                        === String(receipt.blockHash).toLowerCase());
            return {
                finalized: Boolean(sameBlock
                    && BigInt(canonicalReceipt.status || '0x1') !== 1n),
                checkedBlock,
                source,
                receipt: canonicalReceipt || null
            };
        } catch {
            // A missing/replaced receipt may reappear on the canonical chain.
            // Never discard its recovery record without positive finality.
            return { finalized: false, checkedBlock, source };
        }
    }

    async browserTransactionNonceConsumed(
        transactionAttempt,
        noteId,
        expectedStatus,
        observedBlock = 0
    ) {
        const from = transactionAttempt?.from;
        const nonce = Number(transactionAttempt?.nonce);
        const expectedStatuses = Array.isArray(expectedStatus)
            ? expectedStatus
            : [expectedStatus];
        if (!/^0x[0-9a-fA-F]{40}$/.test(from || '')
            || transactionAttempt?.nonce == null || !Number.isSafeInteger(nonce) || nonce < 0
            || !expectedStatuses.length
            || expectedStatuses.some(status =>
                !['active', 'pending_withdrawal'].includes(status))) {
            return { consumed: false, checkedBlock: 0, source: 'missing_metadata' };
        }

        let blockTag = null;
        let source = 'finalized';
        try {
            const finalizedBlock = await globalThis.ethereum.request({
                method: 'eth_getBlockByNumber',
                params: ['finalized', false]
            });
            if (finalizedBlock?.number
                && /^0x[0-9a-fA-F]+$/.test(String(finalizedBlock.number))) {
                blockTag = finalizedBlock.number;
            }
        } catch {
            // Use a conservative confirmation checkpoint below.
        }
        if (!blockTag) {
            source = 'confirmations';
            let head = Number(observedBlock || 0);
            try {
                const latest = await globalThis.ethereum.request({ method: 'eth_blockNumber' });
                if (/^0x[0-9a-fA-F]+$/.test(String(latest || ''))) {
                    head = Math.max(head, Number(BigInt(latest)));
                }
            } catch {
                // Keep the best already-observed head.
            }
            const checkpoint = head - CLOSE_FINALITY_FALLBACK_BLOCKS;
            if (checkpoint <= 0) {
                return { consumed: false, checkedBlock: Math.max(0, checkpoint), source };
            }
            blockTag = `0x${checkpoint.toString(16)}`;
        }

        try {
            const [transactionCount, status] = await Promise.all([
                globalThis.ethereum.request({
                    method: 'eth_getTransactionCount',
                    params: [from, blockTag]
                }),
                this.readBrowserWithdrawalStatus(noteId, blockTag)
            ]);
            const finalizedNonce = walletNonceNumber(transactionCount);
            if (finalizedNonce == null) {
                return { consumed: false, checkedBlock: Number(BigInt(blockTag)), source };
            }
            const consumed = finalizedNonce > nonce
                && expectedStatuses.includes(status.status);
            return {
                consumed,
                checkedBlock: Number(BigInt(blockTag)),
                source,
                status
            };
        } catch {
            // Never release a transaction merely because its metadata check
            // was unavailable; the durable hash remains recoverable.
            return { consumed: false, checkedBlock: Number(BigInt(blockTag)), source };
        }
    }

    async browserDepositNonceConsumed(transactionAttempt, noteId) {
        const from = transactionAttempt?.from;
        const nonce = Number(transactionAttempt?.nonce);
        if (!/^0x[0-9a-fA-F]{40}$/.test(from || '')
            || !Number.isSafeInteger(nonce) || nonce < 0) {
            return { consumed: false, checkedBlock: 0, source: 'missing_metadata' };
        }
        let blockTag = null;
        let source = 'finalized';
        try {
            const finalizedBlock = await globalThis.ethereum.request({
                method: 'eth_getBlockByNumber',
                params: ['finalized', false]
            });
            if (finalizedBlock?.number
                && /^0x[0-9a-fA-F]+$/.test(String(finalizedBlock.number))) {
                blockTag = finalizedBlock.number;
            }
        } catch {
            // Retain the deposit unless the conservative fallback below works.
        }
        if (!blockTag) {
            source = 'confirmations';
            let head = 0;
            try {
                const latest = await globalThis.ethereum.request({ method: 'eth_blockNumber' });
                if (/^0x[0-9a-fA-F]+$/.test(String(latest || ''))) {
                    head = Number(BigInt(latest));
                }
            } catch {
                // Missing finality information keeps the WAL intact.
            }
            const checkpoint = head - CLOSE_FINALITY_FALLBACK_BLOCKS;
            if (checkpoint <= 0) {
                return { consumed: false, checkedBlock: Math.max(0, checkpoint), source };
            }
            blockTag = `0x${checkpoint.toString(16)}`;
        }
        try {
            const [transactionCount, note] = await Promise.all([
                globalThis.ethereum.request({
                    method: 'eth_getTransactionCount',
                    params: [from, blockTag]
                }),
                this.readBrowserNote(noteId, blockTag)
            ]);
            const finalizedNonce = walletNonceNumber(transactionCount);
            const consumed = finalizedNonce != null
                && finalizedNonce > nonce
                && note.status === 0;
            return {
                consumed,
                checkedBlock: Number(BigInt(blockTag)),
                source,
                note
            };
        } catch {
            return { consumed: false, checkedBlock: Number(BigInt(blockTag)), source };
        }
    }

    async browserDepositSlotConflictFinality(plan) {
        let blockTag = null;
        let source = 'finalized';
        try {
            const finalizedBlock = await globalThis.ethereum.request({
                method: 'eth_getBlockByNumber',
                params: ['finalized', false]
            });
            if (finalizedBlock?.number
                && /^0x[0-9a-fA-F]+$/.test(String(finalizedBlock.number))) {
                blockTag = finalizedBlock.number;
            }
        } catch {
            // Use a conservative confirmation checkpoint below.
        }
        if (!blockTag) {
            source = 'confirmations';
            try {
                const latest = await globalThis.ethereum.request({ method: 'eth_blockNumber' });
                if (/^0x[0-9a-fA-F]+$/.test(String(latest || ''))) {
                    const checkpoint = Number(BigInt(latest)) - CLOSE_FINALITY_FALLBACK_BLOCKS;
                    if (checkpoint > 0) blockTag = `0x${checkpoint.toString(16)}`;
                }
            } catch {
                // Missing historical state keeps the original slot recoverable.
            }
        }
        if (!blockTag) return { finalized: false, checkedBlock: 0, source };
        try {
            const note = await this.readBrowserNote(Number(plan.next_note_id), blockTag);
            const sameCommitment = note.status !== 0
                && note.amount === BigInt(plan.amount)
                && BigInt(note.commitment) === BigInt(plan.commitment);
            return {
                finalized: note.status !== 0 && !sameCommitment,
                checkedBlock: Number(BigInt(blockTag)),
                source,
                note
            };
        } catch {
            return {
                finalized: false,
                checkedBlock: Number(BigInt(blockTag)),
                source
            };
        }
    }

    async syncEscapeWithdrawals(onStatus = () => {}, recordId = null) {
        if (!this.browserMode) return [];
        const records = this.withdrawals.filter(record => (record.phase !== 'closed'
                || record.finalizeTransactionHash
                || record.finalizeSubmissionId)
            && (!recordId || record.recordId === recordId));
        const results = [];
        let changed = false;
        let failures = 0;
        for (const listedRecord of records) {
            // Reconciliation needs the retained prepared plan to decide
            // whether a missing hash can be replaced by that exact proof. The
            // public snapshot intentionally strips this private material.
            let record = await browserWalletRuntime.currentWithdrawal(
                listedRecord.recordId
            ) || listedRecord;
            try {
                let status = await this.readBrowserWithdrawalStatus(record.noteId);
                let payoutVerified = false;
                let minimumObservedBlock = Math.max(
                    Number(record.startBlockNumber || 0),
                    Number(record.lastObservedBlock || 0)
                );
                const savedStartHashes = [...new Set([record, record.preparedWithdrawal].flatMap(value => value ? [
                    ...(value.transactionHash ? [value.transactionHash] : []), ...(value.transactionHashes || []),
                    ...(value.transactionAttempts || []).map(attempt => attempt.hash)
                ] : []).filter(Boolean).map(hash => String(hash).toLowerCase()))];
                const startClaims = backgroundWithdrawalClaims(record);
                const tracksStartRecovery = record.startRecoveryPending === true
                    || record.phase === 'submitted_unconfirmed'
                    || Boolean(record.startSubmissionId) || savedStartHashes.length > 0
                    || startClaims.length > 0
                    || (record.startSubmissionOutcome === 'resolved'
                        && (record.resolvedStartClaims?.length > 0 || record.startResolutionBlock > 0));
                let unresolvedStart = false;
                let unresolvedStartHashCount = 0;
                const resolvedStartHashes = new Set();
                const resolvedStartClaims = [...(record.resolvedStartClaims || [])];
                let resolvedStartBlock = Number(record.startResolutionBlock || 0);
                const startNonceChecks = new Map();
                const checkStartNonce = async attempt => {
                    const key = `${String(attempt?.from || '').toLowerCase()}:${attempt?.nonce}`;
                    if (!startNonceChecks.has(key)) startNonceChecks.set(key,
                        this.browserTransactionNonceConsumed(attempt, record.noteId,
                            'active', Number(status.observed_block || 0)));
                    return startNonceChecks.get(key);
                };
                const rememberResolvedStart = (hash, resolution) => {
                    if (hash) resolvedStartHashes.add(hash.toLowerCase());
                    resolvedStartBlock = Math.max(resolvedStartBlock, Number(resolution.checkedBlock || 0));
                };
                const missingStartHashes = [];
                // A canonical Pending observation does not make concurrently
                // submitted starts disappear. Keep checking every migrated WAL
                // hash even after the display phase advances, so a later
                // challenge cannot restore/delete a note while a distinct start
                // proof or MetaMask prompt can still execute.
                const startHashes = tracksStartRecovery ? savedStartHashes : [];
                for (const startHash of startHashes) {
                    let startReceipt = null;
                    try {
                        startReceipt = await globalThis.ethereum.request({
                            method: 'eth_getTransactionReceipt',
                            params: [startHash]
                        });
                    } catch {
                        // A pruned hash can still be retired from its finalized
                        // account nonce below. Otherwise it remains unresolved.
                    }
                    if (!startReceipt) {
                        const transactionAttempt = [
                            ...(record.transactionAttempts || []),
                            ...(record.preparedWithdrawal?.transactionAttempts || [])
                        ].find(attempt =>
                            String(attempt.hash || '').toLowerCase()
                                === String(startHash).toLowerCase());
                        const nonceStatus = await checkStartNonce(transactionAttempt);
                        if (!nonceStatus.consumed) {
                            unresolvedStart = true;
                            unresolvedStartHashCount += 1;
                            missingStartHashes.push(startHash);
                        } else rememberResolvedStart(startHash, nonceStatus);
                    } else if (startReceipt && BigInt(startReceipt.status || '0x0') === 1n) {
                        const event = parseWithdrawalReceipt(
                            startReceipt,
                            this.config.funding.contract_address,
                            record.mode === 'mutual' ? 'mutual' : 'escape'
                        );
                        if (!event || event.noteId !== BigInt(record.noteId)
                            || event.destination.toLowerCase() !== record.destination.toLowerCase()
                            || event.finalBalance !== BigInt(record.finalBalance)) {
                            // Keep the recovery record, but do not let one bad
                            // audit hash suppress canonical status recovery.
                            startReceipt = null;
                            const transactionAttempt = [
                                ...(record.transactionAttempts || []),
                                ...(record.preparedWithdrawal?.transactionAttempts || [])
                            ].find(attempt => String(attempt.hash || '').toLowerCase()
                                === String(startHash).toLowerCase());
                            const nonceStatus = await checkStartNonce(transactionAttempt);
                            if (!nonceStatus.consumed) {
                                unresolvedStart = true;
                                unresolvedStartHashCount += 1;
                            } else rememberResolvedStart(startHash, nonceStatus);
                        } else {
                            if (record.mode === 'mutual') payoutVerified = true;
                            minimumObservedBlock = Math.max(
                                minimumObservedBlock,
                                Number(BigInt(startReceipt.blockNumber || '0x0'))
                            );
                        }
                    } else if (startReceipt) {
                        const finality = await this.browserRevertedReceiptFinality(
                            startHash,
                            startReceipt
                        );
                        if (!finality.finalized) {
                            unresolvedStart = true;
                            unresolvedStartHashCount += 1;
                        } else rememberResolvedStart(startHash, finality);
                    }
                }
                for (const claim of startClaims) {
                    if (/^0x[0-9a-fA-F]{40}$/.test(claim.from || '')
                        && claim.nonce != null && Number.isSafeInteger(Number(claim.nonce))
                        && Number(claim.nonce) >= 0) {
                        const nonceStatus = await checkStartNonce({
                            from: claim.from,
                            nonce: Number(claim.nonce)
                        });
                        if (!nonceStatus.consumed) unresolvedStart = true;
                        else {
                            rememberResolvedStart(null, nonceStatus);
                            if (claim.submissionId && !resolvedStartClaims.some(saved =>
                                saved.submissionId === claim.submissionId && saved.operationId === claim.operationId)) {
                                resolvedStartClaims.push({ submissionId: claim.submissionId,
                                    operationId: claim.operationId, from: claim.from.toLowerCase(), nonce: Number(claim.nonce) });
                            }
                        }
                    } else {
                        // Another tab may still have a hashless MetaMask prompt
                        // for this note. Keeping it in the background is safe;
                        // restoring it while the prompt is live is not.
                        unresolvedStart = true;
                    }
                }
                if (tracksStartRecovery && !unresolvedStart
                    && (record.startRecoveryPending !== false || record.startSubmissionId || startClaims.length
                        || record.chainStatus !== status.status)) {
                    const resolvedPrepared = record.preparedWithdrawal
                        ? { ...record.preparedWithdrawal }
                        : null;
                    if (resolvedPrepared && (resolvedPrepared.submissionId === record.startSubmissionId
                        || resolvedStartClaims.some(claim => claim.submissionId === resolvedPrepared?.submissionId
                            && claim.operationId === resolvedPrepared?.operationId))) {
                        delete resolvedPrepared.submissionId;
                        delete resolvedPrepared.submissionOwner;
                        delete resolvedPrepared.submissionStartedAt;
                        delete resolvedPrepared.submissionFrom;
                        delete resolvedPrepared.submissionNonce;
                        delete resolvedPrepared.submissionNonceJournalRequired;
                        delete resolvedPrepared.submissionError;
                    }
                    const patch = {
                        startRecoveryPending: false,
                        chainStatus: status.status,
                        startSubmissionId: null,
                        startOperationId: null,
                        startSubmissionOwner: null,
                        startSubmissionStartedAt: null,
                        startSubmissionFrom: null,
                        startSubmissionNonce: null,
                        startSubmissionOutcome: 'resolved',
                        startMissingTransactionHashes: [],
                        startReplacementTransactionHashes: [],
                        startRetryFrom: null,
                        startRetryNonce: null,
                        startRetryOperationId: null,
                        startRecoveryResolvedAt: Date.now(),
                        resolvedStartClaims,
                        startResolutionBlock: resolvedStartBlock,
                        ...(resolvedPrepared ? { preparedWithdrawal: resolvedPrepared } : {})
                    };
                    await browserWalletRuntime.updateWithdrawal(record.recordId, patch, {
                        expectedRevision: record.revision
                    });
                    changed = true;
                    record = await browserWalletRuntime.currentWithdrawal(record.recordId);
                }
                if (Number(status.observed_block || 0) < minimumObservedBlock) {
                    status = await this.readBrowserWithdrawalStatus(record.noteId);
                }
                if (Number(status.observed_block || 0) < minimumObservedBlock) {
                    throw new Error('The connected RPC has not caught up to this withdrawal yet.');
                }
                if (status.status === 'active' && tracksStartRecovery && unresolvedStart) {
                    const allUnresolvedHashesMissing = unresolvedStartHashCount > 0
                        && missingStartHashes.length === unresolvedStartHashCount;
                    const canMarkReplacement = !record.startSubmissionId;
                    const hadReplacementMarker = ['receipt_missing', 'replacement_result_unknown']
                        .includes(record.startSubmissionOutcome);
                    const preparedHashSet = new Set((Array.isArray(
                        record.preparedWithdrawal?.transactionHashes
                    )
                        ? record.preparedWithdrawal.transactionHashes
                        : record.preparedWithdrawal?.transactionHash
                            ? [record.preparedWithdrawal.transactionHash]
                            : [])
                        .map(hash => String(hash).toLowerCase()));
                    const preparedOperationId = record.preparedWithdrawal?.operationId;
                    const replaceableMissingHashes = [...new Set(missingStartHashes
                        .map(hash => String(hash).toLowerCase())
                        .filter(hash => preparedHashSet.has(hash)
                            && (record.transactionAttempts || []).some(attempt =>
                                String(attempt.hash || '').toLowerCase() === hash
                                && attempt.operationId === preparedOperationId)))];
                    const patch = {
                        phase: 'submitted_unconfirmed',
                        chainStatus: 'active',
                        lastObservedBlock: Math.max(
                            Number(record.lastObservedBlock || 0),
                            Number(status.observed_block || 0)
                        ),
                        error: null,
                        ...(canMarkReplacement && allUnresolvedHashesMissing ? {
                            startSubmissionOutcome: 'receipt_missing',
                            startMissingTransactionHashes: [...new Set(
                                missingStartHashes.map(hash => String(hash).toLowerCase())
                            )],
                            startReplacementTransactionHashes: replaceableMissingHashes,
                            startMissingReceiptCheckedAt: Date.now()
                        } : canMarkReplacement && hadReplacementMarker ? {
                            startSubmissionOutcome: null,
                            startMissingTransactionHashes: [],
                            startReplacementTransactionHashes: []
                        } : {})
                    };
                    if (Object.entries(patch).some(([key, value]) => record[key] !== value)) {
                        await browserWalletRuntime.updateWithdrawal(record.recordId, patch, {
                            expectedRevision: record.revision
                        });
                        changed = true;
                    }
                    results.push({
                        ...status,
                        status: 'submitted_unconfirmed',
                        recordId: record.recordId
                    });
                    continue;
                }

                // Reconcile every known finalization hash before interpreting
                // an Active note. A still-live wallet prompt must never be
                // erased merely because the escape was challenged.
                let finalizeHashes = Array.isArray(record.finalizeTransactionHashes)
                    ? record.finalizeTransactionHashes
                    : record.finalizeTransactionHash ? [record.finalizeTransactionHash] : [];
                if (!finalizeHashes.length && record.finalizeSubmissionId
                    && record.finalizeSubmissionFrom
                    && Number.isSafeInteger(Number(record.finalizeSubmissionNonce))) {
                    const nonceStatus = await this.browserTransactionNonceConsumed({
                        from: record.finalizeSubmissionFrom,
                        nonce: Number(record.finalizeSubmissionNonce)
                    }, record.noteId, ['pending_withdrawal', 'active'], Number(status.observed_block || 0));
                    if (nonceStatus.consumed) {
                        await browserWalletRuntime.releaseWithdrawalFinalization(record.recordId, {
                            submission: {
                                recordId: record.recordId,
                                submissionId: record.finalizeSubmissionId,
                                operationId: record.finalizeOperationId,
                                generation: Number(record.finalizeGeneration || 0),
                                deploymentId: record.deploymentId,
                                chainId: Number(record.chainId),
                                contractAddress: record.contractAddress,
                                noteId: Number(record.noteId),
                                destination: record.destination
                            }
                        });
                        changed = true;
                        record = await browserWalletRuntime.currentWithdrawal(record.recordId);
                        finalizeHashes = [];
                    }
                }
                const successfulFinalizeHashes = [];
                const missingFinalizeHashes = [];
                for (const hash of finalizeHashes) {
                    let receipt = null;
                    try {
                        receipt = await globalThis.ethereum.request({
                            method: 'eth_getTransactionReceipt',
                            params: [hash]
                        });
                    } catch {
                        // Unknown remains durable and visible.
                    }
                    if (!receipt) {
                        const transactionAttempt = (record.finalizeAttempts || []).find(attempt =>
                            String(attempt.hash || '').toLowerCase() === String(hash).toLowerCase());
                        const nonceStatus = await this.browserTransactionNonceConsumed(
                            transactionAttempt,
                            record.noteId,
                            ['pending_withdrawal', 'active'],
                            Number(status.observed_block || 0)
                        );
                        if (nonceStatus.consumed) {
                            await browserWalletRuntime.releaseWithdrawalFinalization(record.recordId, {
                                transactionHash: hash
                            });
                            changed = true;
                        } else {
                            missingFinalizeHashes.push(hash);
                        }
                    } else if (BigInt(receipt.status || '0x0') !== 1n) {
                        const finality = await this.browserRevertedReceiptFinality(hash, receipt);
                        if (finality.finalized) {
                            await browserWalletRuntime.releaseWithdrawalFinalization(record.recordId, {
                                transactionHash: hash
                            });
                            changed = true;
                        }
                    } else if (receipt) {
                        const event = parseWithdrawalReceipt(
                            receipt,
                            this.config.funding.contract_address,
                            'finalize'
                        );
                        if (!event || event.noteId !== BigInt(record.noteId)
                            || event.destination.toLowerCase() !== record.destination.toLowerCase()
                            || event.finalBalance !== BigInt(record.finalBalance)) {
                            await browserWalletRuntime.releaseWithdrawalFinalization(record.recordId, {
                                transactionHash: hash
                            });
                            changed = true;
                            continue;
                        }
                        const receiptBlock = Number(BigInt(receipt.blockNumber || '0x0'));
                        if (Number(status.observed_block || 0) < receiptBlock) {
                            status = await this.readBrowserWithdrawalStatus(record.noteId);
                        }
                        if (Number(status.observed_block || 0) >= receiptBlock
                            && status.status === 'closed') {
                            successfulFinalizeHashes.push(hash);
                            payoutVerified = true;
                        }
                    }
                }
                record = await browserWalletRuntime.currentWithdrawal(record.recordId) || record;
                const currentFinalizeHashes = Array.isArray(record.finalizeTransactionHashes)
                    ? record.finalizeTransactionHashes
                    : record.finalizeTransactionHash ? [record.finalizeTransactionHash] : [];
                const missingFinalizeSet = new Set(
                    missingFinalizeHashes.map(hash => String(hash).toLowerCase())
                );
                const allFinalizeReceiptsMissing = currentFinalizeHashes.length > 0
                    && currentFinalizeHashes.every(hash =>
                        missingFinalizeSet.has(String(hash).toLowerCase()));
                if (status.status === 'pending_withdrawal'
                    && allFinalizeReceiptsMissing
                    && !record.finalizeSubmissionId) {
                    const previousRevision = Number(record.revision || 0);
                    record = await browserWalletRuntime.markWithdrawalFinalizationMissingReceipts(
                        record.recordId,
                        currentFinalizeHashes
                    ) || record;
                    if (Number(record.revision || 0) !== previousRevision) changed = true;
                }
                results.push({ ...status, recordId: record.recordId });
                if (status.status === 'closed') {
                    try {
                        const finalizeReceiptBlocks = [];
                        for (const hash of successfulFinalizeHashes) {
                            const receipt = await globalThis.ethereum.request({
                                method: 'eth_getTransactionReceipt',
                                params: [hash]
                            });
                            if (receipt?.blockNumber) {
                                finalizeReceiptBlocks.push(Number(BigInt(receipt.blockNumber)));
                            }
                        }
                        const closeBlockNumber = Math.max(
                            Number(record.closeBlockNumber || 0),
                            ...finalizeReceiptBlocks,
                            record.phase === 'closed_unconfirmed'
                                ? 0
                                : Number(status.observed_block || 0)
                        );
                        const finality = await this.browserWithdrawalCloseFinality(
                            record.noteId,
                            closeBlockNumber,
                            Number(status.observed_block || 0)
                        );
                        if (!finality.finalized) {
                            const patch = {
                                phase: 'closed_unconfirmed',
                                chainStatus: 'closed',
                                payoutVerified,
                                closedAt: Number(record.closedAt || Date.now()),
                                closeBlockNumber,
                                lastObservedBlock: Math.max(
                                    minimumObservedBlock,
                                    Number(status.observed_block || 0)
                                ),
                                finalityCheckedBlock: Number(finality.checkedBlock || 0),
                                finalitySource: finality.source,
                                error: null
                            };
                            if (Object.entries(patch).some(([key, value]) => record[key] !== value)) {
                                await browserWalletRuntime.updateWithdrawal(record.recordId, patch, {
                                    expectedRevision: record.revision
                                });
                                changed = true;
                            }
                            continue;
                        }

                        // Only now is it safe to forget every finalization
                        // prompt/hash and erase the private note recovery data.
                        // One record update makes that terminal transition
                        // atomic for other tabs observing IndexedDB.
                        await browserWalletRuntime.updateWithdrawal(record.recordId, {
                            phase: 'closed',
                            chainStatus: 'closed',
                            payoutVerified,
                            closedAt: Date.now(),
                            closeBlockNumber,
                            finalizedBlockNumber: Number(finality.checkedBlock),
                            finalitySource: finality.source,
                            lastObservedBlock: Math.max(
                                minimumObservedBlock,
                                Number(status.observed_block || 0)
                            ),
                            error: null
                        }, { sanitize: true, expectedRevision: record.revision });
                        changed = true;
                    } catch (error) {
                        if (!/changed|different phase|completed withdrawal/i.test(error.message)) throw error;
                    }
                } else if (status.status === 'pending_withdrawal') {
                    const stillFinalizing = Boolean(record.finalizeTransactionHash
                        || record.finalizeSubmissionId);
                    const patch = {
                        mode: 'escape',
                        phase: record.phase === 'ambiguous'
                            ? 'ambiguous'
                            : stillFinalizing
                                ? (record.finalizeTransactionHash ? 'finalizing' : 'awaiting_wallet')
                                : 'pending',
                        chainStatus: 'pending_withdrawal',
                        challengeDeadline: Number(status.challenge_deadline),
                        destination: status.destination || record.destination,
                        finalBalance: Number(status.final_balance ?? record.finalBalance),
                        lastObservedBlock: Math.max(
                            minimumObservedBlock,
                            Number(status.observed_block || 0)
                        ),
                        error: null
                    };
                    if (Object.entries(patch).some(([key, value]) => record[key] !== value)) {
                        try {
                            await browserWalletRuntime.updateWithdrawal(record.recordId, patch, {
                                expectedRevision: record.revision,
                                expectedPhase: [
                                    'pending',
                                    'submitted_unconfirmed',
                                    'challenged_unconfirmed',
                                    'recovery_unconfirmed',
                                    'finalizing',
                                    'awaiting_wallet',
                                    'ambiguous',
                                    'restored',
                                    'parked',
                                    'closed_unconfirmed'
                                ]
                            });
                            changed = true;
                        } catch (error) {
                            if (!/changed|different phase|completed withdrawal/i.test(error.message)) throw error;
                        }
                    }
                } else if (status.status === 'active') {
                    if (isUnsubmittedParkedMutualWithdrawal(
                        record, await browserWalletRuntime.currentLateWithdrawalAttempts()
                    )) {
                        // Cancel + Set Aside never started a chain transition.
                        // Repair records mislabeled by earlier clients without
                        // delaying the retry until an unrelated head finalizes.
                        const repaired = await browserWalletRuntime.repairUnsubmittedBackgroundWithdrawal(
                            record.recordId, Number(status.observed_block || 0), record.revision
                        );
                        if (repaired) {
                            changed ||= repaired.revision !== record.revision;
                            continue;
                        }
                        // A wallet claim/late hash raced the public read. Do
                        // not classify the stale record; the next pass owns it.
                        continue;
                    }
                    const unresolvedFinalization = Boolean(record.finalizeTransactionHash
                        || record.finalizeSubmissionId);
                    if (unresolvedFinalization) {
                        const patch = {
                            lastObservedBlock: Math.max(
                                minimumObservedBlock,
                                Number(status.observed_block || 0)
                            ),
                            chainStatus: 'active'
                        };
                        if (Object.entries(patch).some(([key, value]) => record[key] !== value)) {
                            await browserWalletRuntime.updateWithdrawal(record.recordId, patch, {
                                expectedRevision: record.revision
                            });
                            changed = true;
                        }
                    } else {
                        const withdrawalOnly = record.clearanceReserved === true
                            || record.preparedWithdrawal?.clearanceReserved === true;
                        const challengeObservedBlock = Number(
                            record.challengeObservedBlock
                            || status.observed_block
                            || record.lastObservedBlock
                            || record.startBlockNumber
                            || 0
                        );
                        const finality = await this.browserWithdrawalStateFinality(
                            record.noteId,
                            'active',
                            Math.max(
                                Number(record.startBlockNumber || 0),
                                challengeObservedBlock,
                                resolvedStartBlock
                            ),
                            Number(status.observed_block || 0)
                        );
                        if (!finality.finalized) {
                            const patch = {
                                phase: record.mode === 'escape' ? 'challenged_unconfirmed' : 'recovery_unconfirmed',
                                chainStatus: 'active',
                                challengeObservedBlock,
                                lastObservedBlock: Math.max(
                                    minimumObservedBlock,
                                    Number(status.observed_block || 0)
                                ),
                                finalityCheckedBlock: Number(finality.checkedBlock || 0),
                                finalitySource: finality.source,
                                error: null
                            };
                            if (Object.entries(patch).some(([key, value]) => record[key] !== value)) {
                                await browserWalletRuntime.updateWithdrawal(record.recordId, patch, {
                                    expectedRevision: record.revision
                                });
                                changed = true;
                            }
                            continue;
                        }
                        if (record.mode === 'mutual' && tracksStartRecovery
                            && !unresolvedStart && resolvedStartHashes.size === startHashes.length
                            && record.startSubmissionOutcome === 'resolved') {
                            // A reverted receipt alone cannot establish that
                            // the wallet's originally journaled nonce is spent
                            // (a provider might have returned an unrelated
                            // hash). Check every saved sender/nonce too.
                            for (const hash of startHashes) {
                                const attempt = [
                                    ...(record.transactionAttempts || []),
                                    ...(record.preparedWithdrawal?.transactionAttempts || [])
                                ].find(entry => String(entry.hash || '').toLowerCase() === hash);
                                const nonce = await checkStartNonce(attempt);
                                if (!nonce.consumed) {
                                    throw new Error('The saved wallet nonce is not finalized yet. Keep this withdrawal saved and check its status again.');
                                }
                                if (Number(nonce.checkedBlock) > Number(finality.checkedBlock)) {
                                    throw new Error('The vault checkpoint advanced while checking this withdrawal. Check its status again.');
                                }
                            }
                            await browserWalletRuntime.resolveBackgroundWithdrawalForRetry(record.recordId, {
                                expectedRevision: record.revision,
                                resolvedTransactionHashes: [...resolvedStartHashes],
                                finalizedBlock: Number(finality.checkedBlock),
                                observedBlock: Number(status.observed_block || 0)
                            });
                            changed = true;
                            continue;
                        }
                        const phase = withdrawalOnly ? 'parked' : 'restored';
                        if (record.phase !== phase || record.chainStatus !== 'active') {
                            try {
                                await browserWalletRuntime.updateWithdrawal(record.recordId, {
                                    phase,
                                    chainStatus: 'active',
                                    restoredAt: Date.now(),
                                    finalizedBlockNumber: Number(finality.checkedBlock),
                                    finalitySource: finality.source,
                                    lastObservedBlock: Math.max(
                                        minimumObservedBlock,
                                        Number(status.observed_block || 0)
                                    ),
                                    error: withdrawalOnly && record.mode === 'escape'
                                        ? 'The escape was challenged. This balance remains withdrawal-only because its close authorization was already reserved.'
                                        : null
                                }, { expectedRevision: record.revision });
                                changed = true;
                            } catch (error) {
                                if (!/changed|different phase|completed withdrawal/i.test(error.message)) throw error;
                            }
                        }
                    }
                }
            } catch (error) {
                if (error?.code === 'wrong_network') throw error;
                if (/not found|no longer available|changed|different phase|completed withdrawal/i.test(error?.message || '')) {
                    continue;
                }
                failures += 1;
                results.push({ status: 'error', recordId: record.recordId, error: error.message });
                try {
                    await browserWalletRuntime.updateWithdrawal(record.recordId, {
                        error: error.message
                    }, { expectedRevision: record.revision });
                    changed = true;
                } catch (updateError) {
                    if (!/not found|changed|different phase|completed withdrawal/i.test(updateError?.message || '')) {
                        throw updateError;
                    }
                }
            }
        }
        if (changed) await this.refresh({ quiet: true });
        if (failures) {
            const message = records.length === 1
                ? 'This withdrawal still needs attention.'
                : `Checked ${records.length} withdrawals; ${failures} need attention.`;
            onStatus(message);
            if (recordId) throw new Error(results.find(entry => entry.status === 'error')?.error || message);
        } else if (records.length) {
            onStatus('Withdrawal status is up to date.');
        }
        return results;
    }

    async parkPreparedWithdrawal(onStatus = () => {}) {
        if (!this.browserMode) throw new Error('Setting aside a balance is available in the browser wallet.');
        const record = await browserWalletRuntime.parkPreparedWithdrawal();
        this.rememberWithdrawal(null);
        await this.refresh();
        onStatus('Balance set aside safely. You can add a new private balance now.');
        return record;
    }

    async cancelPreparedWithdrawal(onStatus = () => {}) {
        if (!this.browserMode) throw new Error('Cancel the prepared withdrawal from the local client.');
        const prepared = this.config?.prepared_withdrawal;
        if (!prepared) return false;
        if (prepared.mode === 'mutual' || prepared.clearance_reserved === true) {
            throw new Error('This balance already has a mutual-close authorization. Finish it, use the escape hatch, or set it aside before funding another balance.');
        }
        if (prepared.transaction_hash) {
            throw new Error('This transaction was already submitted. Check its on-chain status instead of canceling it.');
        }
        await browserWalletRuntime.clearPreparedWithdrawal();
        this.rememberWithdrawal(null);
        await this.refresh();
        onStatus('Withdrawal canceled. Your private balance is ready to use.');
        return true;
    }

    async restoreWithdrawal(recordId, onStatus = () => {}) {
        if (!this.browserMode) throw new Error('This recovery belongs to the browser wallet.');
        const record = this.withdrawals.find(entry => entry.recordId === recordId);
        if (!record) throw new Error('The recoverable private balance is no longer available.');
        onStatus('Checking the vault before restoring this balance…');
        const canonical = await this.readBrowserWithdrawalStatus(record.noteId);
        const minimumObservedBlock = Math.max(
            Number(record.startBlockNumber || 0),
            Number(record.lastObservedBlock || 0)
        );
        if (Number(canonical.observed_block || 0) < minimumObservedBlock) {
            throw new Error('The connected RPC has not caught up to this withdrawal yet. Check again shortly.');
        }
        if (canonical.status !== 'active') {
            await this.syncEscapeWithdrawals(() => {}, recordId);
            throw new Error(canonical.status === 'pending_withdrawal'
                ? 'This escape is still active on-chain and cannot be selected as a chat balance.'
                : 'This withdrawal is already closed on-chain.');
        }
        onStatus('Restoring the selected private balance…');
        await browserWalletRuntime.restoreWithdrawal(recordId, {
            expectedRevision: record.revision,
            observedBlock: Number(canonical.observed_block || 0)
        });
        await this.refresh();
        onStatus('Private balance restored.');
        return this.wallet;
    }

    async recoverUnknownFinalization(recordId, onStatus = () => {}) {
        if (!this.browserMode) throw new Error('Wallet-request recovery is available in the browser wallet.');
        await browserWalletRuntime.markWithdrawalFinalizationUnknown(recordId);
        await this.refresh();
        onStatus('The old wallet prompt was marked unresolved. Check the escape before retrying.');
        return this.withdrawals.find(record => record.recordId === recordId) || null;
    }

    async resolveChallengedFinalization(recordId, onStatus = () => {}) {
        if (!this.browserMode) throw new Error('Wallet-request recovery is available in the browser wallet.');
        const record = this.withdrawals.find(entry => entry.recordId === recordId);
        if (!record || record.chainStatus !== 'active' || !record.finalizeSubmissionId
            || record.finalizeTransactionHash) {
            throw new Error('There is no challenged, hashless MetaMask prompt to release.');
        }
        onStatus('Confirming that the escape is still challenged…');
        const canonical = await this.readBrowserWithdrawalStatus(record.noteId);
        const chainFloor = Math.max(
            Number(record.startBlockNumber || 0),
            Number(record.lastObservedBlock || 0)
        );
        if (canonical.status !== 'active'
            || Number(canonical.observed_block || 0) < chainFloor) {
            throw new Error('The latest vault state does not safely confirm a challenged escape. Check the transaction again.');
        }
        await browserWalletRuntime.resolveChallengedWithdrawalFinalization(recordId, {
            expectedRevision: record.revision,
            observedBlock: Number(canonical.observed_block)
        });
        await this.refresh();
        onStatus('Old MetaMask prompt released. This balance can be selected again.');
        return this.withdrawals.find(entry => entry.recordId === recordId) || null;
    }

    async retryUnknownFinalization(recordId, onStatus = () => {}) {
        if (!this.browserMode) throw new Error('Wallet-request recovery is available in the browser wallet.');
        const record = this.withdrawals.find(entry => entry.recordId === recordId);
        if (record?.phase !== 'ambiguous') {
            throw new Error('There is no unresolved finalization request to retry.');
        }
        if (record.chainStatus === 'active') {
            throw new Error('This escape was challenged. Close the old MetaMask prompt instead of retrying finalization.');
        }
        await browserWalletRuntime.authorizeWithdrawalFinalizationRetry(recordId);
        await this.refresh({ quiet: true });
        onStatus('Retry authorized. Opening a new MetaMask request…');
        return this.finalizeEscape(recordId, onStatus);
    }

    async retryDroppedFinalization(recordId, onStatus = () => {}) {
        if (!this.browserMode) {
            throw new Error('Finalization transaction replacement is available in the browser wallet.');
        }
        const current = await browserWalletRuntime.currentWithdrawal(recordId);
        if (!current || current.phase !== 'finalizing'
            || !['receipt_missing', 'replacement_result_unknown']
                .includes(current.finalizeSubmissionOutcome)) {
            throw new Error('Check the pending escape before replacing its finalization.');
        }
        onStatus('Connecting to the MetaMask account that submitted this finalization…');
        const from = await this.connectWallet();
        const submission = await browserWalletRuntime.claimWithdrawalFinalizationReplacement(
            recordId,
            from
        );
        let submittedHash = null;
        let submissionMetadata = {
            from: submission.replacementFrom,
            nonce: Number(submission.replacementNonce)
        };
        try {
            onStatus('Confirm the exact same finalization in MetaMask. It reuses the original nonce, so only one version can execute.');
            await this.sendContractTransaction(
                from,
                this.config.funding.contract_address,
                encodeFinalizeEscape(submission.noteId),
                async hash => {
                    submittedHash = hash;
                    await browserWalletRuntime.rememberWithdrawalFinalization(
                        recordId,
                        hash,
                        submission,
                        submissionMetadata
                    );
                    onStatus(`Finalization replacement submitted ${this.compact(hash)} · checking confirmation…`);
                },
                async metadata => {
                    submissionMetadata = metadata;
                    await browserWalletRuntime.rememberWithdrawalFinalizationSubmissionMetadata(
                        recordId,
                        submission,
                        metadata
                    );
                },
                submission.replacementNonce
            );
        } catch (error) {
            if (error?.transactionHash) {
                submittedHash = error.transactionHash;
                try {
                    await browserWalletRuntime.rememberWithdrawalFinalization(
                        recordId,
                        submittedHash,
                        submission,
                        submissionMetadata
                    );
                } catch (journalError) {
                    error.journalRecoveryError = journalError;
                }
            } else {
                await browserWalletRuntime.releaseWithdrawalFinalizationReplacementClaim(
                    recordId,
                    submission,
                    error?.message || 'MetaMask did not return a finalization replacement transaction ID.'
                );
                error.shortMessage = error?.broadcastPossible === false || isWalletRejection(error)
                    ? 'The finalization replacement was canceled before broadcast. The original transaction remains saved and can be replaced again.'
                    : 'MetaMask did not return a replacement transaction ID. The original finalization remains saved, and you can safely resubmit it with the same nonce.';
            }
            await this.refresh({ quiet: true });
            throw error;
        }
        await this.refresh({ quiet: true });
        const results = await this.syncEscapeWithdrawals(onStatus, recordId);
        return results[0] || { status: 'submitted', transaction_hash: submittedHash };
    }

    async finalizeEscape(recordIdOrStatus = null, maybeStatus = () => {}) {
        const key = typeof recordIdOrStatus === 'string' ? recordIdOrStatus : 'selected';
        if (this.finalizePromise) {
            if (this.finalizePromiseKey === key) return this.finalizePromise;
            throw new Error('A different escape finalization is already running.');
        }
        const operation = this.performFinalizeEscape(recordIdOrStatus, maybeStatus);
        this.finalizePromise = operation;
        this.finalizePromiseKey = key;
        try {
            return await operation;
        } finally {
            if (this.finalizePromise === operation) {
                this.finalizePromise = null;
                this.finalizePromiseKey = null;
            }
        }
    }

    async performFinalizeEscape(recordIdOrStatus = null, maybeStatus = () => {}) {
        const hasRecordId = typeof recordIdOrStatus === 'string';
        const onStatus = typeof recordIdOrStatus === 'function' ? recordIdOrStatus : maybeStatus;
        let withdrawal = hasRecordId
            ? this.withdrawals.find(record => record.recordId === recordIdOrStatus)
            : this.browserMode
                ? this.withdrawals.find(record => record.mode === 'escape' && record.phase !== 'closed')
                : this.withdrawal;
        if (this.browserMode && withdrawal?.recordId) {
            withdrawal = await browserWalletRuntime.currentWithdrawal(withdrawal.recordId);
        }
        const resumablePhases = this.browserMode
            ? ['pending', 'finalizing', 'awaiting_wallet']
            : ['pending'];
        if (!resumablePhases.includes(withdrawal?.phase)) {
            throw new Error('There is no pending escape withdrawal.');
        }
        if (Date.now() < Number(withdrawal.challengeDeadline) * 1000) {
            throw new Error(`The safety window has ${this.formatExpiry(withdrawal.challengeDeadline)} remaining.`);
        }

        onStatus('Connecting to MetaMask for finalization…');
        const from = await this.connectWallet();
        let submittedHash = withdrawal.finalizeTransactionHash || null;
        let submission = null;
        let submissionMetadata = null;
        let receipt;
        try {
            if (this.browserMode) {
                const claim = await browserWalletRuntime.claimWithdrawalFinalization(
                    withdrawal.recordId
                );
                submittedHash = claim.transactionHash || null;
                submission = claim;
                withdrawal = claim.record;
            }
            if (submittedHash) {
                onStatus(`Checking submitted finalization ${this.compact(submittedHash)}…`);
                receipt = await this.waitForReceipt(submittedHash);
            } else {
                onStatus('Confirm finalization in MetaMask…');
                receipt = await this.sendContractTransaction(
                    from,
                    this.config.funding.contract_address,
                    encodeFinalizeEscape(withdrawal.noteId),
                    this.browserMode
                        ? async hash => {
                            submittedHash = hash;
                            await browserWalletRuntime.rememberWithdrawalFinalization(
                                withdrawal.recordId,
                                hash,
                                submission,
                                submissionMetadata
                            );
                            const metadata = await this.submittedTransactionMetadata(hash, from);
                            if (metadata) {
                                await browserWalletRuntime.rememberWithdrawalFinalization(
                                    withdrawal.recordId,
                                    hash,
                                    submission,
                                    metadata
                                );
                            }
                            onStatus(`Finalization submitted ${this.compact(hash)} · waiting for confirmation…`);
                        }
                        : null,
                    this.browserMode
                        ? async metadata => {
                            submissionMetadata = metadata;
                            await browserWalletRuntime.rememberWithdrawalFinalizationSubmissionMetadata(
                                withdrawal.recordId,
                                submission,
                                metadata
                            );
                        }
                        : null
                );
            }
        } catch (error) {
            if (this.browserMode) {
                if (error?.transactionHash) {
                    submittedHash = error.transactionHash;
                    try {
                        await browserWalletRuntime.rememberWithdrawalFinalization(
                            withdrawal.recordId,
                            submittedHash,
                            submission,
                            submissionMetadata
                        );
                        const metadata = await this.submittedTransactionMetadata(submittedHash, from);
                        if (metadata) {
                            await browserWalletRuntime.rememberWithdrawalFinalization(
                                withdrawal.recordId,
                                submittedHash,
                                submission,
                                metadata
                            );
                        }
                    } catch (journalError) {
                        error.journalRecoveryError = journalError;
                    }
                }
                let chainReceipt = null;
                if (submittedHash) {
                    try {
                        chainReceipt = await globalThis.ethereum.request({
                            method: 'eth_getTransactionReceipt',
                            params: [submittedHash]
                        });
                    } catch {
                        // Preserve an ambiguous submitted hash for reload.
                    }
                }
                if (chainReceipt && BigInt(chainReceipt.status || '0x0') !== 1n) {
                    const finality = await this.browserRevertedReceiptFinality(
                        submittedHash,
                        chainReceipt
                    );
                    if (finality.finalized) {
                        await browserWalletRuntime.releaseWithdrawalFinalization(withdrawal.recordId, {
                            transactionHash: submittedHash
                        });
                        error.shortMessage = 'The finalization transaction reverted. The escape is still safe and ready to retry.';
                    } else {
                        error.shortMessage = 'The finalization currently shows as reverted, but that block is not final yet. It remains tracked and will be checked automatically.';
                    }
                } else if (!submittedHash && submission
                    && (error?.broadcastPossible === false || isWalletRejection(error))) {
                    await browserWalletRuntime.releaseWithdrawalFinalization(withdrawal.recordId, {
                        submission
                    });
                } else if (!submittedHash && submission && error?.broadcastPossible === true) {
                    await browserWalletRuntime.markWithdrawalFinalizationAmbiguous(
                        withdrawal.recordId,
                        submission,
                        error?.message || 'MetaMask did not return a transaction ID.'
                    );
                    error.shortMessage = 'MetaMask did not return a transaction ID. Check the escape status; retry only if it is still pending.';
                }
                if (!submittedHash && isWalletRejection(error)) {
                    error.shortMessage = 'MetaMask canceled finalization. The withdrawal is still safe and can be finalized later.';
                }
                await this.refresh({ quiet: true });
            }
            throw error;
        }
        const event = parseWithdrawalReceipt(receipt, this.config.funding.contract_address, 'finalize');
        if (!event || event.noteId !== BigInt(withdrawal.noteId)
            || event.destination.toLowerCase() !== withdrawal.destination.toLowerCase()
            || event.finalBalance !== BigInt(withdrawal.finalBalance)) {
            throw new Error('The finalization event did not match the pending withdrawal.');
        }
        const confirmed = await this.confirmMinedWithdrawalStatus(withdrawal.noteId, receipt);
        if (confirmed.status !== 'closed') {
            throw new Error(`The vault reports ${confirmed.status} after finalization.`);
        }
        if (this.browserMode) {
            await browserWalletRuntime.updateWithdrawal(withdrawal.recordId, {
                phase: 'closed_unconfirmed',
                chainStatus: 'closed',
                payoutVerified: true,
                closedAt: Date.now(),
                closeBlockNumber: Number(BigInt(receipt?.blockNumber || '0x0')),
                lastObservedBlock: Number(confirmed.observed_block || 0),
                error: null
            });
        } else {
            this.rememberWithdrawal(null);
        }
        await this.refresh();
        onStatus(this.browserMode
            ? 'Escape withdrawal returned. Finality is being checked safely in the background.'
            : 'Escape withdrawal finalized. Its balance was returned to MetaMask.');
        return { status: 'closed', event, receipt };
    }

    async confirmMinedWithdrawalStatus(noteId, receipt) {
        try {
            return this.browserMode
                ? await this.readBrowserWithdrawalStatus(noteId)
                : await this.apiJson('/wallet/withdraw/confirm', { method: 'POST' });
        } catch (failure) {
            // Call only after validating the successful receipt's withdrawal
            // event. An unavailable second RPC is not a failed payout. Keep
            // the submitted journal intact for normal background/reload sync.
            const error = normalizeWalletError(failure);
            error.withdrawalConfirmationPending = true;
            error.transactionHash = receipt?.transactionHash || null;
            error.shortMessage = error.code === 'wrong_network'
                ? `Your withdrawal transaction was mined. Switch MetaMask back to ${this.networkName()} so the app can confirm its status.`
                : this.browserMode
                    ? 'Your withdrawal transaction was mined. Its status will be checked automatically; you can close this window.'
                    : 'Your withdrawal transaction was mined. Check withdrawal status shortly to finish confirming it.';
            throw error;
        }
    }

    async readBrowserWithdrawalStatus(noteId, requestedBlock = null) {
        if (noteId == null) return { status: 'no_note', challenge_deadline: null };
        await this.assertFundingChain();
        const blockTag = requestedBlock || await globalThis.ethereum.request({ method: 'eth_blockNumber' });
        if (!/^0x[0-9a-fA-F]+$/.test(String(blockTag || ''))) {
            throw new Error('The wallet provider returned an invalid block number.');
        }
        const observedBlock = Number(BigInt(blockTag));
        const encodedNote = await globalThis.ethereum.request({
            method: 'eth_call',
            params: [{
                to: this.config.funding.contract_address,
                data: `0x9f18e4ed${abiWord(noteId)}`
            }, blockTag]
        });
        const words = String(encodedNote || '').replace(/^0x/, '').match(/.{64}/g) || [];
        if (words.length < 4) throw new Error('The vault returned a truncated note record.');
        const status = Number(BigInt(`0x${words[3]}`));
        if (status === 3) return { status: 'closed', note_id: Number(noteId), challenge_deadline: null, observed_block: observedBlock };
        if (status === 1) return { status: 'active', note_id: Number(noteId), challenge_deadline: null, observed_block: observedBlock };
        if (status !== 2) throw new Error(`The vault returned unknown note status ${status}.`);
        await this.assertFundingChain();
        const encodedPending = await globalThis.ethereum.request({
            method: 'eth_call',
            params: [{
                to: this.config.funding.contract_address,
                data: `0xa2f9f1ce${abiWord(noteId)}`
            }, blockTag]
        });
        const pendingWords = String(encodedPending || '').replace(/^0x/, '').match(/.{64}/g) || [];
        if (pendingWords.length < 6 || BigInt(`0x${pendingWords[0]}`) !== 1n) {
            throw new Error('The vault pending-withdrawal record is missing.');
        }
        return {
            status: 'pending_withdrawal',
            note_id: Number(noteId),
            active_root: `0x${pendingWords[1]}`,
            withdrawal_nullifier: `0x${pendingWords[2]}`,
            final_balance: Number(BigInt(`0x${pendingWords[3]}`)),
            destination: `0x${pendingWords[4].slice(-40)}`,
            challenge_deadline: Number(BigInt(`0x${pendingWords[5]}`)),
            observed_block: observedBlock
        };
    }

    async confirmBrowserWithdrawal(noteId = this.note?.note_id) {
        const result = await this.readBrowserWithdrawalStatus(noteId);
        if (result.status === 'closed' && Number(this.note?.note_id) === Number(noteId)) {
            await browserWalletRuntime.archiveNote('withdrawn', noteId);
        }
        return result;
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

export { SESSION_HEADER, ZkapiClient, ZkapiHttpError };
export default zkapiClient;
