const DB_NAME = 'zkapi-browser-wallet-v1';
const DB_VERSION = 1;
const RUNTIME_STORE = 'runtime';
const ARCHIVE_STORE = 'archives';
const RUNTIME_KEY = 'active';

const EMPTY_RUNTIME = Object.freeze({
    version: 1,
    deploymentId: null,
    state: null,
    journal: null,
    pendingDeposit: null,
    preparedWithdrawal: null,
    lease: null,
    updatedAt: 0
});

let databasePromise = null;
let fallbackLock = Promise.resolve();

function requestResult(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
    });
}

function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted.'));
        transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed.'));
    });
}

function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const database = request.result;
            if (!database.objectStoreNames.contains(RUNTIME_STORE)) {
                database.createObjectStore(RUNTIME_STORE);
            }
            if (!database.objectStoreNames.contains(ARCHIVE_STORE)) {
                database.createObjectStore(ARCHIVE_STORE, { keyPath: 'archiveId' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('Unable to open the browser wallet database.'));
        request.onblocked = () => reject(new Error('A different tab is blocking the browser wallet upgrade.'));
    });
    return databasePromise;
}

function normalizeRuntime(value) {
    return {
        ...EMPTY_RUNTIME,
        ...(value || {}),
        version: 1
    };
}

function durableTransaction(database, stores) {
    try {
        return database.transaction(stores, 'readwrite', { durability: 'strict' });
    } catch {
        return database.transaction(stores, 'readwrite');
    }
}

export async function readBrowserWallet() {
    const database = await openDatabase();
    const transaction = database.transaction(RUNTIME_STORE, 'readonly');
    const value = await requestResult(transaction.objectStore(RUNTIME_STORE).get(RUNTIME_KEY));
    await transactionDone(transaction);
    return normalizeRuntime(value);
}

/**
 * Commit the entire private wallet snapshot in one IndexedDB write. The caller
 * must put a write-ahead journal here before transmitting a proved request and
 * clear it only in the same write that installs the verified next note state.
 */
export async function writeBrowserWallet(next) {
    const database = await openDatabase();
    const transaction = durableTransaction(database, RUNTIME_STORE);
    const value = normalizeRuntime({ ...next, updatedAt: Date.now() });
    transaction.objectStore(RUNTIME_STORE).put(value, RUNTIME_KEY);
    await transactionDone(transaction);
    return value;
}

export async function archiveBrowserWallet(reason = 'closed') {
    const database = await openDatabase();
    const transaction = durableTransaction(database, [RUNTIME_STORE, ARCHIVE_STORE]);
    const runtimeStore = transaction.objectStore(RUNTIME_STORE);
    const current = normalizeRuntime(await requestResult(runtimeStore.get(RUNTIME_KEY)));
    if (current.state) {
        transaction.objectStore(ARCHIVE_STORE).put({
            archiveId: `${current.deploymentId || 'deployment'}:${current.state.note_id}:${Date.now()}`,
            reason,
            archivedAt: Date.now(),
            state: current.state
        });
    }
    const next = normalizeRuntime({ deploymentId: current.deploymentId, updatedAt: Date.now() });
    runtimeStore.put(next, RUNTIME_KEY);
    await transactionDone(transaction);
    return next;
}

export async function requestPersistentStorage() {
    if (!navigator.storage?.persist) return false;
    try {
        if (await navigator.storage.persisted?.()) return true;
        return await navigator.storage.persist();
    } catch {
        return false;
    }
}

/** Serialize all wallet mutations across tabs. */
export async function withBrowserWalletLock(deploymentId, operation) {
    const lockName = `zkapi-wallet:${deploymentId || 'default'}`;
    if (navigator.locks?.request) {
        return navigator.locks.request(lockName, { mode: 'exclusive' }, operation);
    }
    const previous = fallbackLock;
    let release;
    fallbackLock = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
        return await operation();
    } finally {
        release();
    }
}

export function createWalletChannel(deploymentId, onChange) {
    if (typeof BroadcastChannel === 'undefined') return { postMessage() {}, close() {} };
    const channel = new BroadcastChannel(`zkapi-wallet:${deploymentId || 'default'}`);
    channel.addEventListener('message', (event) => onChange?.(event.data));
    return channel;
}
