import networkProxy from './networkProxy.js';
import { sameFelt, waitForExpectedActiveRoot } from './zkapiWithdrawalRoot.mjs';
import { isUnsubmittedParkedMutualWithdrawal } from './zkapiWithdrawalRecovery.mjs';
import {
    CHAT_SPENDING_TIER_USD,
    selectLeaseSpendingLimitCredits
} from './zkapiRequestCompat.mjs';
import {
    archiveBrowserWallet,
    assertBrowserBackgroundWithdrawalAvailable,
    authorizeBrowserWithdrawalFinalizationRetry,
    claimBrowserWithdrawalStartReplacement,
    claimBrowserBackgroundWithdrawalSubmission,
    claimBrowserWithdrawalFinalization,
    claimBrowserWithdrawalFinalizationReplacement,
    createWalletChannel,
    detachBrowserClosedWithdrawal,
    detachBrowserEscapeWithdrawal,
    listBrowserWithdrawals,
    isBrowserBackgroundWithdrawalPreparationCancelable,
    markBrowserWithdrawalFinalizationAmbiguous,
    markBrowserBackgroundWithdrawalAmbiguous,
    markBrowserWithdrawalFinalizationMissingReceipts,
    parkBrowserWithdrawal,
    readBrowserWalletSnapshot,
    releaseBrowserWithdrawalFinalization,
    releaseBrowserWithdrawalFinalizationReplacementClaim,
    releaseBrowserWithdrawalStartSubmission,
    releaseBrowserBackgroundWithdrawalSubmission,
    rememberBrowserBackgroundWithdrawalMetadata,
    rememberBrowserBackgroundWithdrawalTransaction,
    rememberBrowserWithdrawalFinalization,
    rememberBrowserWithdrawalFinalizationSubmissionMetadata,
    requestPersistentStorage,
    repairBrowserUnsubmittedBackgroundWithdrawal,
    resolveBrowserBackgroundWithdrawalForRetry,
    resolveBrowserChallengedFinalization,
    restoreBrowserWithdrawal,
    saveBrowserBackgroundWithdrawalPlan,
    transferBrowserLateWithdrawalAttempt,
    updateBrowserWithdrawal,
    withBrowserWalletLock,
    writeBrowserWallet
} from './browserWalletStore.js';

const DEFAULT_BROWSER_CONFIG_URL = new URL('../browser-config.json', import.meta.url).href;
const LEASE_AUTHORIZATION = JSON.stringify({ mode: 'openrouter_ephemeral_lease', version: 1 });
const MAX_RECOVERY_WAIT_MS = 45_000;
// OA may briefly throttle child-key creation. Keep retrying the same durable,
// idempotent lease request long enough to cross a one-minute limiter without
// ever reproving, waiting indefinitely, or amplifying the limiter with a tight
// retry loop. The production schedule is 5s, 10s, 20s, then 30s.
const LEASE_ISSUE_MAX_WAIT_MS = 75_000;
const LEASE_ISSUE_MAX_ATTEMPTS = 5;
const LEASE_ISSUE_INITIAL_RETRY_MS = 5_000;
const LEASE_ISSUE_MAX_RETRY_MS = 30_000;
// Never begin a potentially long frontier-model stream on a key that is near
// the server's independent settlement boundary. A follow-up inside this
// window transparently closes the old key and obtains a fresh fixed-$1 key.
const MIN_REQUEST_LEASE_REMAINING_SECONDS = 90;
const TAB_OWNER_STORAGE_KEY = 'zkapi-browser-tab-owner-v1';
const LATE_WITHDRAWAL_TERMINAL_STATUSES = new Set([
    'closed',
    'detached',
    'reverted',
    'challenged',
    'superseded',
    'quarantined'
]);
const LATE_DEPOSIT_TERMINAL_STATUSES = new Set(['confirmed', 'reverted', 'superseded']);

class BrowserWalletHttpError extends Error {
    constructor(message, status, code, data = null) {
        super(message);
        this.name = 'BrowserWalletHttpError';
        this.status = status;
        this.code = code;
        this.data = data;
    }
}

class WorkerBridge {
    constructor() {
        this.worker = new Worker(new URL('./zkapiWasmWorker.js', import.meta.url), { type: 'module' });
        this.pending = new Map();
        this.sequence = 0;
        this.worker.addEventListener('message', (event) => {
            const entry = this.pending.get(event.data?.id);
            if (!entry) return;
            this.pending.delete(event.data.id);
            if (event.data.error) entry.reject(new Error(event.data.error));
            else entry.resolve(event.data.result);
        });
        this.worker.addEventListener('error', (event) => {
            const error = new Error(event.message || 'The zkAPI proof worker crashed.');
            for (const entry of this.pending.values()) entry.reject(error);
            this.pending.clear();
        });
    }

    call(operation, payload = {}) {
        const id = ++this.sequence;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.worker.postMessage({ id, operation, payload });
        });
    }
}

function normalizeUrl(value) {
    return String(value || '').replace(/\/+$/, '');
}

function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    const error = new DOMException('The operation was aborted.', 'AbortError');
    error.isCancelled = true;
    throw error;
}

function exactTrustedUrl(supplied, expected, label) {
    if (!expected?.startsWith('https://') && !expected?.startsWith('http://127.0.0.1:')
        && !expected?.startsWith('http://localhost:')) {
        throw new Error(`${label} is not a secure or loopback URL.`);
    }
    if (normalizeUrl(supplied) !== normalizeUrl(expected)) {
        throw new Error(`${label} did not match the deployment trust anchor.`);
    }
}

function delay(milliseconds, signal) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, milliseconds);
        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            const error = new Error('Request aborted');
            error.name = 'AbortError';
            reject(error);
        }, { once: true });
    });
}

function isExplicitlyRetriableLeaseError(error) {
    const explicitlyRetriable = error?.data?.retriable === true
        || error?.data?.error?.retriable === true;
    // These responses require a new proof or local lost-key reconciliation;
    // repeatedly sending the same lease request cannot resolve either state.
    return explicitlyRetriable
        && !['stale_root', 'lease_pending', 'lease_settlement_pending'].includes(error?.code);
}

function isExplicitlyRetriableLeaseRetirementError(error) {
    const explicitlyRetriable = error?.data?.retriable === true
        || error?.data?.error?.retriable === true;
    return isExplicitlyRetriableLeaseError(error)
        || (explicitlyRetriable
            && ['lease_pending', 'lease_settlement_pending'].includes(error?.code));
}

function isLeaseRateLimit(error) {
    return error?.status === 429
        || /^oa_(?:minute_request_limit|hourly_issuance_budget|rate_limited)$/.test(error?.code || '')
        || /(?:\b429\b|too many requests|rate[ -]?limit)/i.test(error?.message || '');
}

function leaseRetryAfterMilliseconds(error) {
    const candidates = [
        error?.data?.retry_after_seconds,
        error?.data?.error?.retry_after_seconds,
        error?.data?.detail?.retry_after_seconds,
        error?.data?.error?.detail?.retry_after_seconds
    ];
    for (const candidate of candidates) {
        const seconds = Number(candidate);
        if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
    }
    return null;
}

function describeRetryDelay(milliseconds) {
    const seconds = Math.max(1, Math.ceil(milliseconds / 1_000));
    if (seconds < 60) return seconds === 1 ? '1 second' : `${seconds} seconds`;
    const minutes = Math.ceil(seconds / 60);
    if (minutes < 60) return minutes === 1 ? 'about 1 minute' : `about ${minutes} minutes`;
    const hours = Math.ceil(minutes / 60);
    return hours === 1 ? 'about 1 hour' : `about ${hours} hours`;
}

function makeLeaseRateLimitActionable(error, retryAfterMs = null) {
    if (!isLeaseRateLimit(error)) return error;
    error.shortMessage = retryAfterMs != null
        ? `Temporary-key capacity is full. Your message is saved and was not sent. Try again in ${describeRetryDelay(retryAfterMs)}.`
        : 'The temporary-key service is still busy. Your message is saved and was not sent; use Retry in a moment.';
    return error;
}

function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function browserTabOwnerId() {
    try {
        const existing = sessionStorage.getItem(TAB_OWNER_STORAGE_KEY);
        if (existing && /^[0-9a-f-]{36}$/i.test(existing)) return existing;
        const created = uuid();
        sessionStorage.setItem(TAB_OWNER_STORAGE_KEY, created);
        return created;
    } catch {
        return uuid();
    }
}

function retainAttemptHistory(attempts, terminalStatuses, terminalLimit = 32) {
    const unresolved = attempts.filter(attempt => !terminalStatuses.has(attempt.status));
    const terminal = attempts
        .filter(attempt => terminalStatuses.has(attempt.status))
        .slice(-terminalLimit);
    // An unresolved transaction is a recovery capability, not log history. It
    // must never be evicted merely because more wallet attempts were made.
    return [...terminal, ...unresolved];
}

function unresolvedLateWithdrawalForNote(runtime, noteId) {
    return (runtime?.lateWithdrawalAttempts || []).find(attempt =>
        Number(attempt.noteId) === Number(noteId)
        && !LATE_WITHDRAWAL_TERMINAL_STATUSES.has(attempt.status)) || null;
}

async function responsePayload(response) {
    const text = await response.text();
    try {
        return text ? JSON.parse(text) : {};
    } catch {
        return { raw: text };
    }
}

class BrowserWalletRuntime extends EventTarget {
    constructor() {
        super();
        this.worker = null;
        this.browserConfig = null;
        this.manifest = null;
        this.config = null;
        this.runtime = null;
        this.withdrawals = [];
        this.activeLease = null;
        this.initialized = false;
        this.initPromise = null;
        this.leasePromise = null;
        this.leasePromiseSession = null;
        this.leaseAbortController = null;
        this.leaseWaiterCount = 0;
        this.leaseProgressListeners = new Set();
        this.lastLeaseProgress = null;
        this.retirementPromise = null;
        this.requestProverWarmup = null;
        this.settlementTimer = null;
        this.legacyMigrationInProgress = false;
        this.channel = null;
        // sessionStorage survives a reload in this tab but is isolated from an
        // independently-opened OA Chat tab. That lets crash recovery retire a
        // lost in-memory key without allowing another live tab to take it.
        this.ownerId = browserTabOwnerId();
    }

    async init() {
        if (this.initPromise) return this.initPromise;
        this.initPromise = this.initialize();
        return this.initPromise;
    }

    async initialize() {
        this.browserConfig = await this.loadBrowserConfig();
        const allowedManifests = (this.browserConfig.allowed_deployment_manifest_urls
            || [this.browserConfig.deployment_manifest_url])
            .filter(Boolean)
            .map(value => new URL(value, location.href).href);
        const requestedManifest = new URLSearchParams(location.search).get('zkapiDeployment');
        const storedManifest = localStorage.getItem('zkapi-browser-deployment');
        if (requestedManifest
            && !allowedManifests.includes(new URL(requestedManifest, location.href).href)) {
            throw new Error('The selected deployment manifest is not trusted by this OA Chat build.');
        }
        if (storedManifest
            && !allowedManifests.includes(new URL(storedManifest, location.href).href)) {
            localStorage.removeItem('zkapi-browser-deployment');
        }
        const configuredManifest = requestedManifest
            || (storedManifest && allowedManifests.includes(new URL(storedManifest, location.href).href)
                ? storedManifest
                : null)
            || this.browserConfig.deployment_manifest_url;
        if (!configuredManifest) throw new Error('The website has no zkAPI deployment manifest configured.');
        const manifestUrl = new URL(configuredManifest, location.href).href;
        if (!allowedManifests.includes(manifestUrl)) {
            throw new Error('The selected deployment manifest is not trusted by this OA Chat build.');
        }
        this.manifest = await this.directJson(manifestUrl);
        this.validateManifest(this.manifest);
        this.validateManifestTrust(this.manifest);
        localStorage.setItem('zkapi-browser-deployment', manifestUrl);
        this.config = this.buildClientConfig(this.manifest, this.browserConfig);
        this.worker = new WorkerBridge();
        // Initialization participates in the same global lock as every later
        // mutation. This prevents two same-origin deployment tabs from both
        // rebinding the singleton runtime and committing stale snapshots.
        await withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            if (this.runtime.deploymentId !== this.manifest.deployment_id) {
                this.runtime = await writeBrowserWallet({
                    ...this.runtime,
                    deploymentId: this.manifest.deployment_id
                });
            }
            await this.recoverPendingLocked({ retireLostKey: true, quiet: true });
        });
        this.channel = createWalletChannel(this.manifest.deployment_id, () => {
            // A channel notification can arrive while this tab is awaiting a
            // proof or server response inside a wallet mutation. Reading the
            // singleton IndexedDB snapshot outside the global lock can then
            // install an older in-memory value which the mutation later
            // spreads into a commit. Queue the refresh behind mutations.
            void withBrowserWalletLock(this.manifest.deployment_id, () => this.reload())
                .then(() => this.dispatchEvent(new Event('change')))
                .catch(error => this.dispatchEvent(new CustomEvent('runtime-error', { detail: error })));
        });
        await requestPersistentStorage();
        this.initialized = true;
        return this.snapshot();
    }

    async loadBrowserConfig() {
        const response = await fetch(DEFAULT_BROWSER_CONFIG_URL, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Unable to load browser-config.json (${response.status}).`);
        return response.json();
    }

    deploymentProxyUrl(url) {
        const proxyPath = this.browserConfig?.deployment_api_proxy_path;
        if (!proxyPath) return null;
        const proxyBase = new URL(proxyPath, location.origin);
        if (proxyBase.origin !== location.origin || !proxyBase.pathname.endsWith('/')) {
            throw new Error('browser-config.json contains an invalid deployment API proxy path.');
        }
        const target = new URL(url, location.href);
        const trusted = this.browserConfig?.trusted_deployment;
        const trustedOrigins = new Set([
            trusted?.protocol_server_url,
            trusted?.indexer_url,
            this.browserConfig?.deployment_manifest_url,
            ...(this.browserConfig?.allowed_deployment_manifest_urls || [])
        ].filter(Boolean).map(value => new URL(value, location.href).origin));
        if (!trustedOrigins.has(target.origin)) return null;
        return new URL(`${target.pathname.replace(/^\/+/, '')}${target.search}`, proxyBase).href;
    }

    async directJson(url) {
        const proxyUrl = this.deploymentProxyUrl(url);
        let response = proxyUrl
            ? await fetch(proxyUrl, { cache: 'no-store', credentials: 'same-origin' })
            : null;
        // Local static development servers do not necessarily provide the
        // production rewrite. Fall back to the deployment URL only for that
        // unambiguous case; Vercel serves the trusted target at the proxy URL.
        if (!response || response.status === 404) {
            response = await fetch(url, { cache: 'no-store' });
        }
        if (!response.ok) throw new Error(`Unable to load ${url} (${response.status}).`);
        return response.json();
    }

    validateManifest(manifest) {
        if (Number(manifest.protocol_version) !== 2 || manifest.proof_backend !== 'groth16_bn254') {
            throw new Error('The selected deployment is not a zkAPI v2 Groth16 deployment.');
        }
        for (const field of ['deployment_id', 'contract_address', 'protocol_server_url', 'indexer_url']) {
            if (!manifest[field]) throw new Error(`The deployment manifest omitted ${field}.`);
        }
        if (!/^0x[0-9a-fA-F]{40}$/.test(manifest.contract_address)
            || (manifest.billing_token_address && !/^0x[0-9a-fA-F]{40}$/.test(manifest.billing_token_address))) {
            throw new Error('The deployment manifest contains an invalid contract address.');
        }
        for (const field of ['protocol_server_url', 'indexer_url']) {
            const url = new URL(manifest[field]);
            if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(url.hostname)) {
                throw new Error(`The deployment ${field} is not HTTPS or loopback.`);
            }
        }
        if (!manifest.state_signing_key?.x || !manifest.clearance_signing_key?.x) {
            throw new Error('The deployment manifest omitted its pinned server signing keys.');
        }
        if (!manifest.privacy_mode?.openrouter_inference_base) {
            throw new Error('The deployment does not advertise prompt-private OpenRouter leases.');
        }
    }

    validateManifestTrust(manifest) {
        const trusted = this.browserConfig.trusted_deployment;
        if (!trusted) {
            throw new Error('browser-config.json omitted its trusted deployment pins.');
        }
        const requireEqual = (actual, expected, label, normalize = value => String(value)) => {
            if (expected == null || normalize(actual) !== normalize(expected)) {
                throw new Error(`The deployment manifest changed its pinned ${label}.`);
            }
        };
        const lowercase = value => String(value || '').toLowerCase();
        const normalizedUrl = value => normalizeUrl(new URL(value).href);
        requireEqual(manifest.deployment_id, trusted.deployment_id, 'deployment id');
        requireEqual(manifest.chain_id, trusted.chain_id, 'chain id', Number);
        requireEqual(manifest.contract_address, trusted.contract_address, 'vault address', lowercase);
        requireEqual(manifest.billing_token_address, trusted.billing_token_address, 'billing token', lowercase);
        requireEqual(manifest.protocol_server_url, trusted.protocol_server_url, 'protocol server', normalizedUrl);
        requireEqual(manifest.indexer_url, trusted.indexer_url, 'indexer', normalizedUrl);
        requireEqual(manifest.request_charge_cap, trusted.request_charge_cap, 'request charge cap', Number);
        for (const keyName of ['state_signing_key', 'clearance_signing_key']) {
            for (const coordinate of ['x', 'y']) {
                requireEqual(
                    manifest[keyName]?.[coordinate],
                    trusted[keyName]?.[coordinate],
                    `${keyName}.${coordinate}`,
                    lowercase
                );
            }
        }
        requireEqual(
            manifest.proof_setup?.request_proving_key_sha256,
            trusted.request_proving_key_sha256,
            'request proving key hash',
            lowercase
        );
        requireEqual(
            manifest.proof_setup?.withdrawal_proving_key_sha256,
            trusted.withdrawal_proving_key_sha256,
            'withdrawal proving key hash',
            lowercase
        );
        requireEqual(
            manifest.privacy_mode?.openrouter_inference_base,
            trusted.openrouter_inference_base,
            'OpenRouter origin',
            normalizedUrl
        );
        requireEqual(
            manifest.privacy_mode?.verifier_url,
            trusted.verifier_url,
            'OA verifier',
            normalizedUrl
        );
    }

    buildClientConfig(manifest, browserConfig) {
        const keyBase = new URL(browserConfig.proving_keys_base_url || './proofs/', DEFAULT_BROWSER_CONFIG_URL);
        const requestKey = new URL('request.pk', keyBase).href;
        const withdrawalKey = new URL('withdrawal.pk', keyBase).href;
        const requestCap = Number(manifest.request_charge_cap);
        const creditsPerUsd = Number(browserConfig.credits_per_usd || 1_000_000);
        return {
            ux_proposal: String(browserConfig.ux_proposal || 'quiet'),
            credits_per_usd: creditsPerUsd,
            request_charge_cap: requestCap,
            request_charge_cap_usd: requestCap / creditsPerUsd,
            policy_charge_cap: Number(manifest.policy_charge_cap || requestCap),
            policy_enabled: Boolean(manifest.policy_enabled),
            upstream_kind: 'openrouter',
            direct_openrouter_available: true,
            request_mode: 'direct_openrouter',
            browser_wallet: true,
            active_lease: null,
            prepared_withdrawal: null,
            wallet_core: {
                protocol_version: Number(manifest.protocol_version),
                chain_id: Number(manifest.chain_id),
                contract_address: manifest.contract_address,
                request_charge_cap: requestCap,
                policy_charge_cap: Number(manifest.policy_charge_cap || requestCap),
                policy_enabled: Boolean(manifest.policy_enabled),
                state_signing_key: manifest.state_signing_key,
                clearance_signing_key: manifest.clearance_signing_key
            },
            proving_keys: {
                request: {
                    url: requestKey,
                    sha256: manifest.proof_setup?.request_proving_key_sha256
                },
                withdrawal: {
                    url: withdrawalKey,
                    sha256: manifest.proof_setup?.withdrawal_proving_key_sha256
                }
            },
            openrouter: {
                inference_base: normalizeUrl(manifest.privacy_mode.openrouter_inference_base),
                verifier_url: normalizeUrl(manifest.privacy_mode.verifier_url),
                require_oa_key_source: browserConfig.require_oa_key_source !== false
            },
            funding: {
                contract_address: manifest.contract_address,
                chain_id: Number(manifest.chain_id),
                indexer_url: normalizeUrl(manifest.indexer_url),
                protocol_server_url: normalizeUrl(manifest.protocol_server_url),
                models: manifest.models || [],
                suggested_deposit_amount: Number(browserConfig.suggested_deposit_amount || requestCap * 100),
                demo_rpc_url: manifest.rpc_url || null,
                demo_billing_token_address: manifest.billing_token_address || null,
                billing_token_symbol: String(browserConfig.billing_token_symbol || 'TOKEN'),
                billing_token_decimals: Number(browserConfig.billing_token_decimals || 6),
                demo_mint_enabled: Boolean(manifest.demo_mint_enabled),
                demo_note_ttl_seconds: Number(manifest.note_ttl_seconds || 0) || null
            }
        };
    }

    snapshot() {
        const active = this.activeLease && this.activeLease.expires_at > Math.floor(Date.now() / 1000)
            ? {
                session_id: this.activeLease.sessionId,
                client_request_id: this.activeLease.client_request_id,
                expires_at: this.activeLease.expires_at,
                settle_after: this.activeLease.settle_after,
                spending_limit_usd: Number(this.activeLease.spending_limit_usd),
                station_id: this.activeLease.verification?.station_id || null
            }
            : null;
        const prepared = this.runtime?.preparedWithdrawal;
        const pendingDeposit = this.runtime?.pendingDeposit;
        const preparedHashes = new Set((Array.isArray(prepared?.transactionHashes)
            ? prepared.transactionHashes
            : prepared?.transactionHash ? [prepared.transactionHash] : [])
            .map(hash => String(hash).toLowerCase()));
        const replacementIdentities = new Set((prepared?.transactionAttempts || [])
            .filter(attempt => preparedHashes.has(String(attempt.hash || '').toLowerCase())
                && /^0x[0-9a-fA-F]{40}$/.test(attempt.from || '')
                && Number.isSafeInteger(Number(attempt.nonce))
                && Number(attempt.nonce) >= 0)
            .map(attempt => `${attempt.from.toLowerCase()}:${Number(attempt.nonce)}`));
        const pendingDepositHashes = new Set((Array.isArray(pendingDeposit?.transactionHashes)
            ? pendingDeposit.transactionHashes
            : pendingDeposit?.transactionHash ? [pendingDeposit.transactionHash] : [])
            .map(hash => String(hash).toLowerCase()));
        const depositReplacementIdentities = new Set((pendingDeposit?.transactionAttempts || [])
            .filter(attempt => pendingDepositHashes.has(String(attempt.hash || '').toLowerCase())
                && /^0x[0-9a-fA-F]{40}$/.test(attempt.from || '')
                && Number.isSafeInteger(Number(attempt.nonce))
                && Number(attempt.nonce) >= 0)
            .map(attempt => `${attempt.from.toLowerCase()}:${Number(attempt.nonce)}`));
        const config = this.config ? {
            ...this.config,
            active_lease: active,
            late_withdrawal_attempts: (this.runtime?.lateWithdrawalAttempts || [])
                .filter(attempt => !LATE_WITHDRAWAL_TERMINAL_STATUSES.has(attempt.status))
                .map(attempt => ({
                    operation_id: attempt.operationId,
                    note_id: Number(attempt.noteId),
                    mode: attempt.mode,
                    destination: attempt.destination,
                    transaction_hash: attempt.transactionHash,
                    status: attempt.status,
                    error: attempt.error || null
                })),
            late_deposit_attempts: (this.runtime?.lateDepositAttempts || [])
                .filter(attempt => !LATE_DEPOSIT_TERMINAL_STATUSES.has(attempt.status))
                .map(attempt => ({
                    operation_id: attempt.operationId,
                    note_id: Number(attempt.noteId),
                    amount: Number(attempt.amount),
                    transaction_hash: attempt.transactionHash,
                    status: attempt.status
                })),
            pending_deposit: pendingDeposit ? {
                phase: pendingDeposit.phase || (pendingDeposit.transactionHash ? 'submitted' : 'ambiguous'),
                amount: Number(pendingDeposit.amount),
                next_note_id: Number(pendingDeposit.next_note_id),
                transaction_hash: pendingDeposit.transactionHash || null,
                transaction_hashes: Array.isArray(pendingDeposit.transactionHashes)
                    ? [...pendingDeposit.transactionHashes]
                    : pendingDeposit.transactionHash ? [pendingDeposit.transactionHash] : [],
                replacement_available: pendingDeposit.phase === 'dropped_or_pending'
                    && depositReplacementIdentities.size === 1
            } : null,
            prepared_withdrawal: prepared ? {
                mode: prepared.mode,
                phase: prepared.phase || (prepared.transactionHash ? 'submitted' : 'prepared'),
                note_id: prepared.public_inputs?.note_id ?? prepared.noteId ?? prepared.note_id,
                destination: Array.isArray(prepared.public_inputs?.destination)
                    ? `0x${prepared.public_inputs.destination.map(byte => Number(byte).toString(16).padStart(2, '0')).join('')}`
                    : prepared.destination,
                transaction_hash: prepared.transactionHash || null,
                clearance_reserved: prepared.clearanceReserved === true || prepared.mode === 'mutual',
                replacement_available: prepared.phase === 'dropped_or_pending'
                    && replacementIdentities.size === 1
            } : null
        } : null;
        return {
            config,
            runtime: this.runtime,
            activeLease: active,
            withdrawals: this.withdrawals.map(record => {
                const {
                    state: _state,
                    preparedWithdrawal: _prepared,
                    proof: _proof,
                    withdrawalNullifier: _nullifier,
                    ...summary
                } = record;
                return { ...summary, backgroundWithdrawalReady: isUnsubmittedParkedMutualWithdrawal(
                    record, this.runtime?.lateWithdrawalAttempts || []
                ), backgroundPreparationCancelable: Boolean(this.config && this.manifest)
                    && isBrowserBackgroundWithdrawalPreparationCancelable(
                        record, this.runtime, this.backgroundWithdrawalIdentity(record)
                    ) };
            })
        };
    }

    async reload() {
        const deploymentId = this.manifest?.deployment_id || this.runtime?.deploymentId || null;
        const snapshot = await readBrowserWalletSnapshot(deploymentId);
        const storedRuntime = snapshot.runtime;
        const hasDurableState = Boolean(
            storedRuntime.state
            || storedRuntime.journal
            || storedRuntime.pendingDeposit
            || storedRuntime.preparedWithdrawal
            || storedRuntime.lease
            || (Array.isArray(storedRuntime.lateWithdrawalAttempts)
                && storedRuntime.lateWithdrawalAttempts.some(attempt =>
                    !LATE_WITHDRAWAL_TERMINAL_STATUSES.has(attempt.status)))
            || (Array.isArray(storedRuntime.lateDepositAttempts)
                && storedRuntime.lateDepositAttempts.some(attempt =>
                    !LATE_DEPOSIT_TERMINAL_STATUSES.has(attempt.status)))
        );
        if (this.manifest && storedRuntime.deploymentId
            && storedRuntime.deploymentId !== this.manifest.deployment_id
            && hasDurableState) {
            throw new Error(`This browser contains a wallet for ${storedRuntime.deploymentId}. Switch back to that deployment before using or withdrawing it.`);
        }
        this.runtime = storedRuntime.deploymentId
            && this.manifest
            && storedRuntime.deploymentId !== this.manifest.deployment_id
            ? { ...storedRuntime, deploymentId: this.manifest.deployment_id }
            : storedRuntime;
        this.withdrawals = snapshot.withdrawals;
        return this.runtime;
    }

    notify() {
        this.channel?.postMessage({ updatedAt: this.runtime.updatedAt });
        this.dispatchEvent(new Event('change'));
    }

    async commit(next) {
        this.runtime = await writeBrowserWallet({ ...next, deploymentId: this.manifest.deployment_id });
        this.notify();
        return this.runtime;
    }

    async walletStatus() {
        await this.init();
        const status = await this.worker.call('walletStatus', {
            state: this.runtime.state,
            journal: this.runtime.journal
        });
        // Let the lightweight status needed for the first paint leave the
        // worker before beginning the CPU-heavy decode. The warm-up then runs
        // while a funded user reads or types, without delaying page readiness.
        if (this.runtime.state || this.runtime.pendingDeposit) {
            void this.prewarmRequestProver();
        }
        return status;
    }

    prewarmRequestProver() {
        if (!this.worker || !this.config?.proving_keys?.request) {
            return Promise.resolve(false);
        }
        if (this.requestProverWarmup) return this.requestProverWarmup;
        const warmup = this.worker.call('preloadRequestProver', {
            provingKey: this.config.proving_keys.request
        }).then(() => true).catch(error => {
            // Pre-warming is an optimization. A failed fetch/decode must stay
            // silent here and be retried by the normal Send path later.
            if (this.requestProverWarmup === warmup) this.requestProverWarmup = null;
            console.warn('Unable to pre-warm the zkAPI request prover.', error);
            return false;
        });
        this.requestProverWarmup = warmup;
        return warmup;
    }

    async hasPendingLease() {
        await this.init();
        await this.reload();
        return Boolean(this.activeLease || this.runtime?.journal);
    }

    async remoteFetch(url, init = {}) {
        const proxyUrl = this.deploymentProxyUrl(url);
        if (proxyUrl) {
            try {
                const response = await fetch(proxyUrl, {
                    ...init,
                    credentials: 'same-origin'
                });
                if (response.status !== 404) return response;
            } catch {
                // A local static development server may not implement the
                // production rewrite. Keep the existing privacy-proxy/direct
                // fallback available there.
            }
        }
        return networkProxy.fetch(url, init, { preferProxy: true });
    }

    async remoteJson(url, init = {}) {
        const response = await this.remoteFetch(url, init);
        let payload = await responsePayload(response);
        if (!response.ok) {
            const retryAfterHeader = response.headers.get('retry-after');
            const retryAfter = retryAfterHeader == null || retryAfterHeader.trim() === ''
                ? Number.NaN
                : Number(retryAfterHeader);
            if (Number.isFinite(retryAfter) && retryAfter >= 0
                && payload?.retry_after_seconds == null) {
                payload = { ...payload, retry_after_seconds: retryAfter };
            }
            const details = payload?.error && typeof payload.error === 'object'
                ? payload.error
                : {};
            throw new BrowserWalletHttpError(
                details.error_message
                    || details.message
                    || payload.error_message
                    || payload.message
                    || `HTTP ${response.status}`,
                response.status,
                details.error_code
                    || details.code
                    || payload.error_code
                    || payload.code,
                payload
            );
        }
        return payload;
    }

    async treePath(noteId, requireExisting = true, expectedActiveRoot = null) {
        return waitForExpectedActiveRoot(async () => {
            const snapshot = await this.remoteJson(`${this.config.funding.indexer_url}/v1/tree/snapshot`);
            return this.worker.call('treePath', { snapshot, noteId, requireExisting });
        }, expectedActiveRoot, { sleep: milliseconds => delay(milliseconds) });
    }

    async nextDepositPath(expectedActiveRoot = null) {
        return waitForExpectedActiveRoot(async () => {
            const snapshot = await this.remoteJson(`${this.config.funding.indexer_url}/v1/tree/snapshot`);
            return this.worker.call('treePath', {
                snapshot,
                noteId: Number(snapshot.next_note_id),
                requireExisting: false
            });
        }, expectedActiveRoot, { sleep: milliseconds => delay(milliseconds) });
    }

    async prepareDeposit(amount) {
        await this.init();
        const plan = await withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            if (this.runtime.state) throw new Error('This browser already has an active private note.');
            if (this.runtime.pendingDeposit) {
                let pending = this.runtime.pendingDeposit;
                if (!pending.operationId || !pending.phase) {
                    // Legacy clients opened MetaMask without a durable claim.
                    // A missing hash is not proof that nothing was broadcast.
                    pending = {
                        ...pending,
                        operationId: pending.operationId || uuid(),
                        phase: pending.transactionHash ? 'submitted' : 'ambiguous',
                        legacyRecovery: true
                    };
                    await this.commit({ ...this.runtime, pendingDeposit: pending });
                }
                if (Number(pending.amount) !== Number(amount)) {
                    if (pending.phase !== 'prepared' || pending.submissionId
                        || pending.transactionHash || pending.transactionHashes?.length) {
                        throw new Error('A previous deposit may already be in MetaMask. Recover it before changing the amount.');
                    }
                    await this.commit({ ...this.runtime, pendingDeposit: null });
                    await this.reload();
                } else {
                    return pending;
                }
            }
            const params = await this.worker.call('generateDeposit');
            const path = await this.nextDepositPath();
            const plan = {
                operationId: uuid(),
                phase: 'prepared',
                amount: Number(amount),
                secret: params.secret,
                commitment: params.registration_commitment,
                next_note_id: path.note_id,
                active_root: path.active_root,
                zero_path: path.siblings
            };
            // Persist the note secret before MetaMask is opened. If the tab is
            // closed after the transaction is submitted, the deposit can still
            // be confirmed from its on-chain receipt without losing funds.
            await this.commit({ ...this.runtime, pendingDeposit: plan });
            return plan;
        });
        // Start only after deposit preparation's small WASM calls have left the
        // worker. MetaMask/on-chain confirmation normally outlasts the decode,
        // hiding it without creating a lease or disposable inference request.
        void this.prewarmRequestProver();
        return plan;
    }

    async refreshPendingDeposit(amount, expectedActiveRoot = null) {
        await this.init();
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            if (this.runtime.state) throw new Error('This browser already has an active private note.');
            const pending = this.runtime.pendingDeposit;
            if (!pending) throw new Error('The durable pending deposit is missing.');
            if (Number(pending.amount) !== Number(amount)) {
                throw new Error('The prepared private note has a different deposit amount.');
            }
            const hashes = Array.isArray(pending.transactionHashes)
                ? pending.transactionHashes
                : pending.transactionHash ? [pending.transactionHash] : [];
            if (pending.phase !== 'prepared' || pending.submissionId || hashes.length) {
                throw new Error('This deposit already has a wallet attempt. Check it before refreshing the vault path.');
            }
            const path = await this.nextDepositPath(expectedActiveRoot);
            const refreshed = {
                ...pending,
                next_note_id: path.note_id,
                active_root: path.active_root,
                zero_path: path.siblings
            };
            // Keep the durable secret and commitment, but rebase their unused
            // note onto the latest append position after mint/approval prompts.
            await this.commit({ ...this.runtime, pendingDeposit: refreshed });
            return refreshed;
        });
    }

    async pendingDeposit() {
        await this.init();
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            return this.runtime.pendingDeposit ? { ...this.runtime.pendingDeposit } : null;
        });
    }

    async claimPendingDepositSubmission() {
        await this.init();
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            const pending = this.runtime.pendingDeposit;
            if (!pending) throw new Error('The durable pending deposit is missing.');
            const hashes = Array.isArray(pending.transactionHashes)
                ? pending.transactionHashes
                : pending.transactionHash ? [pending.transactionHash] : [];
            if (hashes.length) {
                return {
                    status: 'submitted',
                    transactionHash: hashes[0],
                    operationId: pending.operationId,
                    submissionId: pending.submissionId || null,
                    noteId: Number(pending.next_note_id),
                    amount: Number(pending.amount),
                    commitment: pending.commitment,
                    secret: pending.secret,
                    deploymentId: this.manifest.deployment_id,
                    chainId: Number(this.config.funding.chain_id),
                    contractAddress: this.config.funding.contract_address
                };
            }
            if (pending.phase === 'ambiguous') {
                throw new BrowserWalletHttpError(
                    'The previous deposit has an unknown result. Check it before explicitly retrying.',
                    409,
                    'deposit_submission_ambiguous'
                );
            }
            if (pending.submissionId) {
                throw new BrowserWalletHttpError(
                    'This deposit is already awaiting MetaMask in this or another tab.',
                    409,
                    'deposit_wallet_pending'
                );
            }
            if (!['prepared', 'retry_exact'].includes(pending.phase)) {
                throw new Error('This deposit is not ready for a wallet request.');
            }
            const submissionId = uuid();
            const next = {
                ...pending,
                phase: 'awaiting_wallet',
                submissionId,
                submissionOwner: this.ownerId,
                submissionStartedAt: Date.now()
            };
            await this.commit({ ...this.runtime, pendingDeposit: next });
            return {
                status: 'claimed',
                transactionHash: null,
                operationId: next.operationId,
                submissionId,
                noteId: Number(next.next_note_id),
                amount: Number(next.amount),
                commitment: next.commitment,
                secret: next.secret,
                deploymentId: this.manifest.deployment_id,
                chainId: Number(this.config.funding.chain_id),
                contractAddress: this.config.funding.contract_address
            };
        });
    }

    async claimPendingDepositReplacement(expectedFrom) {
        await this.init();
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            const pending = this.runtime.pendingDeposit;
            if (!pending || pending.phase !== 'dropped_or_pending') {
                throw new Error('Check the submitted deposit before replacing it.');
            }
            if (pending.submissionId) {
                throw new Error('A deposit replacement request is already open in MetaMask.');
            }
            const hashes = Array.isArray(pending.transactionHashes)
                ? pending.transactionHashes
                : pending.transactionHash ? [pending.transactionHash] : [];
            const hashSet = new Set(hashes.map(hash => String(hash).toLowerCase()));
            const identities = [...new Map((pending.transactionAttempts || [])
                .filter(attempt => hashSet.has(String(attempt.hash || '').toLowerCase())
                    && /^0x[0-9a-fA-F]{40}$/.test(attempt.from || '')
                    && Number.isSafeInteger(Number(attempt.nonce))
                    && Number(attempt.nonce) >= 0)
                .map(attempt => {
                    const identity = {
                        from: attempt.from.toLowerCase(),
                        nonce: Number(attempt.nonce)
                    };
                    return [`${identity.from}:${identity.nonce}`, identity];
                })).values()];
            if (identities.length !== 1) {
                throw new Error(identities.length
                    ? 'The saved deposit has more than one wallet nonce. Use MetaMask to cancel or speed up the pending transactions, then check again.'
                    : 'The saved deposit has no replacement nonce. Use MetaMask to cancel or speed up the pending transaction, then check again.');
            }
            const [{ from, nonce }] = identities;
            if (!/^0x[0-9a-fA-F]{40}$/.test(expectedFrom || '')
                || from !== expectedFrom.toLowerCase()) {
                throw new Error(`Connect the MetaMask account ${from} that submitted this deposit.`);
            }
            const submissionId = uuid();
            const next = {
                ...pending,
                phase: 'awaiting_wallet',
                submissionOutcome: 'replacement_awaiting_wallet',
                submissionId,
                submissionOwner: this.ownerId,
                submissionStartedAt: Date.now(),
                submissionFrom: from,
                submissionNonce: nonce,
                replacementOf: [...hashSet]
            };
            await this.commit({ ...this.runtime, pendingDeposit: next });
            return {
                status: 'claimed',
                submissionId,
                transactionHash: null,
                operationId: next.operationId,
                noteId: Number(next.next_note_id),
                amount: Number(next.amount),
                commitment: next.commitment,
                secret: next.secret,
                deploymentId: this.manifest.deployment_id,
                chainId: Number(this.config.funding.chain_id),
                contractAddress: this.config.funding.contract_address,
                replacementFrom: from,
                replacementNonce: nonce,
                plan: structuredClone(next)
            };
        });
    }

    async rememberPendingDepositSubmissionMetadata(submission, metadata) {
        await this.init();
        const from = metadata?.from;
        const nonce = Number(metadata?.nonce);
        if (!/^0x[0-9a-fA-F]{40}$/.test(from || '')
            || !Number.isSafeInteger(nonce) || nonce < 0) {
            throw new Error('The deposit transaction metadata is invalid.');
        }
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            const pending = this.runtime.pendingDeposit;
            if (!this.depositSubmissionMatches(pending, submission)
                || pending.submissionId !== submission.submissionId) {
                throw new Error('The deposit wallet claim changed before its nonce was saved.');
            }
            const next = {
                ...pending,
                submissionFrom: from.toLowerCase(),
                submissionNonce: nonce
            };
            await this.commit({ ...this.runtime, pendingDeposit: next });
            return next;
        });
    }

    depositSubmissionMatches(pending, reference) {
        return Boolean(reference?.operationId && reference?.submissionId
            && pending?.operationId === reference.operationId
            && Number(pending.next_note_id) === Number(reference.noteId)
            && Number(pending.amount) === Number(reference.amount)
            && sameFelt(pending.commitment, reference.commitment)
            && reference.deploymentId === this.manifest.deployment_id
            && Number(reference.chainId) === Number(this.config.funding.chain_id)
            && String(reference.contractAddress || '').toLowerCase()
                === String(this.config.funding.contract_address || '').toLowerCase());
    }

    async rememberPendingDepositTransaction(
        transactionHash,
        submission,
        transactionMetadata = null
    ) {
        await this.init();
        if (!/^0x[0-9a-fA-F]{64}$/.test(transactionHash || '')) {
            throw new Error('MetaMask returned an invalid deposit transaction hash.');
        }
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            const pending = this.runtime.pendingDeposit;
            if (!pending) {
                throw new Error('The durable pending deposit is missing.');
            }
            if (!this.depositSubmissionMatches(pending, submission)) {
                const attempts = Array.isArray(this.runtime.lateDepositAttempts)
                    ? this.runtime.lateDepositAttempts
                    : [];
                const lateAttempt = {
                    operationId: submission?.operationId || null,
                    submissionId: submission?.submissionId || null,
                    noteId: Number(submission?.noteId),
                    amount: Number(submission?.amount),
                    commitment: submission?.commitment || null,
                    secret: submission?.secret || null,
                    deploymentId: submission?.deploymentId || null,
                    chainId: Number(submission?.chainId),
                    contractAddress: submission?.contractAddress || null,
                    transactionHash: transactionHash.toLowerCase(),
                    from: /^0x[0-9a-fA-F]{40}$/.test(transactionMetadata?.from || '')
                        ? transactionMetadata.from.toLowerCase()
                        : null,
                    nonce: Number.isSafeInteger(Number(transactionMetadata?.nonce))
                        ? Number(transactionMetadata.nonce)
                        : null,
                    status: 'submitted_late',
                    observedAt: Date.now()
                };
                await this.commit({
                    ...this.runtime,
                    lateDepositAttempts: retainAttemptHistory([...attempts.filter(attempt => !(
                        attempt.operationId === lateAttempt.operationId
                        && attempt.transactionHash === lateAttempt.transactionHash
                    )), lateAttempt], new Set(['confirmed', 'reverted', 'superseded']))
                });
                return { late: true, ...lateAttempt };
            }
            const normalizedHash = transactionHash.toLowerCase();
            const hashes = [...new Set([
                ...(Array.isArray(pending.transactionHashes)
                    ? pending.transactionHashes
                    : pending.transactionHash ? [pending.transactionHash] : []),
                normalizedHash
            ].map(value => value.toLowerCase()))];
            const pendingDeposit = {
                ...pending,
                phase: 'submitted',
                transactionHash: hashes[0],
                transactionHashes: hashes,
                transactionAttempts: [
                    ...(Array.isArray(pending.transactionAttempts)
                        ? pending.transactionAttempts.filter(attempt => attempt.hash !== normalizedHash)
                        : []),
                    {
                        hash: normalizedHash,
                        submissionId: submission.submissionId,
                        operationId: submission.operationId,
                        from: /^0x[0-9a-fA-F]{40}$/.test(
                            transactionMetadata?.from || pending.submissionFrom || ''
                        )
                            ? (transactionMetadata?.from || pending.submissionFrom).toLowerCase()
                            : null,
                        nonce: Number.isSafeInteger(Number(
                            transactionMetadata?.nonce ?? pending.submissionNonce
                        ))
                            ? Number(transactionMetadata?.nonce ?? pending.submissionNonce)
                            : null,
                        observedAt: Date.now()
                    }
                ]
            };
            if (pending.submissionId === submission.submissionId) {
                delete pendingDeposit.submissionId;
                delete pendingDeposit.submissionOwner;
                delete pendingDeposit.submissionStartedAt;
                delete pendingDeposit.submissionFrom;
                delete pendingDeposit.submissionNonce;
            }
            await this.commit({ ...this.runtime, pendingDeposit });
            return { ...pendingDeposit };
        });
    }

    async markPendingDepositRetryable(expectedTransactionHash = null, submission = null) {
        await this.init();
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            const pending = this.runtime.pendingDeposit;
            if (!pending) return null;
            if (!expectedTransactionHash && !this.depositSubmissionMatches(pending, submission)) {
                throw new Error('The deposit operation changed while MetaMask was open.');
            }
            const hashes = Array.isArray(pending.transactionHashes)
                ? pending.transactionHashes
                : pending.transactionHash ? [pending.transactionHash] : [];
            if (expectedTransactionHash
                && !hashes.some(hash => hash.toLowerCase() === expectedTransactionHash.toLowerCase())) {
                throw new Error('The deposit transaction changed while its receipt was checked.');
            }
            const remaining = expectedTransactionHash
                ? hashes.filter(hash => hash.toLowerCase() !== expectedTransactionHash.toLowerCase())
                : hashes;
            const releasesClaim = !expectedTransactionHash
                && pending.submissionId === submission?.submissionId;
            const next = {
                ...pending,
                phase: remaining.length
                    ? 'submitted'
                    : pending.submissionId && !releasesClaim
                        ? (pending.phase === 'ambiguous' ? 'ambiguous' : 'awaiting_wallet')
                        : 'prepared',
                transactionHashes: remaining,
                transactionAttempts: Array.isArray(pending.transactionAttempts)
                    ? pending.transactionAttempts.filter(attempt => !expectedTransactionHash
                        || attempt.hash.toLowerCase() !== expectedTransactionHash.toLowerCase())
                    : []
            };
            if (remaining.length) next.transactionHash = remaining[0];
            else {
                delete next.transactionHash;
                delete next.transactionHashes;
            }
            if (releasesClaim) {
                delete next.submissionId;
                delete next.submissionOwner;
                delete next.submissionStartedAt;
                delete next.submissionFrom;
                delete next.submissionNonce;
            }
            await this.commit({ ...this.runtime, pendingDeposit: next });
            return next;
        });
    }

    async markPendingDepositMissingReceipts(expectedTransactionHashes) {
        await this.init();
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            const pending = this.runtime.pendingDeposit;
            if (!pending) return null;
            const normalize = values => [...values]
                .map(value => String(value).toLowerCase())
                .sort();
            const hashes = Array.isArray(pending.transactionHashes)
                ? pending.transactionHashes
                : pending.transactionHash ? [pending.transactionHash] : [];
            if (JSON.stringify(normalize(hashes))
                !== JSON.stringify(normalize(expectedTransactionHashes || []))) {
                throw new Error('The deposit transactions changed while their receipts were checked.');
            }
            if (pending.submissionId) return pending;
            if (pending.phase === 'dropped_or_pending') return pending;
            const next = {
                ...pending,
                phase: 'dropped_or_pending',
                submissionOutcome: 'receipt_missing',
                missingReceiptCheckedAt: Date.now()
            };
            await this.commit({ ...this.runtime, pendingDeposit: next });
            return next;
        });
    }

    async releasePendingDepositReplacementClaim(submission, message = null) {
        await this.init();
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            const pending = this.runtime.pendingDeposit;
            if (!pending || pending.submissionId !== submission?.submissionId
                || pending.operationId !== submission?.operationId
                || !Number.isSafeInteger(Number(submission?.replacementNonce))) {
                throw new Error('The deposit replacement request changed before it could be released.');
            }
            const history = Array.isArray(pending.ambiguousReplacements)
                ? pending.ambiguousReplacements
                : [];
            const next = {
                ...pending,
                phase: 'dropped_or_pending',
                submissionOutcome: 'replacement_result_unknown',
                ambiguousReplacements: [...history, {
                    submissionId: pending.submissionId,
                    nonce: Number(submission.replacementNonce),
                    startedAt: pending.submissionStartedAt,
                    releasedAt: Date.now(),
                    message: message || 'The wallet did not return a deposit replacement transaction ID.'
                }].slice(-8),
                missingReceiptCheckedAt: Date.now()
            };
            delete next.submissionId;
            delete next.submissionOwner;
            delete next.submissionStartedAt;
            delete next.submissionFrom;
            delete next.submissionNonce;
            delete next.submissionError;
            await this.commit({ ...this.runtime, pendingDeposit: next });
            return next;
        });
    }

    async markPendingDepositAmbiguous(submission, message = null) {
        await this.init();
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            const pending = this.runtime.pendingDeposit;
            if (!this.depositSubmissionMatches(pending, submission)
                || pending.submissionId !== submission.submissionId) {
                throw new Error('The deposit operation changed before its unknown result could be saved.');
            }
            const next = {
                ...pending,
                phase: 'ambiguous',
                submissionError: message || 'MetaMask did not return a transaction ID.',
                ambiguousAt: Date.now()
            };
            await this.commit({ ...this.runtime, pendingDeposit: next });
            return next;
        });
    }

    async markPendingDepositUnknown() {
        await this.init();
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            const pending = this.runtime.pendingDeposit;
            if (!pending?.submissionId) throw new Error('There is no deposit wallet prompt to recover.');
            if (pending.phase === 'ambiguous') return pending;
            const next = {
                ...pending,
                phase: 'ambiguous',
                submissionError: 'The wallet prompt was closed before a transaction ID was saved.',
                ambiguousAt: Date.now()
            };
            await this.commit({ ...this.runtime, pendingDeposit: next });
            return next;
        });
    }

    async authorizePendingDepositRetry() {
        await this.init();
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            const pending = this.runtime.pendingDeposit;
            const hashes = Array.isArray(pending?.transactionHashes)
                ? pending.transactionHashes
                : pending?.transactionHash ? [pending.transactionHash] : [];
            if (!pending || pending.phase !== 'ambiguous' || !pending.submissionId || hashes.length) {
                throw new Error('There is no unknown deposit request to retry.');
            }
            const history = Array.isArray(pending.ambiguousSubmissions)
                ? pending.ambiguousSubmissions
                : [];
            const next = {
                ...pending,
                phase: 'retry_exact',
                ambiguousSubmissions: [...history, {
                    submissionId: pending.submissionId,
                    startedAt: pending.submissionStartedAt,
                    authorizedAt: Date.now()
                }].slice(-8)
            };
            delete next.submissionId;
            delete next.submissionOwner;
            delete next.submissionStartedAt;
            delete next.submissionFrom;
            delete next.submissionNonce;
            delete next.submissionError;
            await this.commit({ ...this.runtime, pendingDeposit: next });
            return next;
        });
    }

    async resolvePendingDepositSlotConflict(expected) {
        await this.init();
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            const pending = this.runtime.pendingDeposit;
            if (!pending) return null;
            const normalizeHashes = value => [...new Set((Array.isArray(value)
                ? value
                : value ? [value] : [])
                .map(hash => String(hash).toLowerCase()))].sort();
            const pendingHashes = normalizeHashes(
                pending.transactionHashes || pending.transactionHash
            );
            const expectedHashes = normalizeHashes(
                expected?.transactionHashes || expected?.transactionHash
            );
            if (!expected?.operationId
                || pending.operationId !== expected.operationId
                || Number(pending.next_note_id) !== Number(expected.noteId)
                || Number(pending.amount) !== Number(expected.amount)
                || !sameFelt(pending.commitment, expected.commitment)
                || (pending.phase || null) !== (expected.phase || null)
                || (pending.submissionId || null) !== (expected.submissionId || null)
                || JSON.stringify(pendingHashes) !== JSON.stringify(expectedHashes)) {
                throw new Error('The pending deposit changed while its vault slot was being checked. Check it again before retrying.');
            }
            const next = {
                ...pending,
                phase: 'prepared',
                previousSlot: Number(pending.next_note_id)
            };
            delete next.submissionId;
            delete next.submissionOwner;
            delete next.submissionStartedAt;
            delete next.transactionHash;
            delete next.transactionHashes;
            delete next.transactionAttempts;
            await this.commit({ ...this.runtime, pendingDeposit: next });
            return next;
        });
    }

    async confirmDeposit(args) {
        await this.init();
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            if (this.runtime.state) throw new Error('This browser already has an active private note.');
            const pending = this.runtime.pendingDeposit;
            if (!pending || pending.secret !== args.secret
                || (args.operationId && pending.operationId !== args.operationId)
                || Number(pending.next_note_id) !== Number(args.note_id)
                || Number(pending.amount) !== Number(args.amount)
                || (args.commitment && !sameFelt(pending.commitment, args.commitment))) {
                throw new Error('The deposit secret does not match this browser’s durable pending deposit.');
            }
            const state = await this.worker.call('confirmDeposit', {
                config: this.config.wallet_core,
                args: {
                    secret: args.secret,
                    note_id: Number(args.note_id),
                    amount: Number(args.amount),
                    expiry_ts: Number(args.expiry_ts)
                }
            });
            await this.commit({
                ...this.runtime,
                state,
                journal: null,
                pendingDeposit: null,
                preparedWithdrawal: null
            });
            return this.walletStatus();
        });
    }

    async prepareLeaseRequest(onProgress = () => {}, signal = null) {
        throwIfAborted(signal);
        if (!this.runtime.state) throw new Error('Fund a private balance before starting a chat.');
        if (unresolvedLateWithdrawalForNote(this.runtime, this.runtime.state.note_id)) {
            throw new BrowserWalletHttpError(
                'A withdrawal from another tab may already be on-chain. Check its status before using this balance.',
                409,
                'late_withdrawal_pending'
            );
        }
        if (this.runtime.journal) return this.runtime.journal.prepared_request;
        if (this.runtime.preparedWithdrawal) throw new Error('Finish the prepared withdrawal before sending another message.');
        onProgress('syncing', 'Checking your private balance…');
        const path = await this.treePath(this.runtime.state.note_id, true);
        throwIfAborted(signal);
        const now = Date.now();
        const spendingLimitCredits = selectLeaseSpendingLimitCredits(
            this.runtime.state.current_balance,
            this.config.request_charge_cap,
            this.config.credits_per_usd
        );
        onProgress('proving', 'Proving this chat is funded…');
        const prepared = await this.worker.call('prepareRequest', {
            config: {
                ...this.config.wallet_core,
                request_charge_cap: spendingLimitCredits,
                policy_charge_cap: this.config.policy_enabled
                    ? spendingLimitCredits
                    : this.config.wallet_core.policy_charge_cap
            },
            state: this.runtime.state,
            args: {
                payload: LEASE_AUTHORIZATION,
                active_root: path.active_root,
                merkle_siblings: path.siblings,
                client_request_id: uuid(),
                request_time: Math.floor(now / 1000),
                created_at_ms: now
            },
            provingKey: this.config.proving_keys.request
        });
        throwIfAborted(signal);
        await this.commit({ ...this.runtime, journal: prepared.journal });
        return prepared.request;
    }

    async verifyLease(lease, expectedLimitCredits, expectedRequestId, onProgress = () => {}, signal = null) {
        throwIfAborted(signal);
        if (lease.status !== 'active'
            || lease.client_request_id !== expectedRequestId
            || !lease.api_key
            || Number(lease.expires_at) <= Math.floor(Date.now() / 1000)) {
            throw new Error('The zkAPI server returned an unusable OpenRouter lease.');
        }
        const returnedLimitCredits = Math.round(
            Number(lease.spending_limit_usd) * this.config.credits_per_usd
        );
        if (!Number.isSafeInteger(returnedLimitCredits)
            || returnedLimitCredits !== Number(expectedLimitCredits)) {
            throw new Error('The zkAPI server returned a child key with the wrong spending cap.');
        }
        exactTrustedUrl(lease.openrouter_api_base, this.config.openrouter.inference_base, 'OpenRouter inference origin');
        if (this.config.openrouter.require_oa_key_source && lease.key_source !== 'oa_org') {
            throw new Error('Client policy requires an OA verifier-backed ephemeral key.');
        }
        if (lease.key_source === 'oa_org') {
            onProgress('verifying', 'Verifying the new private key with OA…');
            const evidence = lease.verification;
            if (!evidence?.station_id || !evidence.station_signature || !evidence.org_signature) {
                throw new Error('The OA lease omitted its verification evidence.');
            }
            exactTrustedUrl(evidence.verifier_url, this.config.openrouter.verifier_url, 'OA verifier');
            if (Number(evidence.key_valid_till) < Number(lease.expires_at)
                || Number(evidence.key_valid_till) - Number(lease.expires_at) > 60) {
                throw new Error('The OA evidence expiry does not safely cover the lease.');
            }
            const verification = await this.remoteJson(`${this.config.openrouter.verifier_url}/submit_key`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                signal,
                body: JSON.stringify({
                    station_id: evidence.station_id,
                    api_key: lease.api_key,
                    key_valid_till: evidence.key_valid_till,
                    station_signature: evidence.station_signature,
                    org_signature: evidence.org_signature
                })
            });
            if (verification.status !== 'verified') throw new Error('The trusted OA verifier rejected the ephemeral key.');
        }
    }

    async requestLeaseWithRetry(request, onProgress = () => {}, signal = null, retryOptions = {}) {
        const maxWaitMs = retryOptions.maxWaitMs ?? LEASE_ISSUE_MAX_WAIT_MS;
        const maxAttempts = retryOptions.maxAttempts ?? LEASE_ISSUE_MAX_ATTEMPTS;
        const initialRetryMs = retryOptions.initialRetryMs ?? LEASE_ISSUE_INITIAL_RETRY_MS;
        const maxRetryMs = retryOptions.maxRetryMs ?? LEASE_ISSUE_MAX_RETRY_MS;
        const now = retryOptions.now || Date.now;
        const sleep = retryOptions.sleep || delay;
        const deadline = now() + maxWaitMs;
        const body = JSON.stringify(request);
        let attempt = 1;

        while (true) {
            throwIfAborted(signal);
            onProgress(
                'requesting',
                attempt === 1
                    ? 'Creating a temporary key for this chat…'
                    : 'Retrying temporary key creation…'
            );
            try {
                return await this.remoteJson(`${this.config.funding.protocol_server_url}/v2/openrouter/leases`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    signal,
                    body
                });
            } catch (error) {
                throwIfAborted(signal);
                const backoffDelayMs = Math.min(
                    initialRetryMs * (2 ** Math.max(0, attempt - 1)),
                    maxRetryMs
                );
                const advertisedRetryMs = leaseRetryAfterMilliseconds(error);
                const retryDelayMs = Math.max(backoffDelayMs, advertisedRetryMs || 0);
                if (!isExplicitlyRetriableLeaseError(error)
                    || attempt >= maxAttempts
                    || now() + retryDelayMs > deadline) {
                    makeLeaseRateLimitActionable(error, advertisedRetryMs);
                    throw error;
                }

                const waitLabel = retryDelayMs < 1_000 ? 'a moment' : describeRetryDelay(retryDelayMs);
                onProgress(
                    'waiting',
                    isLeaseRateLimit(error)
                        ? `OA is briefly limiting new temporary keys. Retrying in ${waitLabel}…`
                        : `The temporary-key service is briefly unavailable. Retrying in ${waitLabel}…`
                );
                throwIfAborted(signal);
                await sleep(retryDelayMs, signal);
                attempt += 1;
            }
        }
    }

    async issueLease(sessionId, onProgress = () => {}, signal = null) {
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            throwIfAborted(signal);
            await this.reload();
            throwIfAborted(signal);
            onProgress('checking', 'Checking for unfinished private activity…');
            const reportRecovery = (phase, message) => onProgress(phase, message, 'recovery');
            await this.recoverPendingLocked({
                retireLostKey: true,
                onProgress: reportRecovery,
                signal
            });
            let request = await this.prepareLeaseRequest(onProgress, signal);

            // A browser can restart with a durable proof made under an older
            // spending policy. Finish that byte-identical request safely, but
            // never expose its legacy-cap key to OA Chat. Settle it unused,
            // install the signed receipt, then create a fresh fixed-$1 proof.
            const desiredLimitCredits = Math.round(
                CHAT_SPENDING_TIER_USD[0] * this.config.credits_per_usd
            );
            if (Number(request.public_inputs.solvency_bound) !== desiredLimitCredits) {
                try {
                    this.legacyMigrationInProgress = true;
                    reportRecovery('settling', 'Updating an unfinished temporary key…');
                    const legacyLease = await this.requestLeaseWithRetry(request, reportRecovery, signal);
                    await this.verifyLease(
                        legacyLease,
                        request.public_inputs.solvency_bound,
                        request.client_request_id,
                        reportRecovery,
                        signal
                    );
                    // Persist recovery metadata, but deliberately never assign
                    // this legacy-cap key to activeLease. It cannot be returned
                    // to inference even if settlement needs a later retry.
                    await this.commit({
                        ...this.runtime,
                        lease: {
                            ownerId: this.ownerId,
                            sessionId,
                            client_request_id: legacyLease.client_request_id,
                            expires_at: Number(legacyLease.expires_at),
                            settle_after: Number(legacyLease.settle_after),
                            spending_limit_usd: Number(legacyLease.spending_limit_usd)
                        }
                    });
                    reportRecovery('usage', 'Closing the unfinished temporary key…');
                    const status = await this.retireRequest(
                        legacyLease.client_request_id,
                        request,
                        signal
                    );
                    if (status.status !== 'finalized') {
                        throw new Error(`Lease is still ${status.status}.`);
                    }
                    const installed = await this.installRecoveredResponse(
                        legacyLease.client_request_id,
                        reportRecovery
                    );
                    if (!installed) throw new Error('The legacy private-key receipt is not ready yet.');
                } finally {
                    this.legacyMigrationInProgress = false;
                }
                await this.reload();
                request = await this.prepareLeaseRequest(onProgress, signal);
            }
            let lease;
            try {
                lease = await this.requestLeaseWithRetry(request, onProgress, signal);
            } catch (error) {
                if (error.code === 'stale_root') {
                    await this.commit({ ...this.runtime, journal: null });
                }
                throw error;
            }
            await this.verifyLease(
                lease,
                request.public_inputs.solvency_bound,
                request.client_request_id,
                onProgress,
                signal
            );
            throwIfAborted(signal);
            const activeLease = {
                ...lease,
                sessionId,
                inFlight: 0
            };
            await this.commit({
                ...this.runtime,
                lease: {
                    ownerId: this.ownerId,
                    sessionId,
                    client_request_id: lease.client_request_id,
                    expires_at: Number(lease.expires_at),
                    settle_after: Number(lease.settle_after),
                    spending_limit_usd: Number(lease.spending_limit_usd)
                }
            });
            this.activeLease = activeLease;
            this.dispatchEvent(new Event('change'));
            this.scheduleSettlement();
            onProgress('ready', 'Private chat ready.');
            return this.activeLease;
        });
    }

    addLeaseProgressListener(listener, { replay = true } = {}) {
        if (typeof listener !== 'function') return () => {};
        // Each registration gets a distinct token so two callers that happen
        // to pass the same callback can unsubscribe independently.
        const registration = (phase, message, kind) => listener(phase, message, kind);
        this.leaseProgressListeners.add(registration);
        if (replay && this.lastLeaseProgress) {
            const { phase, message, kind } = this.lastLeaseProgress;
            try {
                registration(phase, message, kind);
            } catch (error) {
                console.warn('A private-access progress listener failed.', error);
            }
        }
        return () => this.leaseProgressListeners.delete(registration);
    }

    reportLeaseProgress(phase, message, kind = 'access') {
        this.lastLeaseProgress = { phase, message, kind };
        for (const listener of this.leaseProgressListeners) {
            try {
                listener(phase, message, kind);
            } catch (error) {
                console.warn('A private-access progress listener failed.', error);
            }
        }
    }

    async waitForLeasePromise(normalizedSessionId, onProgress, signal) {
        const leasePromise = this.leasePromise;
        if (!leasePromise) return null;
        if (this.leasePromiseSession !== normalizedSessionId) {
            throw new BrowserWalletHttpError(
                `Chat ${this.leasePromiseSession} is creating the current private key.`,
                409,
                'lease_session_conflict'
            );
        }

        throwIfAborted(signal);
        const unsubscribe = this.addLeaseProgressListener(onProgress);
        this.leaseWaiterCount += 1;
        let abortHandler = null;
        try {
            if (!signal) return await leasePromise;
            const canceled = new Promise((_, reject) => {
                abortHandler = () => {
                    try {
                        throwIfAborted(signal);
                    } catch (error) {
                        reject(error);
                    }
                };
                signal.addEventListener('abort', abortHandler, { once: true });
            });
            return await Promise.race([leasePromise, canceled]);
        } finally {
            if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
            unsubscribe();
            this.leaseWaiterCount = Math.max(0, this.leaseWaiterCount - 1);
            if (signal?.aborted
                && this.leasePromise === leasePromise
                && this.leaseWaiterCount === 0) {
                this.leaseAbortController?.abort();
            }
        }
    }

    async ensureLease(sessionId, onProgress = () => {}, signal = null) {
        throwIfAborted(signal);
        await this.init();
        throwIfAborted(signal);
        const normalized = String(sessionId || 'default').slice(0, 160);
        if (this.leasePromise) {
            return this.waitForLeasePromise(normalized, onProgress, signal);
        }
        const now = Math.floor(Date.now() / 1000);
        const isSafeForNewRequest = this.activeLease
            && Number(this.activeLease.expires_at) > now + MIN_REQUEST_LEASE_REMAINING_SECONDS;
        const expectedLimitCredits = Math.round(
            CHAT_SPENDING_TIER_USD[0] * this.config.credits_per_usd
        );
        const activeLimitCredits = this.activeLease
            ? Math.round(Number(this.activeLease.spending_limit_usd) * this.config.credits_per_usd)
            : null;
        const activeLeaseMatchesPolicy = Number.isSafeInteger(activeLimitCredits)
            && activeLimitCredits === expectedLimitCredits;
        if (this.activeLease
            && isSafeForNewRequest
            && activeLeaseMatchesPolicy
            && !this.activeLease.retiring
            && !this.activeLease.retired) {
            if (this.activeLease.sessionId !== normalized) {
                throw new BrowserWalletHttpError(
                    `Chat ${this.activeLease.sessionId} owns the current private key until it settles.`,
                    409,
                    'lease_session_conflict'
                );
            }
            onProgress('ready', 'Private chat ready.', 'access');
            return this.activeLease;
        }
        if (this.activeLease?.inFlight > 0) {
            throw new BrowserWalletHttpError(
                'The current private key expired while requests were still active. Retry after they finish.',
                409,
                'lease_requests_in_flight'
            );
        }
        await this.reload();
        if (this.runtime.lease
            && Number(this.runtime.lease.settle_after || this.runtime.lease.expires_at) > now
            && this.runtime.lease.ownerId !== this.ownerId) {
            throw new BrowserWalletHttpError(
                `Another OA Chat tab owns the current private key until ${new Date(Number(this.runtime.lease.settle_after || this.runtime.lease.expires_at) * 1000).toLocaleTimeString()}.`,
                409,
                'lease_tab_conflict'
            );
        }
        if (this.leasePromise) {
            return this.waitForLeasePromise(normalized, onProgress, signal);
        }
        this.leasePromiseSession = normalized;
        this.lastLeaseProgress = null;
        const jobKind = this.activeLease ? 'renewal' : 'access';
        const controller = new AbortController();
        this.leaseAbortController = controller;
        let leasePromise;
        leasePromise = (async () => {
            if (this.activeLease) {
                await this.retireActiveLease(
                    (phase, message) => this.reportLeaseProgress(phase, message, 'renewal')
                );
            }
            return this.issueLease(
                normalized,
                (phase, message, kind = 'access') => this.reportLeaseProgress(
                    phase,
                    message,
                    kind === 'access' ? jobKind : kind
                ),
                controller.signal
            );
        })().finally(() => {
            if (this.leasePromise === leasePromise) {
                this.leasePromise = null;
                this.leasePromiseSession = null;
                this.leaseAbortController = null;
                this.lastLeaseProgress = null;
            }
        });
        this.leasePromise = leasePromise;
        return this.waitForLeasePromise(normalized, onProgress, signal);
    }

    scheduleSettlement(delayOverrideMs = null) {
        if (!this.activeLease) return;
        if (this.settlementTimer) clearTimeout(this.settlementTimer);
        const delayMs = delayOverrideMs ?? Math.max(
            0,
            Number(this.activeLease.settle_after) * 1000 - Date.now() + 250
        );
        this.settlementTimer = setTimeout(() => {
            this.settlementTimer = null;
            if (!this.activeLease) return;
            if (this.activeLease.inFlight > 0) {
                this.scheduleSettlement(500);
                return;
            }
            void this.retireActiveLease().catch(() => {
                if (this.activeLease) this.scheduleSettlement(2_000);
            });
        }, Math.min(delayMs, 2_147_000_000));
    }

    async retireRequest(clientRequestId, request, signal, retryOptions = {}) {
        const now = retryOptions.now || Date.now;
        const sleep = retryOptions.sleep || delay;
        const maxWaitMs = retryOptions.maxWaitMs ?? MAX_RECOVERY_WAIT_MS;
        const deadline = now() + maxWaitMs;
        const body = JSON.stringify(request);
        let attempt = 1;
        while (true) {
            try {
                return await this.remoteJson(`${this.config.funding.protocol_server_url}/v2/openrouter/leases/${encodeURIComponent(clientRequestId)}`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body,
                    signal
                });
            } catch (error) {
                const backoffDelayMs = Math.min(1_000 * (2 ** Math.max(0, attempt - 1)), 10_000);
                const advertisedRetryMs = leaseRetryAfterMilliseconds(error);
                const retryDelayMs = Math.max(backoffDelayMs, advertisedRetryMs || 0);
                if (!isExplicitlyRetriableLeaseRetirementError(error)
                    || now() + retryDelayMs > deadline) {
                    throw error;
                }
                await sleep(retryDelayMs, signal);
                attempt += 1;
            }
        }
    }

    async retireActiveLease(onProgress = () => {}) {
        if (this.retirementPromise) return this.retirementPromise;
        if (!this.activeLease || !this.runtime?.journal) return;
        if (this.activeLease.inFlight > 0) {
            throw new BrowserWalletHttpError(
                'Wait for the active model requests to finish before settling the private key.',
                409,
                'lease_requests_in_flight'
            );
        }
        const lease = this.activeLease;
        lease.retiring = true;
        onProgress('settling', 'Closing the temporary key from the previous chat…');
        const retireWithinLock = async () => {
            await this.reload();
            const request = this.runtime.journal?.prepared_request;
            if (!request || request.client_request_id !== lease.client_request_id) return;
            onProgress('usage', 'Confirming the previous chat’s usage…');
            const status = await this.retireRequest(lease.client_request_id, request);
            if (status.status !== 'finalized') throw new Error(`Lease is still ${status.status}.`);
            // The remote key is now disabled. Make that transition
            // irreversible locally before receipt installation, which can
            // still fail independently and be retried from the durable journal.
            lease.retired = true;
            if (this.activeLease === lease) this.activeLease = null;
            if (this.settlementTimer) clearTimeout(this.settlementTimer);
            this.settlementTimer = null;
            this.dispatchEvent(new Event('change'));
            return this.installRecoveredResponse(lease.client_request_id, onProgress);
        };
        const retirement = (async () => {
            const installed = await withBrowserWalletLock(
                this.manifest.deployment_id,
                retireWithinLock
            );
            this.activeLease = null;
            if (this.settlementTimer) clearTimeout(this.settlementTimer);
            this.settlementTimer = null;
            // installRecoveredResponse commits and notifies. Only publish here
            // when there was no recovered response (and therefore no commit).
            if (!installed) this.dispatchEvent(new Event('change'));
            return installed;
        })();
        this.retirementPromise = retirement;
        try {
            return await retirement;
        } finally {
            if (this.activeLease === lease) lease.retiring = false;
            if (this.retirementPromise === retirement) this.retirementPromise = null;
        }
    }

    async settleActiveLease(onProgress = () => {}) {
        await this.init();
        if (this.retirementPromise) {
            try {
                await this.retirementPromise;
            } catch {
                // The durable journal remains recoverable below even if the
                // first receipt-installation attempt failed.
            }
        }
        if (this.legacyMigrationInProgress) {
            throw new BrowserWalletHttpError(
                'An unfinished private key is already being updated. Try settling again in a moment.',
                409,
                'lease_pending'
            );
        }
        if (this.activeLease?.inFlight > 0) {
            throw new BrowserWalletHttpError(
                'Wait for the active model requests to finish before settling the private key.',
                409,
                'lease_requests_in_flight'
            );
        }
        if (this.activeLease) {
            await this.retireActiveLease(onProgress);
        } else {
            await this.reload();
            await this.recoverPending({ retireLostKey: true, onProgress });
        }
        await this.reload();
        if (this.runtime.journal) {
            throw new BrowserWalletHttpError(
                'The private key usage receipt is still being finalized. Try settling again shortly.',
                409,
                'lease_pending'
            );
        }
        this.activeLease = null;
        return this.walletStatus();
    }

    async installRecoveredResponse(clientRequestId, onProgress = () => {}) {
        onProgress('applying', 'Updating your private balance…');
        const recovery = await this.remoteJson(`${this.config.funding.protocol_server_url}/v2/requests/${encodeURIComponent(clientRequestId)}`);
        if (!recovery.request_response) return false;
        const state = await this.worker.call('completeResponse', {
            config: this.config.wallet_core,
            args: {
                state: this.runtime.state,
                journal: this.runtime.journal,
                response: recovery.request_response
            }
        });
        await this.commit({ ...this.runtime, state, journal: null, lease: null });
        return true;
    }

    async recoverPending(options = {}) {
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            return this.recoverPendingLocked(options);
        });
    }

    async recoverPendingLocked({ retireLostKey = false, quiet = false, onProgress = () => {}, signal = null } = {}) {
        throwIfAborted(signal);
        if (!this.runtime?.journal || this.activeLease) return false;
        const request = this.runtime.journal.prepared_request;
        try {
            const status = await this.remoteJson(`${this.config.funding.protocol_server_url}/v2/openrouter/leases/${encodeURIComponent(request.client_request_id)}`, { signal });
            if (status.status === 'active' && retireLostKey) {
                const ownershipDeadline = Number(
                    this.runtime.lease?.settle_after || this.runtime.lease?.expires_at
                );
                if (this.runtime.lease && ownershipDeadline > Math.floor(Date.now() / 1000)
                    && this.runtime.lease.ownerId !== this.ownerId) {
                    return false;
                }
                onProgress('settling', 'Finishing an interrupted private chat…');
                const retired = await this.retireRequest(request.client_request_id, request, signal);
                if (retired.status !== 'finalized') return false;
            } else if (status.status !== 'finalized') {
                return false;
            }
            return this.installRecoveredResponse(request.client_request_id, onProgress);
        } catch (error) {
            if (error.status === 404) {
                const recovery = await this.remoteJson(`${this.config.funding.protocol_server_url}/v2/nullifiers/${encodeURIComponent(this.runtime.journal.nullifier)}`, { signal });
                if (recovery.request_response) return this.installRecoveredResponse(request.client_request_id, onProgress);
                if (recovery.nullifier_status === 'clearance_reserved') {
                    // Mutual-close preparation owns this deterministic state
                    // nullifier. The lease was never accepted, so discard only
                    // its orphaned request journal and keep the withdrawal-only
                    // note/intent intact.
                    await this.commit({
                        ...this.runtime,
                        journal: null,
                        lease: null,
                        preparedWithdrawal: this.runtime.preparedWithdrawal || {
                            phase: 'reserving',
                            mode: 'mutual',
                            noteId: Number(this.runtime.state?.note_id),
                            destination: null,
                            withdrawalNullifier: this.runtime.journal.nullifier,
                            clearanceReserved: true,
                            createdAt: Date.now()
                        }
                    });
                    return true;
                }
            }
            if (!quiet) throw error;
            return false;
        }
    }

    async acquireEphemeralKey(sessionId, onProgress = () => {}, options = {}) {
        const signal = options.signal || null;
        const lease = await this.ensureLease(sessionId, onProgress, signal);
        throwIfAborted(signal);
        lease.inFlight += 1;
        let released = false;
        return {
            mode: 'ephemeral-key',
            apiKey: lease.api_key,
            baseUrl: normalizeUrl(lease.openrouter_api_base),
            spendingLimitUsd: Number(lease.spending_limit_usd),
            headers: {
                authorization: `Bearer ${lease.api_key}`,
                'content-type': 'application/json',
                'http-referer': location.origin,
                'x-title': 'oa-chat'
            },
            release: () => {
                if (released) return;
                released = true;
                // A fetch resolves when headers arrive, not when an SSE body is
                // finished. Keep the lease checked out for the whole OA stream.
                lease.inFlight = Math.max(0, lease.inFlight - 1);
                if (lease.inFlight === 0
                    && Number(lease.settle_after) * 1000 <= Date.now()) {
                    this.scheduleSettlement(0);
                }
                this.dispatchEvent(new Event('change'));
            }
        };
    }

    async prepareWithdrawal(mode, destination, { expectedActiveRoot = null } = {}) {
        await this.init();
        await this.settleActiveLease();
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            if (!this.runtime.state) throw new Error('There is no active private note to withdraw.');
            if (unresolvedLateWithdrawalForNote(this.runtime, this.runtime.state.note_id)) {
                throw new BrowserWalletHttpError(
                    'A withdrawal from another tab may already be on-chain. Check its status before starting another withdrawal.',
                    409,
                    'late_withdrawal_pending'
                );
            }
            const validateExisting = (prepared) => {
                if (!prepared) return;
                if (Number(prepared.noteId ?? prepared.note_id ?? prepared.public_inputs?.note_id)
                    !== Number(this.runtime.state.note_id)) {
                    throw new Error('The prepared withdrawal belongs to a different private balance.');
                }
                const existingDestination = prepared.destination?.toLowerCase();
                const existingHashes = Array.isArray(prepared.transactionHashes)
                    ? prepared.transactionHashes
                    : prepared.transactionHash ? [prepared.transactionHash] : [];
                const hasSubmission = Boolean(prepared.submissionId || existingHashes.length);
                const safeModeSwitch = !hasSubmission && (
                    (prepared.mode === 'mutual' && mode === 'escape')
                    || (prepared.mode === 'escape' && mode === 'mutual'
                        && prepared.clearanceReserved === true)
                );
                if (existingDestination
                    && (prepared.mode !== mode || existingDestination !== destination.toLowerCase())
                    && !(safeModeSwitch && existingDestination === destination.toLowerCase())) {
                    throw new Error('A different withdrawal is already prepared in this browser.');
                }
            };
            let existing = this.runtime.preparedWithdrawal;
            validateExisting(existing);
            await this.recoverPendingLocked({ retireLostKey: true });
            await this.reload();
            if (!this.runtime.state) throw new Error('There is no active private note to withdraw.');
            // Recovery can discover that a pre-crash request nullifier was
            // already reserved for mutual close. Re-read that marker before
            // choosing whether this note is still usable.
            existing = this.runtime.preparedWithdrawal;
            validateExisting(existing);
            if (this.runtime.journal || this.runtime.lease) {
                throw new BrowserWalletHttpError(
                    'A private chat started in another tab while withdrawal was opening. Finish that chat and try again.',
                    409,
                    'lease_pending'
                );
            }
            const existingHashes = Array.isArray(existing?.transactionHashes)
                ? existing.transactionHashes
                : existing?.transactionHash ? [existing.transactionHash] : [];
            if (existing?.submissionId && !existingHashes.length) {
                throw new BrowserWalletHttpError(
                    existing.phase === 'ambiguous'
                        ? 'MetaMask did not return a transaction ID. Check the chain, then explicitly retry if this balance is still active.'
                        : 'This withdrawal is awaiting MetaMask in this or another tab.',
                    409,
                    existing.phase === 'ambiguous'
                        ? 'withdrawal_submission_ambiguous'
                        : 'withdrawal_wallet_pending'
                );
            }
            if (existingHashes.length) {
                if (!existing.public_inputs || !existing.proof) {
                    throw new Error('The submitted withdrawal proof is missing from this browser.');
                }
                return existing;
            }
            const path = await this.treePath(this.runtime.state.note_id, true, expectedActiveRoot);
            // Withdrawal proofs are bound to the global active root. Reuse a
            // durable plan only while it still matches the canonical tree.
            if (existing?.mode === mode
                && existing.destination?.toLowerCase() === destination.toLowerCase()
                && sameFelt(existing.public_inputs?.active_root, path.active_root)) {
                return existing;
            }
            let clearance = null;
            let withdrawalNullifier = existing?.withdrawalNullifier
                || existing?.public_inputs?.withdrawal_nullifier
                || null;
            const clearanceReserved = existing?.clearanceReserved === true
                || existing?.mode === 'mutual';
            if (mode === 'mutual') {
                withdrawalNullifier = withdrawalNullifier
                    || await this.worker.call('withdrawalNullifier', { state: this.runtime.state });
                // The server's mutual-close clearance reservation is
                // deliberately irreversible for this note state. Persist the
                // intent before crossing that boundary so closing the tab can
                // never leave an apparently usable but server-rejected note.
                await this.commit({
                    ...this.runtime,
                    preparedWithdrawal: {
                        phase: 'reserving',
                        mode,
                        operationId: existing?.operationId || uuid(),
                        noteId: Number(this.runtime.state.note_id),
                        destination,
                        withdrawalNullifier,
                        clearanceReserved: true,
                        createdAt: Number(existing?.createdAt || Date.now())
                    }
                });
                clearance = await this.remoteJson(`${this.config.funding.protocol_server_url}/v2/withdraw/clearance`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ withdrawal_nullifier: withdrawalNullifier })
                });
            }
            const plan = await this.worker.call('prepareWithdrawal', {
                config: this.config.wallet_core,
                state: this.runtime.state,
                args: {
                    mode,
                    destination,
                    active_root: path.active_root,
                    merkle_siblings: path.siblings,
                    clearance
                },
                provingKey: this.config.proving_keys.withdrawal
            });
            plan.destination = destination;
            plan.phase = 'prepared';
            plan.operationId = existing?.operationId || uuid();
            plan.noteId = Number(this.runtime.state.note_id);
            plan.withdrawalNullifier = withdrawalNullifier
                || plan.public_inputs?.withdrawal_nullifier
                || null;
            plan.clearanceReserved = mode === 'mutual' || clearanceReserved;
            plan.createdAt = Number(existing?.createdAt || Date.now());
            await this.commit({ ...this.runtime, preparedWithdrawal: plan });
            return plan;
        });
    }

    async claimPreparedWithdrawalSubmission() {
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            let prepared = this.runtime.preparedWithdrawal;
            if (!prepared) throw new Error('The durable prepared withdrawal is missing.');
            if (!prepared.operationId) {
                prepared = { ...prepared, operationId: uuid() };
                await this.commit({ ...this.runtime, preparedWithdrawal: prepared });
            }
            const knownHashes = Array.isArray(prepared.transactionHashes)
                ? prepared.transactionHashes
                : prepared.transactionHash ? [prepared.transactionHash] : [];
            if (knownHashes.length) {
                return {
                    status: 'submitted',
                    transactionHash: knownHashes[0],
                    submissionId: prepared.submissionId || null,
                    operationId: prepared.operationId,
                    noteId: Number(prepared.noteId ?? prepared.public_inputs?.note_id),
                    mode: prepared.mode,
                    destination: prepared.destination,
                    finalBalance: Number(prepared.public_inputs?.final_balance
                        ?? this.runtime.state?.current_balance),
                    clearanceReserved: prepared.clearanceReserved === true
                        || prepared.mode === 'mutual',
                    withdrawalNullifier: prepared.withdrawalNullifier
                        || prepared.public_inputs?.withdrawal_nullifier
                        || null,
                    deploymentId: this.manifest.deployment_id,
                    chainId: Number(this.config.funding.chain_id),
                    contractAddress: this.config.funding.contract_address
                };
            }
            if (prepared.submissionId) {
                throw new BrowserWalletHttpError(
                    prepared.phase === 'ambiguous'
                        ? 'The previous wallet request has no transaction ID. Check its status before retrying.'
                        : 'This withdrawal is already awaiting MetaMask in this or another tab.',
                    409,
                    prepared.phase === 'ambiguous'
                        ? 'withdrawal_submission_ambiguous'
                        : 'withdrawal_wallet_pending'
                );
            }
            const now = Date.now();
            const submissionId = uuid();
            const next = {
                ...prepared,
                phase: 'awaiting_wallet',
                submissionOutcome: 'awaiting_wallet',
                submissionId,
                submissionOwner: this.ownerId,
                submissionStartedAt: now,
                submissionNonceJournalRequired: true
            };
            await this.commit({ ...this.runtime, preparedWithdrawal: next });
            return {
                status: 'claimed',
                submissionId,
                transactionHash: null,
                operationId: next.operationId,
                noteId: Number(next.noteId ?? next.public_inputs?.note_id),
                mode: next.mode,
                destination: next.destination,
                finalBalance: Number(next.public_inputs?.final_balance
                    ?? this.runtime.state?.current_balance),
                clearanceReserved: next.clearanceReserved === true
                    || next.mode === 'mutual',
                withdrawalNullifier: next.withdrawalNullifier
                    || next.public_inputs?.withdrawal_nullifier
                    || null,
                deploymentId: this.manifest.deployment_id,
                chainId: Number(this.config.funding.chain_id),
                contractAddress: this.config.funding.contract_address
            };
        });
    }

    async rememberPreparedWithdrawalSubmissionMetadata(submission, metadata) {
        const from = metadata?.from;
        const nonce = Number(metadata?.nonce);
        if (!/^0x[0-9a-fA-F]{40}$/.test(from || '')
            || !Number.isSafeInteger(nonce) || nonce < 0) {
            throw new Error('The withdrawal transaction metadata is invalid.');
        }
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            const prepared = this.runtime.preparedWithdrawal;
            const reference = submission && typeof submission === 'object' ? submission : null;
            const matches = prepared
                && reference?.operationId === prepared.operationId
                && reference?.submissionId === prepared.submissionId
                && Number(reference.noteId) === Number(
                    prepared.noteId ?? prepared.public_inputs?.note_id
                )
                && reference.mode === prepared.mode
                && String(reference.destination || '').toLowerCase()
                    === String(prepared.destination || '').toLowerCase()
                && reference.deploymentId === this.manifest.deployment_id
                && Number(reference.chainId) === Number(this.config.funding.chain_id)
                && String(reference.contractAddress || '').toLowerCase()
                    === String(this.config.funding.contract_address || '').toLowerCase();
            if (!matches) {
                throw new Error('The withdrawal wallet claim changed before its nonce was saved.');
            }
            const next = {
                ...prepared,
                submissionFrom: from.toLowerCase(),
                submissionNonce: nonce
            };
            await this.commit({ ...this.runtime, preparedWithdrawal: next });
            return next;
        });
    }

    async claimPreparedWithdrawalReplacement(expectedFrom) {
        await this.init();
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            const prepared = this.runtime.preparedWithdrawal;
            if (!prepared || prepared.phase !== 'dropped_or_pending') {
                throw new Error('Check the submitted withdrawal before replacing it.');
            }
            if (prepared.submissionId) {
                throw new Error('A replacement request is already open in MetaMask.');
            }
            const hashes = Array.isArray(prepared.transactionHashes)
                ? prepared.transactionHashes
                : prepared.transactionHash ? [prepared.transactionHash] : [];
            const hashSet = new Set(hashes.map(hash => String(hash).toLowerCase()));
            const identities = [...new Map((prepared.transactionAttempts || [])
                .filter(attempt => hashSet.has(String(attempt.hash || '').toLowerCase())
                    && /^0x[0-9a-fA-F]{40}$/.test(attempt.from || '')
                    && Number.isSafeInteger(Number(attempt.nonce))
                    && Number(attempt.nonce) >= 0)
                .map(attempt => {
                    const identity = {
                        from: attempt.from.toLowerCase(),
                        nonce: Number(attempt.nonce)
                    };
                    return [`${identity.from}:${identity.nonce}`, identity];
                })).values()];
            if (identities.length !== 1) {
                throw new Error(identities.length
                    ? 'The saved withdrawal has more than one wallet nonce. Use MetaMask to cancel or speed up the pending transactions, then check again.'
                    : 'The saved withdrawal has no replacement nonce. Use MetaMask to cancel or speed up the pending transaction, then check again.');
            }
            const [{ from, nonce }] = identities;
            if (!/^0x[0-9a-fA-F]{40}$/.test(expectedFrom || '')
                || from !== expectedFrom.toLowerCase()) {
                throw new Error(`Connect the MetaMask account ${from} that submitted this withdrawal.`);
            }
            const submissionId = uuid();
            const next = {
                ...prepared,
                phase: 'awaiting_wallet',
                submissionOutcome: 'replacement_awaiting_wallet',
                submissionId,
                submissionOwner: this.ownerId,
                submissionStartedAt: Date.now(),
                submissionFrom: from,
                submissionNonce: nonce,
                submissionNonceJournalRequired: true,
                replacementOf: [...hashSet]
            };
            await this.commit({ ...this.runtime, preparedWithdrawal: next });
            return {
                status: 'claimed',
                submissionId,
                transactionHash: null,
                operationId: next.operationId,
                noteId: Number(next.noteId ?? next.public_inputs?.note_id),
                mode: next.mode,
                destination: next.destination,
                finalBalance: Number(next.public_inputs?.final_balance
                    ?? this.runtime.state?.current_balance),
                clearanceReserved: next.clearanceReserved === true
                    || next.mode === 'mutual',
                withdrawalNullifier: next.withdrawalNullifier
                    || next.public_inputs?.withdrawal_nullifier
                    || null,
                deploymentId: this.manifest.deployment_id,
                chainId: Number(this.config.funding.chain_id),
                contractAddress: this.config.funding.contract_address,
                replacementFrom: from,
                replacementNonce: nonce,
                plan: structuredClone(next)
            };
        });
    }

    async rememberPreparedWithdrawalTransaction(
        transactionHash,
        submission = null,
        transactionMetadata = null
    ) {
        if (!/^0x[0-9a-fA-F]{64}$/.test(transactionHash || '')) {
            throw new Error('MetaMask returned an invalid withdrawal transaction hash.');
        }
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            const prepared = this.runtime.preparedWithdrawal;
            const reference = submission && typeof submission === 'object' ? submission : null;
            if (!reference?.operationId || !reference.submissionId
                || reference.deploymentId !== this.manifest.deployment_id
                || Number(reference.chainId) !== Number(this.config.funding.chain_id)
                || String(reference.contractAddress || '').toLowerCase()
                    !== String(this.config.funding.contract_address || '').toLowerCase()) {
                throw new Error('The withdrawal transaction is missing its durable operation identity.');
            }
            const sameOperation = prepared && (
                prepared.operationId === reference.operationId
                    && Number(prepared.noteId ?? prepared.public_inputs?.note_id) === Number(reference.noteId)
                    && prepared.mode === reference.mode
                    && prepared.destination?.toLowerCase() === reference.destination?.toLowerCase()
            );
            if (!sameOperation) {
                const attempts = Array.isArray(this.runtime.lateWithdrawalAttempts)
                    ? this.runtime.lateWithdrawalAttempts
                    : [];
                const lateAttempt = {
                    operationId: reference.operationId || null,
                    submissionId: reference.submissionId || null,
                    noteId: Number(reference.noteId),
                    mode: reference.mode || null,
                    destination: reference.destination || null,
                    finalBalance: Number(reference.finalBalance),
                    clearanceReserved: reference.clearanceReserved === true
                        || reference.mode === 'mutual',
                    withdrawalNullifier: reference.withdrawalNullifier || null,
                    deploymentId: reference.deploymentId,
                    chainId: Number(reference.chainId),
                    contractAddress: reference.contractAddress,
                    transactionHash: transactionHash.toLowerCase(),
                    from: /^0x[0-9a-fA-F]{40}$/.test(
                        transactionMetadata?.from || prepared?.submissionFrom || ''
                    )
                        ? (transactionMetadata?.from || prepared?.submissionFrom).toLowerCase()
                        : null,
                    nonce: Number.isSafeInteger(Number(
                        transactionMetadata?.nonce ?? prepared?.submissionNonce
                    ))
                        ? Number(transactionMetadata?.nonce ?? prepared?.submissionNonce)
                        : null,
                    observedAt: Date.now(),
                    status: 'submitted_late'
                };
                const deduplicated = attempts.filter(attempt => !(
                    attempt.operationId === lateAttempt.operationId
                    && attempt.transactionHash === lateAttempt.transactionHash
                ));
                await this.commit({
                    ...this.runtime,
                    lateWithdrawalAttempts: retainAttemptHistory(
                        [...deduplicated, lateAttempt],
                        LATE_WITHDRAWAL_TERMINAL_STATUSES
                    )
                });
                return { late: true, ...lateAttempt };
            }
            // A wallet prompt can outlive its cross-tab ownership claim. Never
            // reject a late valid hash: retaining every broadcast is the only
            // safe way to reconcile a takeover without losing an on-chain tx.
            const transactionHashes = [...new Set([
                ...(Array.isArray(prepared.transactionHashes)
                    ? prepared.transactionHashes
                    : prepared.transactionHash ? [prepared.transactionHash] : []),
                transactionHash
            ].map(value => value.toLowerCase()))];
            const transactionAttempts = [
                ...(Array.isArray(prepared.transactionAttempts)
                    ? prepared.transactionAttempts.filter(attempt => attempt.hash !== transactionHash.toLowerCase())
                    : []),
                {
                    hash: transactionHash.toLowerCase(),
                    submissionId: reference.submissionId || null,
                    operationId: prepared.operationId,
                    from: /^0x[0-9a-fA-F]{40}$/.test(
                        transactionMetadata?.from || prepared.submissionFrom || ''
                    )
                        ? (transactionMetadata?.from || prepared.submissionFrom).toLowerCase()
                        : null,
                    nonce: Number.isSafeInteger(Number(
                        transactionMetadata?.nonce ?? prepared.submissionNonce
                    ))
                        ? Number(transactionMetadata?.nonce ?? prepared.submissionNonce)
                        : null,
                    observedAt: Date.now()
                }
            ];
            const next = {
                ...prepared,
                phase: 'submitted',
                transactionHash: transactionHashes[0],
                transactionHashes,
                transactionAttempts,
                submissionOutcome: 'submitted',
                ...(reference.submissionId && prepared.submissionId !== reference.submissionId
                    ? { concurrentSubmissionObserved: true }
                    : {})
            };
            if (reference.submissionId && prepared.submissionId === reference.submissionId) {
                delete next.submissionId;
                delete next.submissionOwner;
                delete next.submissionStartedAt;
                delete next.submissionFrom;
                delete next.submissionNonce;
                delete next.submissionNonceJournalRequired;
            }
            await this.commit({ ...this.runtime, preparedWithdrawal: next });
            return next;
        });
    }

    async currentLateWithdrawalAttempts() {
        await this.init();
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            return (this.runtime.lateWithdrawalAttempts || []).map(attempt => ({ ...attempt }));
        });
    }

    async updateLateWithdrawalAttempt(operationId, transactionHash, changes = {}, {
        expectedStatus = null
    } = {}) {
        await this.init();
        const normalizedHash = String(transactionHash || '').toLowerCase();
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            const attempts = Array.isArray(this.runtime.lateWithdrawalAttempts)
                ? this.runtime.lateWithdrawalAttempts
                : [];
            const index = attempts.findIndex(attempt =>
                attempt.operationId === operationId
                && String(attempt.transactionHash || '').toLowerCase() === normalizedHash);
            if (index < 0) return null;
            const current = attempts[index];
            if (expectedStatus != null && current.status !== expectedStatus) {
                throw new Error('The late withdrawal attempt changed while its receipt was being checked.');
            }
            if (LATE_WITHDRAWAL_TERMINAL_STATUSES.has(current.status)
                && changes.status && changes.status !== current.status) {
                return { ...current };
            }
            const nextAttempt = {
                ...current,
                ...changes,
                updatedAt: Date.now()
            };
            const nextAttempts = [...attempts];
            nextAttempts[index] = nextAttempt;
            await this.commit({
                ...this.runtime,
                lateWithdrawalAttempts: retainAttemptHistory(
                    nextAttempts,
                    LATE_WITHDRAWAL_TERMINAL_STATUSES
                )
            });
            return { ...nextAttempt };
        });
    }

    async transferLateWithdrawalAttempt(attempt, record) {
        await this.init();
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            const detachesSelectedNote = this.runtime.deploymentId === attempt.deploymentId
                && this.runtime.state
                && Number(this.runtime.state.note_id) === Number(attempt.noteId);
            const result = await transferBrowserLateWithdrawalAttempt({
                operationId: attempt.operationId,
                transactionHash: attempt.transactionHash,
                deploymentId: attempt.deploymentId,
                chainId: Number(attempt.chainId),
                contractAddress: attempt.contractAddress,
                noteId: Number(attempt.noteId)
            }, record);
            this.runtime = result.runtime;
            this.withdrawals = await listBrowserWithdrawals(this.manifest.deployment_id);
            if (detachesSelectedNote) this.activeLease = null;
            this.notify();
            return result;
        });
    }

    async releaseBackgroundWithdrawalStartSubmission(submission, options = {}) {
        await this.init();
        const recordId = this.withdrawalRecordId(submission?.noteId);
        let result = await releaseBrowserWithdrawalStartSubmission(
            recordId,
            submission,
            options
        );
        // Test adapters and older embedders may provide a runtime persistence
        // layer without the shared IndexedDB stores. The production path above
        // atomically checks both owners; this fallback preserves that adapter
        // contract without creating a gap between production ownership checks.
        if (!result) {
            await this.reload();
            const prepared = this.runtime.preparedWithdrawal;
            if (prepared?.submissionId === submission?.submissionId
                && prepared.operationId === submission?.operationId) {
                const released = options.replacementUnknown
                    ? await this.releasePreparedWithdrawalReplacementClaim(
                        submission,
                        options.message || null
                    )
                    : await this.markPreparedWithdrawalRetryable(null, submission);
                result = released ? { location: 'selected', runtime: this.runtime } : null;
            }
        }
        await this.reload();
        this.notify();
        return result;
    }

    async resolveLateChallengedWithdrawalAttempt(attempt) {
        await this.init();
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            const attempts = Array.isArray(this.runtime.lateWithdrawalAttempts)
                ? this.runtime.lateWithdrawalAttempts
                : [];
            const index = attempts.findIndex(entry =>
                entry.operationId === attempt.operationId
                && String(entry.transactionHash || '').toLowerCase()
                    === String(attempt.transactionHash || '').toLowerCase()
                && Number(entry.noteId) === Number(attempt.noteId));
            if (index < 0) throw new Error('The challenged withdrawal attempt is no longer available.');
            const currentAttempt = attempts[index];
            if (LATE_WITHDRAWAL_TERMINAL_STATUSES.has(currentAttempt.status)) {
                return { ...currentAttempt };
            }
            const selectedOwns = Number(this.runtime.state?.note_id) === Number(attempt.noteId);
            const backgroundOwns = this.withdrawals.some(record =>
                Number(record.noteId) === Number(attempt.noteId) && record.state);
            if (!selectedOwns && !backgroundOwns) {
                throw new Error('The challenged withdrawal has no recoverable private note.');
            }
            const clearanceReserved = currentAttempt.clearanceReserved === true
                || currentAttempt.mode === 'mutual';
            const preparedWithdrawal = selectedOwns && clearanceReserved
                ? this.runtime.preparedWithdrawal || {
                    phase: 'prepared',
                    mode: currentAttempt.mode === 'mutual' ? 'mutual' : 'escape',
                    operationId: currentAttempt.operationId,
                    noteId: Number(currentAttempt.noteId),
                    destination: currentAttempt.destination,
                    withdrawalNullifier: currentAttempt.withdrawalNullifier || null,
                    clearanceReserved: true,
                    submissionOutcome: 'challenged',
                    createdAt: Number(currentAttempt.observedAt || Date.now())
                }
                : this.runtime.preparedWithdrawal;
            const nextAttempt = {
                ...currentAttempt,
                status: 'challenged',
                resolvedAt: Date.now(),
                error: null
            };
            const nextAttempts = attempts.map((entry, entryIndex) => {
                if (entryIndex === index) return nextAttempt;
                return Number(entry.noteId) === Number(currentAttempt.noteId)
                    && entry.deploymentId === currentAttempt.deploymentId
                    && !LATE_WITHDRAWAL_TERMINAL_STATUSES.has(entry.status)
                    ? {
                        ...entry,
                        status: 'superseded',
                        supersededBy: currentAttempt.transactionHash,
                        resolvedAt: Date.now(),
                        error: null
                    }
                    : entry;
            });
            await this.commit({
                ...this.runtime,
                preparedWithdrawal,
                lateWithdrawalAttempts: retainAttemptHistory(
                    nextAttempts,
                    LATE_WITHDRAWAL_TERMINAL_STATUSES
                )
            });
            return { ...nextAttempt };
        });
    }

    async markPreparedWithdrawalRetryable(expectedTransactionHash = null, submission = null) {
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            const prepared = this.runtime.preparedWithdrawal;
            if (!prepared) return null;
            const reference = submission && typeof submission === 'object' ? submission : null;
            if (!expectedTransactionHash && (!reference?.operationId || !reference.submissionId)) {
                throw new Error('The withdrawal retry is missing its durable operation identity.');
            }
            if (reference?.operationId && prepared.operationId !== reference.operationId) {
                throw new Error('The withdrawal operation changed while MetaMask was open.');
            }
            const hashes = Array.isArray(prepared.transactionHashes)
                ? prepared.transactionHashes
                : prepared.transactionHash ? [prepared.transactionHash] : [];
            if (expectedTransactionHash
                && !hashes.some(hash => hash.toLowerCase() === expectedTransactionHash.toLowerCase())) {
                throw new Error('The withdrawal transaction changed while its receipt was being checked.');
            }
            if (!expectedTransactionHash && reference.submissionId
                && prepared.submissionId !== reference.submissionId) {
                throw new Error('The withdrawal submission changed while MetaMask was open.');
            }
            const remainingHashes = expectedTransactionHash
                ? hashes.filter(hash => hash.toLowerCase() !== expectedTransactionHash.toLowerCase())
                : hashes;
            const remainingAttempts = Array.isArray(prepared.transactionAttempts)
                ? prepared.transactionAttempts.filter(attempt => !expectedTransactionHash
                    || attempt.hash.toLowerCase() !== expectedTransactionHash.toLowerCase())
                : [];
            const releasesClaim = !expectedTransactionHash
                && reference?.submissionId
                && prepared.submissionId === reference.submissionId;
            const survivingClaimPhase = prepared.submissionId && !releasesClaim
                ? (prepared.submissionOutcome === 'ambiguous' || prepared.phase === 'ambiguous'
                    ? 'ambiguous'
                    : 'awaiting_wallet')
                : 'prepared';
            const next = {
                ...prepared,
                phase: remainingHashes.length
                    ? 'submitted'
                    : survivingClaimPhase,
                transactionHashes: remainingHashes,
                transactionAttempts: remainingAttempts,
                submissionOutcome: remainingHashes.length
                    ? 'submitted'
                    : releasesClaim
                        ? 'explicitly_rejected'
                        : prepared.submissionId
                            ? prepared.submissionOutcome
                            : expectedTransactionHash ? 'reverted' : prepared.submissionOutcome
            };
            if (remainingHashes.length) {
                next.transactionHash = remainingHashes[0];
            } else {
                delete next.transactionHash;
                delete next.transactionHashes;
            }
            if (releasesClaim) {
                delete next.submissionId;
                delete next.submissionOwner;
                delete next.submissionStartedAt;
                delete next.submissionFrom;
                delete next.submissionNonce;
                delete next.submissionNonceJournalRequired;
            }
            await this.commit({ ...this.runtime, preparedWithdrawal: next });
            return next;
        });
    }

    async markPreparedWithdrawalMissingReceipts(expectedTransactionHashes) {
        await this.init();
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            const prepared = this.runtime.preparedWithdrawal;
            if (!prepared) return null;
            const normalize = values => [...values]
                .map(value => String(value).toLowerCase())
                .sort();
            const hashes = Array.isArray(prepared.transactionHashes)
                ? prepared.transactionHashes
                : prepared.transactionHash ? [prepared.transactionHash] : [];
            if (JSON.stringify(normalize(hashes))
                !== JSON.stringify(normalize(expectedTransactionHashes || []))) {
                throw new Error('The withdrawal transactions changed while their receipts were checked.');
            }
            // A second tab may already be replacing this transaction. Preserve
            // that live claim rather than regressing its UI/state phase.
            if (prepared.submissionId) return prepared;
            const next = {
                ...prepared,
                phase: 'dropped_or_pending',
                submissionOutcome: 'receipt_missing',
                missingReceiptCheckedAt: Date.now()
            };
            await this.commit({ ...this.runtime, preparedWithdrawal: next });
            return next;
        });
    }

    async markPreparedWithdrawalAmbiguous(submission, message = null) {
        await this.init();
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            const prepared = this.runtime.preparedWithdrawal;
            const reference = submission && typeof submission === 'object' ? submission : null;
            if (!prepared || !reference?.submissionId || !reference.operationId
                || prepared.submissionId !== reference.submissionId
                || prepared.operationId !== reference.operationId) {
                throw new Error('The withdrawal operation changed before its ambiguous result could be saved.');
            }
            const next = {
                ...prepared,
                phase: 'ambiguous',
                submissionOutcome: 'ambiguous',
                submissionError: message || 'MetaMask did not return a transaction ID.',
                ambiguousAt: Date.now()
            };
            await this.commit({ ...this.runtime, preparedWithdrawal: next });
            return next;
        });
    }

    async releasePreparedWithdrawalReplacementClaim(submission, message = null) {
        await this.init();
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            const prepared = this.runtime.preparedWithdrawal;
            if (!prepared || prepared.submissionId !== submission?.submissionId
                || prepared.operationId !== submission?.operationId
                || !Number.isSafeInteger(Number(submission?.replacementNonce))) {
                throw new Error('The replacement wallet request changed before it could be released.');
            }
            const history = Array.isArray(prepared.ambiguousReplacements)
                ? prepared.ambiguousReplacements
                : [];
            const next = {
                ...prepared,
                phase: 'dropped_or_pending',
                submissionOutcome: 'replacement_result_unknown',
                ambiguousReplacements: [...history, {
                    submissionId: prepared.submissionId,
                    nonce: Number(submission.replacementNonce),
                    startedAt: prepared.submissionStartedAt,
                    releasedAt: Date.now(),
                    message: message || 'The wallet did not return a replacement transaction ID.'
                }].slice(-8),
                missingReceiptCheckedAt: Date.now()
            };
            delete next.submissionId;
            delete next.submissionOwner;
            delete next.submissionStartedAt;
            delete next.submissionFrom;
            delete next.submissionNonce;
            delete next.submissionNonceJournalRequired;
            delete next.submissionError;
            await this.commit({ ...this.runtime, preparedWithdrawal: next });
            return next;
        });
    }

    async authorizePreparedWithdrawalRetry() {
        await this.init();
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            const prepared = this.runtime.preparedWithdrawal;
            if (!prepared || prepared.phase !== 'ambiguous' || !prepared.submissionId) {
                throw new Error('There is no ambiguous wallet request to retry.');
            }
            const hashes = Array.isArray(prepared.transactionHashes)
                ? prepared.transactionHashes
                : prepared.transactionHash ? [prepared.transactionHash] : [];
            if (hashes.length) throw new Error('Check the submitted transaction before retrying.');
            const history = Array.isArray(prepared.ambiguousSubmissions)
                ? prepared.ambiguousSubmissions
                : [];
            const next = {
                ...prepared,
                phase: 'prepared',
                submissionOutcome: 'retry_authorized',
                ambiguousSubmissions: [...history, {
                    submissionId: prepared.submissionId,
                    startedAt: prepared.submissionStartedAt,
                    authorizedAt: Date.now()
                }].slice(-8)
            };
            delete next.submissionId;
            delete next.submissionOwner;
            delete next.submissionStartedAt;
            delete next.submissionFrom;
            delete next.submissionNonce;
            delete next.submissionNonceJournalRequired;
            delete next.submissionError;
            await this.commit({ ...this.runtime, preparedWithdrawal: next });
            return next;
        });
    }

    async clearPreparedWithdrawal({
        force = false,
        expectedNoteId = null,
        expectedTransactionHashes = null
    } = {}) {
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            const prepared = this.runtime.preparedWithdrawal;
            if (!prepared) return null;
            if (expectedNoteId != null
                && Number(prepared.noteId ?? prepared.public_inputs?.note_id) !== Number(expectedNoteId)) {
                throw new Error('The selected withdrawal changed before it could be cleared.');
            }
            const hashes = Array.isArray(prepared.transactionHashes)
                ? prepared.transactionHashes
                : prepared.transactionHash ? [prepared.transactionHash] : [];
            if (expectedTransactionHashes) {
                const normalize = values => [...values].map(value => value.toLowerCase()).sort();
                if (JSON.stringify(normalize(hashes))
                    !== JSON.stringify(normalize(expectedTransactionHashes))) {
                    throw new Error('The withdrawal transactions changed before recovery completed.');
                }
            }
            if (!force && (prepared.mode === 'mutual' || prepared.clearanceReserved === true)) {
                throw new Error('This balance already has a mutual-close authorization and must remain withdrawal-only.');
            }
            // Even force recovery must preserve a hashless MetaMask claim: its
            // delayed callback still needs a durable owner in this exact note.
            if (prepared.submissionId) {
                throw new Error('A MetaMask withdrawal request is still unresolved. Close or finish that prompt before clearing this balance.');
            }
            if (!force && hashes.length) {
                throw new Error('This withdrawal may already be in MetaMask. Check its transaction status before canceling it.');
            }
            await this.commit({ ...this.runtime, preparedWithdrawal: null });
            return null;
        });
    }

    async recoverPreparedWithdrawalSubmissionClaim() {
        await this.init();
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            const prepared = this.runtime.preparedWithdrawal;
            if (!prepared?.submissionId) return prepared || null;
            const hashes = Array.isArray(prepared.transactionHashes)
                ? prepared.transactionHashes
                : prepared.transactionHash ? [prepared.transactionHash] : [];
            if (hashes.length) return prepared;
            // A reload cannot prove whether another tab still has MetaMask
            // open. Preserve the claim until the provider returns a definite
            // rejection or the user explicitly starts recovery.
            return prepared;
        });
    }

    async markPreparedWithdrawalUnknown(message = null) {
        await this.init();
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            const prepared = this.runtime.preparedWithdrawal;
            if (!prepared?.submissionId) {
                throw new Error('There is no wallet request waiting to be recovered.');
            }
            if (prepared.phase === 'ambiguous') return prepared;
            const next = {
                ...prepared,
                phase: 'ambiguous',
                submissionOutcome: 'ambiguous',
                submissionError: message || 'The wallet prompt was closed before a transaction ID was saved.',
                ambiguousAt: Date.now()
            };
            await this.commit({ ...this.runtime, preparedWithdrawal: next });
            return next;
        });
    }

    async resolveChallengedPreparedEscape(noteId, expectedTransactionHashes = []) {
        await this.init();
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            const prepared = this.runtime.preparedWithdrawal;
            if (!prepared || prepared.mode !== 'escape' || prepared.clearanceReserved !== true
                || Number(prepared.noteId ?? prepared.public_inputs?.note_id) !== Number(noteId)) {
                throw new Error('The challenged escape no longer matches the selected balance.');
            }
            if (prepared.submissionId) {
                throw new Error('A wallet request is still unresolved for this balance.');
            }
            const normalize = values => [...values].map(value => value.toLowerCase()).sort();
            const hashes = Array.isArray(prepared.transactionHashes)
                ? prepared.transactionHashes
                : prepared.transactionHash ? [prepared.transactionHash] : [];
            if (JSON.stringify(normalize(hashes)) !== JSON.stringify(normalize(expectedTransactionHashes))) {
                throw new Error('The withdrawal transactions changed while the challenge was being checked.');
            }
            const next = {
                phase: 'prepared',
                mode: 'escape',
                operationId: prepared.operationId,
                noteId: Number(noteId),
                destination: prepared.destination,
                withdrawalNullifier: prepared.withdrawalNullifier
                    || prepared.public_inputs?.withdrawal_nullifier
                    || null,
                clearanceReserved: true,
                submissionOutcome: 'challenged',
                createdAt: Number(prepared.createdAt || Date.now())
            };
            await this.commit({ ...this.runtime, preparedWithdrawal: next });
            return next;
        });
    }

    withdrawalRecordId(noteId) {
        return [
            this.manifest.deployment_id,
            Number(this.config?.funding?.chain_id),
            String(this.config?.funding?.contract_address || '').toLowerCase(),
            Number(noteId)
        ].join(':');
    }

    async detachEscapeWithdrawal(details) {
        await this.init();
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            const noteId = Number(details.noteId);
            const phase = details.phase === 'challenged_unconfirmed'
                ? 'challenged_unconfirmed'
                : 'pending';
            const result = await detachBrowserEscapeWithdrawal({
                recordId: this.withdrawalRecordId(noteId),
                deploymentId: this.manifest.deployment_id,
                chainId: Number(this.config.funding.chain_id),
                contractAddress: this.config.funding.contract_address,
                mode: 'escape',
                phase,
                chainStatus: details.chainStatus
                    || (phase === 'challenged_unconfirmed' ? 'active' : 'pending_withdrawal'),
                noteId,
                destination: details.destination,
                finalBalance: Number(details.finalBalance),
                challengeDeadline: Number(details.challengeDeadline),
                transactionHash: details.transactionHash || null,
                startBlockNumber: Number(details.startBlockNumber || 0),
                challengeObservedBlock: Number(details.challengeObservedBlock || 0),
                lastObservedBlock: Number(details.lastObservedBlock || 0),
                createdAt: Number(details.createdAt || Date.now())
            });
            this.runtime = result.runtime;
            this.withdrawals = await listBrowserWithdrawals(this.manifest.deployment_id);
            this.activeLease = null;
            this.notify();
            return result.withdrawal;
        });
    }

    async detachClosedWithdrawal(details) {
        await this.init();
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            const noteId = Number(details.noteId);
            const result = await detachBrowserClosedWithdrawal({
                recordId: this.withdrawalRecordId(noteId),
                deploymentId: this.manifest.deployment_id,
                chainId: Number(this.config.funding.chain_id),
                contractAddress: this.config.funding.contract_address,
                mode: details.mode,
                noteId,
                destination: details.destination,
                finalBalance: Number(details.finalBalance),
                transactionHash: details.transactionHash || null,
                closeBlockNumber: Number(details.closeBlockNumber || 0),
                lastObservedBlock: Number(details.lastObservedBlock || 0),
                clearanceReserved: details.clearanceReserved === true,
                createdAt: Number(details.createdAt || Date.now()),
                closedAt: Date.now()
            });
            this.runtime = result.runtime;
            this.withdrawals = await listBrowserWithdrawals(this.manifest.deployment_id);
            this.activeLease = null;
            this.notify();
            return result.withdrawal;
        });
    }

    backgroundWithdrawalIdentity(record) {
        return { recordId: record?.recordId, deploymentId: this.manifest.deployment_id,
            chainId: Number(this.config.funding.chain_id), contractAddress: this.config.funding.contract_address,
            noteId: Number(record?.noteId), mode: record?.mode, destination: record?.destination };
    }

    async repairUnsubmittedBackgroundWithdrawal(recordId, observedBlock, expectedRevision) {
        await this.init();
        await this.reload();
        const record = this.withdrawals.find(entry => entry.recordId === recordId);
        if (!record) return null;
        const result = await repairBrowserUnsubmittedBackgroundWithdrawal(
            this.backgroundWithdrawalIdentity(record), Number(observedBlock), expectedRevision);
        await this.reload();
        if (result && Number(result.revision) !== Number(expectedRevision)) this.notify();
        return result;
    }

    async resolveBackgroundWithdrawalForRetry(recordId, evidence) {
        await this.init();
        await this.reload();
        const record = this.withdrawals.find(entry => entry.recordId === recordId);
        const result = await resolveBrowserBackgroundWithdrawalForRetry(
            this.backgroundWithdrawalIdentity(record), evidence);
        await this.reload();
        this.notify();
        return result;
    }

    async prepareBackgroundWithdrawal(recordId, { expectedActiveRoot } = {}) {
        await this.init();
        await this.reload();
        const record = structuredClone(this.withdrawals.find(entry => entry.recordId === recordId));
        const identity = this.backgroundWithdrawalIdentity(record);
        assertBrowserBackgroundWithdrawalAvailable(record, this.runtime, identity);
        if (expectedActiveRoot == null) throw new Error('A current vault root is required to prepare this withdrawal.');
        const state = record.state;
        const config = this.config;
        if (Number(state.chain_id) !== identity.chainId || !sameFelt(state.contract_address, identity.contractAddress)) {
            throw new Error('The saved private state belongs to a different vault.');
        }
        const nullifier = await this.worker.call('withdrawalNullifier', { state });
        const savedNullifiers = [record.withdrawalNullifier, record.preparedWithdrawal?.withdrawalNullifier,
            record.preparedWithdrawal?.public_inputs?.withdrawal_nullifier].filter(value => value != null);
        if (savedNullifiers.some(value => !sameFelt(value, nullifier))) {
            throw new Error('The saved withdrawal authorization does not match its private balance.');
        }
        // Deliberately outside the global wallet lock: a proof or indexer wait
        // must not stall unrelated deposits, requests, or settlement in another tab.
        const path = await this.treePath(identity.noteId, true, expectedActiveRoot);
        const clearance = await this.remoteJson(`${config.funding.protocol_server_url}/v2/withdraw/clearance`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ withdrawal_nullifier: nullifier })
        });
        const plan = await this.worker.call('prepareWithdrawal', {
            config: config.wallet_core, state,
            args: { mode: 'mutual', destination: identity.destination, active_root: path.active_root,
                merkle_siblings: path.siblings, clearance }, provingKey: config.proving_keys.withdrawal
        });
        const inputs = plan.public_inputs;
        const encodedDestination = Array.isArray(inputs?.destination)
            ? `0x${inputs.destination.map(value => Number(value).toString(16).padStart(2, '0')).join('')}`
            : inputs?.destination;
        if (!plan.proof || Number(inputs?.note_id) !== identity.noteId
            || Number(inputs?.chain_id) !== identity.chainId
            || !sameFelt(inputs?.contract_address, identity.contractAddress)
            || !sameFelt(inputs?.active_root, expectedActiveRoot)
            || !sameFelt(inputs?.withdrawal_nullifier, nullifier)
            || !sameFelt(inputs?.final_balance, state.current_balance)
            || String(encodedDestination || '').toLowerCase() !== identity.destination.toLowerCase()
            || inputs?.has_clearance !== true) {
            throw new Error('The generated withdrawal proof does not match its saved balance and vault.');
        }
        Object.assign(plan, { destination: identity.destination, mode: 'mutual', phase: 'prepared',
            operationId: uuid(), noteId: identity.noteId, withdrawalNullifier: nullifier,
            clearanceReserved: true, createdAt: Number(record.createdAt || Date.now()) });
        await saveBrowserBackgroundWithdrawalPlan(identity, record, plan);
        await this.reload();
        this.notify();
        return plan;
    }

    async claimBackgroundWithdrawalSubmission(recordId, expectedOperationId) {
        await this.init();
        await this.reload();
        const record = this.withdrawals.find(entry => entry.recordId === recordId);
        const result = await claimBrowserBackgroundWithdrawalSubmission(
            this.backgroundWithdrawalIdentity(record), expectedOperationId, this.ownerId);
        await this.reload();
        this.notify();
        return result;
    }

    async rememberBackgroundWithdrawalSubmissionMetadata(submission, metadata) {
        const result = await rememberBrowserBackgroundWithdrawalMetadata(submission, metadata);
        await this.reload();
        this.notify();
        return result;
    }

    async markBackgroundWithdrawalAmbiguous(submission, message) {
        const result = await markBrowserBackgroundWithdrawalAmbiguous(submission, message);
        await this.reload();
        this.notify();
        return result;
    }

    async releaseBackgroundWithdrawalSubmission(submission) {
        const result = await releaseBrowserBackgroundWithdrawalSubmission(submission);
        await this.reload();
        this.notify();
        return result;
    }

    async cancelBackgroundWithdrawalPreparation(recordId) {
        await this.init();
        await this.reload();
        const record = this.withdrawals.find(entry => entry.recordId === recordId);
        if (!record) throw new Error('This saved withdrawal is no longer available.');
        const submission = { ...this.backgroundWithdrawalIdentity(record),
            submissionId: record.startSubmissionId, operationId: record.startOperationId };
        const result = await releaseBrowserBackgroundWithdrawalSubmission(submission, { requireNoNonce: true });
        await this.reload();
        this.notify();
        return result;
    }

    async rememberBackgroundWithdrawalTransaction(hash, submission, metadata = null) {
        const result = await rememberBrowserBackgroundWithdrawalTransaction(hash, submission, metadata);
        await this.reload();
        this.notify();
        return result;
    }

    async parkPreparedWithdrawal() {
        await this.init();
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            const prepared = this.runtime.preparedWithdrawal;
            const noteId = Number(this.runtime.state?.note_id);
            if (!prepared || (prepared.mode !== 'mutual' && prepared.clearanceReserved !== true)
                || !Number.isFinite(noteId)) {
                throw new Error('There is no withdrawal-only balance to set aside.');
            }
            const hashes = Array.isArray(prepared.transactionHashes)
                ? prepared.transactionHashes
                : prepared.transactionHash ? [prepared.transactionHash] : [];
            if (!['reserving', 'prepared'].includes(prepared.phase || 'prepared')
                || prepared.submissionId || hashes.length) {
                throw new Error('Check the submitted withdrawal before setting this balance aside.');
            }
            const result = await parkBrowserWithdrawal({
                recordId: this.withdrawalRecordId(noteId),
                deploymentId: this.manifest.deployment_id,
                chainId: Number(this.config.funding.chain_id),
                contractAddress: this.config.funding.contract_address,
                mode: prepared.mode,
                phase: 'parked',
                noteId,
                destination: prepared.destination,
                finalBalance: Number(prepared.public_inputs?.final_balance
                    ?? this.runtime.state.current_balance),
                createdAt: Number(prepared.createdAt || Date.now())
            });
            this.runtime = result.runtime;
            this.withdrawals = await listBrowserWithdrawals(this.manifest.deployment_id);
            this.activeLease = null;
            this.notify();
            return result.withdrawal;
        });
    }

    async updateWithdrawal(recordId, changes = {}, options = {}) {
        await this.init();
        const updated = await updateBrowserWithdrawal(recordId, changes, options);
        await this.reload();
        this.notify();
        return updated;
    }

    async currentPreparedWithdrawal() {
        await this.init();
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            return this.runtime.preparedWithdrawal
                ? structuredClone(this.runtime.preparedWithdrawal)
                : null;
        });
    }

    async currentWithdrawal(recordId) {
        await this.init();
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            const record = this.withdrawals.find(entry => entry.recordId === recordId);
            return record ? structuredClone(record) : null;
        });
    }

    async claimBackgroundWithdrawalStartReplacement(recordId, expectedFrom) {
        await this.init();
        const result = await claimBrowserWithdrawalStartReplacement(
            recordId,
            this.ownerId,
            expectedFrom
        );
        await this.reload();
        this.notify();
        return result;
    }

    async claimWithdrawalFinalization(recordId) {
        await this.init();
        const result = await claimBrowserWithdrawalFinalization(
            recordId,
            this.ownerId
        );
        await this.reload();
        this.notify();
        return result;
    }

    async claimWithdrawalFinalizationReplacement(recordId, expectedFrom) {
        await this.init();
        const result = await claimBrowserWithdrawalFinalizationReplacement(
            recordId,
            this.ownerId,
            expectedFrom
        );
        await this.reload();
        this.notify();
        return result;
    }

    async rememberWithdrawalFinalization(
        recordId,
        transactionHash,
        submission = null,
        transactionMetadata = null
    ) {
        await this.init();
        const result = await rememberBrowserWithdrawalFinalization(
            recordId,
            transactionHash,
            submission,
            transactionMetadata
        );
        await this.reload();
        this.notify();
        return result;
    }

    async rememberWithdrawalFinalizationSubmissionMetadata(
        recordId,
        submission,
        transactionMetadata
    ) {
        await this.init();
        const result = await rememberBrowserWithdrawalFinalizationSubmissionMetadata(
            recordId,
            submission,
            transactionMetadata
        );
        await this.reload();
        this.notify();
        return result;
    }

    async releaseWithdrawalFinalization(recordId, options = {}) {
        await this.init();
        const result = await releaseBrowserWithdrawalFinalization(recordId, options);
        await this.reload();
        this.notify();
        return result;
    }

    async markWithdrawalFinalizationMissingReceipts(recordId, expectedTransactionHashes) {
        await this.init();
        const result = await markBrowserWithdrawalFinalizationMissingReceipts(
            recordId,
            expectedTransactionHashes
        );
        await this.reload();
        this.notify();
        return result;
    }

    async releaseWithdrawalFinalizationReplacementClaim(
        recordId,
        submission,
        message = null
    ) {
        await this.init();
        const result = await releaseBrowserWithdrawalFinalizationReplacementClaim(
            recordId,
            submission,
            message
        );
        await this.reload();
        this.notify();
        return result;
    }

    async markWithdrawalFinalizationAmbiguous(recordId, submission, message = null) {
        await this.init();
        const result = await markBrowserWithdrawalFinalizationAmbiguous(
            recordId,
            submission,
            message
        );
        await this.reload();
        this.notify();
        return result;
    }

    async markWithdrawalFinalizationUnknown(recordId) {
        await this.init();
        await this.reload();
        const record = this.withdrawals.find(entry => entry.recordId === recordId);
        if (!record?.finalizeSubmissionId || !record.finalizeOperationId) {
            throw new Error('There is no finalization wallet request waiting to be recovered.');
        }
        if (record.phase === 'ambiguous') return record;
        return this.markWithdrawalFinalizationAmbiguous(recordId, {
            recordId,
            submissionId: record.finalizeSubmissionId,
            operationId: record.finalizeOperationId,
            generation: Number(record.finalizeGeneration || 0),
            deploymentId: record.deploymentId,
            chainId: Number(record.chainId),
            contractAddress: record.contractAddress,
            noteId: Number(record.noteId),
            destination: record.destination
        }, 'The wallet prompt was closed before a transaction ID was saved.');
    }

    async resolveChallengedWithdrawalFinalization(recordId, {
        expectedRevision = null,
        observedBlock = null
    } = {}) {
        await this.init();
        await this.reload();
        const record = this.withdrawals.find(entry => entry.recordId === recordId);
        if (!record?.finalizeSubmissionId || !record.finalizeOperationId) {
            throw new Error('There is no challenged wallet prompt to release.');
        }
        const result = await resolveBrowserChallengedFinalization(recordId, {
            recordId,
            submissionId: record.finalizeSubmissionId,
            operationId: record.finalizeOperationId,
            generation: Number(record.finalizeGeneration || 0),
            deploymentId: record.deploymentId,
            chainId: Number(record.chainId),
            contractAddress: record.contractAddress,
            noteId: Number(record.noteId),
            destination: record.destination
        }, { expectedRevision, observedBlock });
        await this.reload();
        this.notify();
        return result;
    }

    async authorizeWithdrawalFinalizationRetry(recordId) {
        await this.init();
        const result = await authorizeBrowserWithdrawalFinalizationRetry(recordId);
        await this.reload();
        this.notify();
        return result;
    }

    async restoreWithdrawal(recordId, {
        expectedRevision = null,
        observedBlock = null
    } = {}) {
        await this.init();
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            const record = this.withdrawals.find(entry => entry.recordId === recordId);
            if (!record) throw new Error('The recoverable private balance is no longer available.');
            if (expectedRevision == null || Number(record.revision) !== Number(expectedRevision)) {
                throw new Error('The withdrawal changed after its on-chain status was checked. Check it again before selecting this balance.');
            }
            const chainFloor = Math.max(
                Number(record.startBlockNumber || 0),
                Number(record.lastObservedBlock || 0)
            );
            if (observedBlock == null || Number(observedBlock) < chainFloor) {
                throw new Error('The connected RPC has not caught up to this withdrawal. Check it again before selecting this balance.');
            }
            const runtime = await restoreBrowserWithdrawal(recordId, {
                deploymentId: this.manifest.deployment_id,
                chainId: Number(this.config.funding.chain_id),
                contractAddress: this.config.funding.contract_address
            }, expectedRevision);
            this.runtime = runtime;
            this.withdrawals = await listBrowserWithdrawals(this.manifest.deployment_id);
            this.notify();
            return this.walletStatus();
        });
    }

    async archiveNote(reason = 'closed', expectedNoteId = null) {
        await this.init();
        if (expectedNoteId == null) {
            throw new Error('Archiving a private note requires its exact note identity.');
        }
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            const noteId = expectedNoteId ?? this.runtime.state?.note_id;
            this.runtime = await archiveBrowserWallet(reason, noteId);
            this.withdrawals = await listBrowserWithdrawals(this.manifest.deployment_id);
            this.activeLease = null;
            this.notify();
            return this.walletStatus();
        });
    }
}

const browserWalletRuntime = new BrowserWalletRuntime();
export { BrowserWalletHttpError, BrowserWalletRuntime };
export default browserWalletRuntime;
