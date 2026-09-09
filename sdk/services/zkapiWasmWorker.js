import init, {
    BrowserRequestProver,
    browser_complete_response,
    browser_confirm_deposit,
    browser_generate_deposit,
    browser_prepare_withdrawal,
    browser_tree_path,
    browser_wallet_status,
    browser_withdrawal_nullifier
} from '../wasm/zkapi_browser.js';

let initialized = null;
const provingKeys = new Map();
const requestProvers = new Map();

function bytesToHex(bytes) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function ensureInitialized() {
    if (!initialized) {
        initialized = init(new URL('../wasm/zkapi_browser_bg.wasm', import.meta.url));
    }
    return initialized;
}

async function loadProvingKey(descriptor) {
    const cacheKey = `${descriptor.url}|${descriptor.sha256 || ''}`;
    if (provingKeys.has(cacheKey)) return provingKeys.get(cacheKey);
    const promise = (async () => {
        const response = await fetch(descriptor.url, { cache: 'force-cache', credentials: 'same-origin' });
        if (!response.ok) throw new Error(`Unable to load proving key (${response.status}).`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (descriptor.sha256) {
            const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
            if (bytesToHex(digest) !== descriptor.sha256.toLowerCase()) {
                throw new Error('The downloaded proving key failed its SHA-256 integrity check.');
            }
        }
        return bytes;
    })();
    provingKeys.set(cacheKey, promise);
    try {
        return await promise;
    } catch (error) {
        // Do not retain a rejected fetch or integrity-check promise. A later
        // preload/Send must be able to retry after a transient failure.
        if (provingKeys.get(cacheKey) === promise) provingKeys.delete(cacheKey);
        throw error;
    }
}

async function loadRequestProver(descriptor) {
    const cacheKey = `${descriptor.url}|${descriptor.sha256 || ''}`;
    if (requestProvers.has(cacheKey)) return requestProvers.get(cacheKey);
    const promise = (async () => {
        const bytes = await loadProvingKey(descriptor);
        try {
            return new BrowserRequestProver(bytes);
        } finally {
            // The decoded Rust object now owns the key material it needs.
            // Do not retain a second 5.65 MB JavaScript copy.
            provingKeys.delete(cacheKey);
        }
    })();
    requestProvers.set(cacheKey, promise);
    try {
        return await promise;
    } catch (error) {
        // A failed fetch or decode must not poison every later retry for the
        // lifetime of the worker.
        if (requestProvers.get(cacheKey) === promise) requestProvers.delete(cacheKey);
        throw error;
    }
}

function parse(result) {
    return JSON.parse(result);
}

async function execute(operation, payload) {
    await ensureInitialized();
    switch (operation) {
        case 'generateDeposit':
            return parse(browser_generate_deposit());
        case 'confirmDeposit':
            return parse(browser_confirm_deposit(JSON.stringify(payload.config), JSON.stringify(payload.args)));
        case 'walletStatus':
            return parse(browser_wallet_status(
                payload.state ? JSON.stringify(payload.state) : undefined,
                payload.journal ? JSON.stringify(payload.journal) : undefined
            ));
        case 'treePath':
            return parse(browser_tree_path(
                JSON.stringify(payload.snapshot),
                Number(payload.noteId),
                Boolean(payload.requireExisting)
            ));
        case 'preloadRequestProver':
            await loadRequestProver(payload.provingKey);
            return { status: 'ready' };
        case 'prepareRequest': {
            const prover = await loadRequestProver(payload.provingKey);
            return parse(prover.prepare_request(
                JSON.stringify(payload.config),
                JSON.stringify(payload.state),
                JSON.stringify(payload.args)
            ));
        }
        case 'completeResponse':
            return parse(browser_complete_response(
                JSON.stringify(payload.config),
                JSON.stringify(payload.args)
            ));
        case 'withdrawalNullifier':
            return parse(browser_withdrawal_nullifier(JSON.stringify(payload.state)));
        case 'prepareWithdrawal': {
            const key = await loadProvingKey(payload.provingKey);
            return parse(browser_prepare_withdrawal(
                JSON.stringify(payload.config),
                JSON.stringify(payload.state),
                JSON.stringify(payload.args),
                key
            ));
        }
        default:
            throw new Error(`Unknown zkAPI worker operation: ${operation}`);
    }
}

self.addEventListener('message', async (event) => {
    const { id, operation, payload } = event.data || {};
    try {
        self.postMessage({ id, result: await execute(operation, payload || {}) });
    } catch (error) {
        self.postMessage({
            id,
            error: error instanceof Error ? error.message : String(error)
        });
    }
});
