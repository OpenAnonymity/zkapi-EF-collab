import networkProxy from './networkProxy.js';
import { sameFelt, waitForExpectedActiveRoot } from './zkapiWithdrawalRoot.mjs';
import { selectLeaseSpendingLimitCredits } from './zkapiRequestCompat.mjs';
import {
    archiveBrowserWallet,
    createWalletChannel,
    readBrowserWallet,
    requestPersistentStorage,
    withBrowserWalletLock,
    writeBrowserWallet
} from './browserWalletStore.js';

const DEFAULT_BROWSER_CONFIG_URL = new URL('../browser-config.json', import.meta.url).href;
const LEASE_AUTHORIZATION = JSON.stringify({ mode: 'openrouter_ephemeral_lease', version: 1 });
const MAX_RECOVERY_WAIT_MS = 45_000;
const TAB_OWNER_STORAGE_KEY = 'zkapi-browser-tab-owner-v1';

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
        this.activeLease = null;
        this.initialized = false;
        this.initPromise = null;
        this.leasePromise = null;
        this.leasePromiseSession = null;
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
        this.runtime = await readBrowserWallet();
        if (this.runtime.deploymentId && this.runtime.deploymentId !== this.manifest.deployment_id
            && (this.runtime.state || this.runtime.journal)) {
            throw new Error(`This browser contains a wallet for ${this.runtime.deploymentId}. Switch back to that deployment before using or withdrawing it.`);
        }
        if (!this.runtime.deploymentId) {
            this.runtime = await writeBrowserWallet({
                ...this.runtime,
                deploymentId: this.manifest.deployment_id
            });
        }
        this.channel = createWalletChannel(this.manifest.deployment_id, () => {
            void this.reload().then(() => this.dispatchEvent(new Event('change')));
        });
        await requestPersistentStorage();
        await this.recoverPending({ retireLostKey: true, quiet: true });
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
        const config = this.config ? {
            ...this.config,
            active_lease: active,
            prepared_withdrawal: prepared ? {
                mode: prepared.mode,
                note_id: prepared.public_inputs?.note_id,
                destination: Array.isArray(prepared.public_inputs?.destination)
                    ? `0x${prepared.public_inputs.destination.map(byte => Number(byte).toString(16).padStart(2, '0')).join('')}`
                    : prepared.destination
            } : null
        } : null;
        return { config, runtime: this.runtime, activeLease: active };
    }

    async reload() {
        this.runtime = await readBrowserWallet();
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
        return this.worker.call('walletStatus', {
            state: this.runtime.state,
            journal: this.runtime.journal
        });
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
        const payload = await responsePayload(response);
        if (!response.ok) {
            const details = payload?.error || {};
            throw new BrowserWalletHttpError(
                details.error_message || details.message || payload.message || `HTTP ${response.status}`,
                response.status,
                details.error_code || details.code || payload.code,
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

    async prepareDeposit(amount) {
        await this.init();
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            if (this.runtime.state) throw new Error('This browser already has an active private note.');
            if (this.runtime.pendingDeposit) {
                if (Number(this.runtime.pendingDeposit.amount) !== Number(amount)) {
                    if (this.runtime.pendingDeposit.transactionHash) {
                        throw new Error('A different deposit transaction is already pending in MetaMask. Finish it before changing the amount.');
                    }
                    // A plan without a transaction hash never reached the
                    // chain. It is safe to discard after an approval or mint
                    // cancellation and create a new note for the edited amount.
                    await this.commit({ ...this.runtime, pendingDeposit: null });
                    await this.reload();
                } else {
                    return this.runtime.pendingDeposit;
                }
            }
            const params = await this.worker.call('generateDeposit');
            const snapshot = await this.remoteJson(`${this.config.funding.indexer_url}/v1/tree/snapshot`);
            const path = await this.worker.call('treePath', {
                snapshot,
                noteId: Number(snapshot.next_note_id),
                requireExisting: false
            });
            const plan = {
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
    }

    async pendingDeposit() {
        await this.init();
        await this.reload();
        return this.runtime.pendingDeposit ? { ...this.runtime.pendingDeposit } : null;
    }

    async rememberPendingDepositTransaction(transactionHash) {
        await this.init();
        if (transactionHash !== null && !/^0x[0-9a-fA-F]{64}$/.test(transactionHash || '')) {
            throw new Error('MetaMask returned an invalid deposit transaction hash.');
        }
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            if (!this.runtime.pendingDeposit) {
                throw new Error('The durable pending deposit is missing.');
            }
            const existing = this.runtime.pendingDeposit.transactionHash;
            if (transactionHash && existing && existing.toLowerCase() !== transactionHash.toLowerCase()) {
                throw new Error('A different deposit transaction is already pending for this private note.');
            }
            const pendingDeposit = { ...this.runtime.pendingDeposit };
            if (transactionHash) pendingDeposit.transactionHash = transactionHash;
            else delete pendingDeposit.transactionHash;
            await this.commit({ ...this.runtime, pendingDeposit });
            return { ...pendingDeposit };
        });
    }

    async confirmDeposit(args) {
        await this.init();
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            if (this.runtime.state) throw new Error('This browser already has an active private note.');
            if (this.runtime.pendingDeposit?.secret !== args.secret) {
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
        if (this.runtime.journal) return this.runtime.journal.prepared_request;
        if (!this.runtime.state) throw new Error('Fund a private balance before starting a chat.');
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

    async verifyLease(lease, expectedLimitCredits, onProgress = () => {}, signal = null) {
        throwIfAborted(signal);
        if (!lease.api_key || Number(lease.expires_at) <= Math.floor(Date.now() / 1000)) {
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

    async issueLease(sessionId, onProgress = () => {}, signal = null) {
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            throwIfAborted(signal);
            await this.reload();
            throwIfAborted(signal);
            onProgress('checking', 'Checking for unfinished private activity…');
            await this.recoverPending({ retireLostKey: true, onProgress, signal });
            const request = await this.prepareLeaseRequest(onProgress, signal);
            let lease;
            try {
                onProgress('requesting', 'Creating a temporary key for this chat…');
                lease = await this.remoteJson(`${this.config.funding.protocol_server_url}/v2/openrouter/leases`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    signal,
                    body: JSON.stringify(request)
                });
            } catch (error) {
                if (error.code === 'stale_root') {
                    await this.commit({ ...this.runtime, journal: null });
                }
                throw error;
            }
            await this.verifyLease(lease, request.public_inputs.solvency_bound, onProgress, signal);
            throwIfAborted(signal);
            this.activeLease = {
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
            this.scheduleSettlement();
            this.dispatchEvent(new Event('change'));
            onProgress('ready', 'Private chat ready.');
            return this.activeLease;
        });
    }

    async ensureLease(sessionId, onProgress = () => {}, signal = null) {
        throwIfAborted(signal);
        await this.init();
        throwIfAborted(signal);
        const normalized = String(sessionId || 'default').slice(0, 160);
        const now = Math.floor(Date.now() / 1000);
        if (this.activeLease && this.activeLease.expires_at > now) {
            if (this.activeLease.sessionId !== normalized) {
                throw new BrowserWalletHttpError(
                    `Chat ${this.activeLease.sessionId} owns the current private key until it settles.`,
                    409,
                    'lease_session_conflict'
                );
            }
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
        if (this.runtime.lease && Number(this.runtime.lease.expires_at) > now
            && this.runtime.lease.ownerId !== this.ownerId) {
            throw new BrowserWalletHttpError(
                `Another OA Chat tab owns the current private key until ${new Date(Number(this.runtime.lease.expires_at) * 1000).toLocaleTimeString()}.`,
                409,
                'lease_tab_conflict'
            );
        }
        if (this.leasePromise) {
            if (this.leasePromiseSession !== normalized) {
                throw new BrowserWalletHttpError(
                    `Chat ${this.leasePromiseSession} is creating the current private key.`,
                    409,
                    'lease_session_conflict'
                );
            }
            return this.leasePromise;
        }
        this.leasePromiseSession = normalized;
        this.leasePromise = (async () => {
            if (this.activeLease) await this.retireActiveLease(onProgress);
            return this.issueLease(normalized, onProgress, signal);
        })();
        try {
            const lease = await this.leasePromise;
            throwIfAborted(signal);
            return lease;
        } finally {
            this.leasePromise = null;
            this.leasePromiseSession = null;
        }
    }

    scheduleSettlement() {
        if (!this.activeLease) return;
        const delayMs = Math.max(0, Number(this.activeLease.settle_after) * 1000 - Date.now() + 250);
        setTimeout(() => void this.retireActiveLease().catch(() => {}), Math.min(delayMs, 2_147_000_000));
    }

    async retireRequest(clientRequestId, request, signal) {
        const deadline = Date.now() + MAX_RECOVERY_WAIT_MS;
        while (true) {
            try {
                return await this.remoteJson(`${this.config.funding.protocol_server_url}/v2/openrouter/leases/${encodeURIComponent(clientRequestId)}`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(request),
                    signal
                });
            } catch (error) {
                if ((!error.data?.error?.retriable && !error.data?.retriable) || Date.now() + 1_000 >= deadline) throw error;
                await delay(1_000, signal);
            }
        }
    }

    async retireActiveLease(onProgress = () => {}) {
        if (!this.activeLease || !this.runtime?.journal) return;
        const lease = this.activeLease;
        onProgress('settling', 'Closing the temporary key from the previous chat…');
        await withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            const request = this.runtime.journal?.prepared_request;
            if (!request || request.client_request_id !== lease.client_request_id) return;
            onProgress('usage', 'Confirming the previous chat’s usage…');
            const status = await this.retireRequest(lease.client_request_id, request);
            if (status.status !== 'finalized') throw new Error(`Lease is still ${status.status}.`);
            await this.installRecoveredResponse(lease.client_request_id, onProgress);
        });
        this.activeLease = null;
        this.dispatchEvent(new Event('change'));
    }

    async settleActiveLease(onProgress = () => {}) {
        await this.init();
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
        this.dispatchEvent(new Event('change'));
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

    async recoverPending({ retireLostKey = false, quiet = false, onProgress = () => {}, signal = null } = {}) {
        throwIfAborted(signal);
        if (!this.runtime?.journal || this.activeLease) return false;
        const request = this.runtime.journal.prepared_request;
        try {
            const status = await this.remoteJson(`${this.config.funding.protocol_server_url}/v2/openrouter/leases/${encodeURIComponent(request.client_request_id)}`, { signal });
            if (status.status === 'active' && retireLostKey) {
                if (this.runtime.lease && Number(this.runtime.lease.expires_at) > Math.floor(Date.now() / 1000)
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
            const existing = this.runtime.preparedWithdrawal;
            if (existing) {
                const existingDestination = existing.destination?.toLowerCase();
                if (!(existing.mode === 'mutual' && mode === 'escape' && existingDestination === destination.toLowerCase())) {
                    if (existing.mode !== mode || existingDestination !== destination.toLowerCase()) {
                        throw new Error('A different withdrawal is already prepared in this browser.');
                    }
                }
            }
            await this.recoverPending({ retireLostKey: true });
            const path = await this.treePath(this.runtime.state.note_id, true, expectedActiveRoot);
            // Withdrawal proofs are bound to the global active root. Reuse a
            // durable plan only while it still matches the canonical tree.
            if (existing?.mode === mode
                && existing.destination?.toLowerCase() === destination.toLowerCase()
                && sameFelt(existing.public_inputs?.active_root, path.active_root)) {
                return existing;
            }
            let clearance = null;
            if (mode === 'mutual') {
                const nullifier = await this.worker.call('withdrawalNullifier', { state: this.runtime.state });
                clearance = await this.remoteJson(`${this.config.funding.protocol_server_url}/v2/withdraw/clearance`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ withdrawal_nullifier: nullifier })
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
            await this.commit({ ...this.runtime, preparedWithdrawal: plan });
            return plan;
        });
    }

    async clearPreparedWithdrawal() {
        await this.commit({ ...this.runtime, preparedWithdrawal: null });
    }

    async archiveNote(reason = 'closed') {
        this.runtime = await archiveBrowserWallet(reason);
        this.activeLease = null;
        this.notify();
        return this.walletStatus();
    }
}

const browserWalletRuntime = new BrowserWalletRuntime();
export { BrowserWalletHttpError };
export default browserWalletRuntime;
