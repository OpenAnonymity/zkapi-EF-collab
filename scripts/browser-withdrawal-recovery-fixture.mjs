/**
 * Pre-bootstrap, localhost-only payment boundary simulation for the REAL built
 * OA/zkAPI app. No runtime, client, store or UI method is replaced. Install in
 * an isolated browser profile, through browser-withdrawal-recovery-server.mjs.
 * This is recovery/UX evidence, never proof verification or on-chain evidence.
 */
export function installWithdrawalRecoveryFixture(browserConfig) {
    if (!['localhost', '127.0.0.1'].includes(location.hostname)) {
        throw new Error('Withdrawal fixture is restricted to localhost.');
    }
    if (globalThis.ethereum) throw new Error('Refusing to replace a real wallet provider. Use an isolated browser without MetaMask.');
    const STORE_KEY = 'zkapi-withdrawal-fixture-chain-v1';
    const trusted = browserConfig.trusted_deployment;
    const account = `0x${'22'.repeat(20)}`;
    const word = value => BigInt(value).toString(16).padStart(64, '0');
    const quantity = value => `0x${BigInt(value).toString(16)}`;
    const freshChain = () => ({ root: '0x11', block: 1000, finalized: 1000, nonce: 4,
        nextNoteId: 8, notes: { 7: 1 }, receipts: {}, transactions: {}, outcomes: ['reject'],
        workerCalls: [], walletCalls: [], blockedRequests: [], clearances: [] });
    const chain = JSON.parse(localStorage.getItem(STORE_KEY) || 'null') || freshChain();
    chain.blockedRequests = chain.blockedRequests.filter(entry => entry.origin !== 'null');
    const save = () => localStorage.setItem(STORE_KEY, JSON.stringify(chain));
    const note = (id, balance = 1_900_000) => ({ note_id: id, secret: `fixture-only-note-${id}`,
        chain_id: Number(trusted.chain_id), contract_address: trusted.contract_address,
        deposit_amount: balance, current_balance: balance, expiry_ts: Math.floor(Date.now() / 1000) + 86400,
        state_seq: 0, fixtureOnly: true });
    const manifest = { ...trusted, protocol_version: 2, proof_backend: 'groth16_bn254',
        provider: 'metered', auth_scheme: 'state-anchor', policy_enabled: false,
        note_ttl_seconds: 86400, demo_mint_enabled: false,
        proof_setup: { request_proving_key_sha256: trusted.request_proving_key_sha256,
            withdrawal_proving_key_sha256: trusted.withdrawal_proving_key_sha256 },
        models: [{ id: 'openai/gpt-5.6-sol', owned_by: 'openai' }],
        privacy_mode: { ephemeral_key_source: 'oa_org', lease_ttl_seconds: 300,
            openrouter_inference_base: trusted.openrouter_inference_base, verifier_url: trusted.verifier_url } };
    let database;
    const open = () => new Promise((resolve, reject) => {
        const request = indexedDB.open('zkapi-browser-wallet-v1', 2);
        request.onupgradeneeded = () => {
            for (const [name, options] of [['runtime', undefined], ['archives', { keyPath: 'archiveId' }], ['withdrawals', { keyPath: 'recordId' }]]) {
                if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, options);
            }
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => { database = request.result; database.onversionchange = () => database.close(); resolve(database); };
    });
    const snapshot = () => new Promise((resolve, reject) => {
        const tx = database.transaction(['runtime', 'withdrawals'], 'readonly');
        const a = tx.objectStore('runtime').get('active');
        const b = tx.objectStore('withdrawals').getAll();
        tx.oncomplete = () => resolve({ runtime: a.result, withdrawals: b.result });
        tx.onerror = tx.onabort = () => reject(tx.error);
    });
    const seed = async () => {
        await open();
        const existing = await snapshot();
        if ((existing.runtime?.state && !existing.runtime.state.fixtureOnly)
            || (existing.runtime?.pendingDeposit && !String(existing.runtime.pendingDeposit.secret).startsWith('fixture-only-'))
            || existing.withdrawals.some(record => record.state && !record.state.fixtureOnly)) {
            throw new Error('This origin contains a non-fixture wallet. Refusing to modify it.');
        }
        if (localStorage.getItem(`${STORE_KEY}:seeded`)) {
            // Permit a fixture saved by an earlier harness revision to gain
            // newly validated public identity fields; never touch real notes.
            const withIdentity = state => state?.fixtureOnly ? {
                ...state, chain_id: Number(trusted.chain_id), contract_address: trusted.contract_address
            } : state;
            await new Promise((resolve, reject) => {
                const tx = database.transaction(['runtime', 'withdrawals'], 'readwrite');
                if (existing.runtime) tx.objectStore('runtime').put({ ...existing.runtime, state: withIdentity(existing.runtime.state) }, 'active');
                for (const record of existing.withdrawals) tx.objectStore('withdrawals').put({ ...record, state: withIdentity(record.state) });
                tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error);
            });
            return;
        }
        if (existing.runtime?.state || existing.withdrawals.length) throw new Error('Refusing to overwrite existing wallet state.');
        await new Promise((resolve, reject) => {
            const tx = database.transaction('runtime', 'readwrite');
            tx.objectStore('runtime').put({ version: 1, deploymentId: trusted.deployment_id, fixtureOnly: true,
                state: note(7), journal: null, lease: null, pendingDeposit: null, preparedWithdrawal: null,
                lateWithdrawalAttempts: [], lateDepositAttempts: [], updatedAt: Date.now() }, 'active');
            tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error);
        });
        localStorage.setItem(`${STORE_KEY}:seeded`, 'yes'); save();
    };
    const seeded = seed();
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    const nativeFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (input, init = {}) => {
        await seeded;
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
        // Self-contained libcurl WASM data URLs are local runtime assets.
        if (url.protocol === 'data:' || url.protocol === 'blob:') return nativeFetch(input, init);
        const path = url.pathname.replace(/^\/zkapi-deployment/, '');
        if (url.href === browserConfig.deployment_manifest_url
            || (url.origin === location.origin && path === '/config.json')) return json(manifest);
        if (path === '/v1/tree/snapshot') return json({ root: chain.root, active_root: chain.root, next_note_id: chain.nextNoteId, leaves: [] });
        if (path === '/v1/tree/root') return json({ root: chain.root });
        if (path === '/v1/tree/next-note-id') return json({ next_note_id: chain.nextNoteId });
        if (path === '/health' || path === '/v1/attestation') return json({ ...manifest, status: 'ok', current_root: chain.root });
        if (path === '/v2/withdraw/clearance') {
            chain.clearances.push(JSON.parse(init.body)); save(); return json({ signature: 'fixture-only-clearance' });
        }
        if (/^\/v2\/openrouter\/leases\//.test(path)) return json({ status: 'active' });
        if (path === '/zkapi-model-catalog' || url.href === `${trusted.openrouter_inference_base}/models`) {
            return json({ data: [{ id: 'openai/gpt-5.6-sol', name: 'OpenAI: GPT-5.6 Sol', context_length: 1_050_000,
                pricing: { prompt: '0.000002', completion: '0.00001' }, top_provider: { max_completion_tokens: 128000 } }] });
        }
        if (url.origin === location.origin && !/^\/zkapi-deployment\//.test(url.pathname)) return nativeFetch(input, init);
        chain.blockedRequests.push({ method: init.method || 'GET', origin: url.origin, path: url.pathname.slice(0, 180) }); save();
        throw new Error(`Fixture blocked unexpected external request: ${url.origin}${url.pathname.slice(0, 180)}`);
    };
    const RealWorker = globalThis.Worker;
    globalThis.Worker = class FixtureWorker extends EventTarget {
        constructor(url, options) {
            super();
            if (!new URL(url, location.href).pathname.endsWith('/zkapiWasmWorker.js')) return new RealWorker(url, options);
        }
        postMessage({ id, operation, payload = {} }) {
            Promise.resolve().then(async () => {
                await seeded;
                chain.workerCalls.push({ operation, noteId: payload.state?.note_id ?? payload.noteId }); save();
                let result;
                if (operation === 'walletStatus') result = { has_note: Boolean(payload.state), note: payload.state || null, pending_request: payload.journal || null };
                else if (operation === 'preloadRequestProver') result = { status: 'ready' };
                else if (operation === 'treePath') result = { active_root: chain.root, note_id: Number(payload.noteId), siblings: Array(32).fill('0x0') };
                else if (operation === 'generateDeposit') result = { secret: 'fixture-only-generated-note', registration_commitment: '0x42' };
                else if (operation === 'confirmDeposit') result = note(Number(payload.args.note_id), Number(payload.args.amount));
                else if (operation === 'withdrawalNullifier') result = quantity(7000 + Number(payload.state.note_id));
                else if (operation === 'prepareWithdrawal') {
                    const p = payload.config, args = payload.args, source = payload.state;
                    result = { mode: args.mode, siblings: Array(32).fill('0x0'),
                        proof: { backend: 'groth16_bn254', proof: btoa(String.fromCharCode(...new Uint8Array(256))) },
                        public_inputs: { protocol_version: 2, chain_id: p.chain_id, contract_address: p.contract_address,
                            active_root: args.active_root, state_signing_key_x: p.state_signing_key.x,
                            state_signing_key_y: p.state_signing_key.y, clearance_signing_key_x: p.clearance_signing_key.x,
                            clearance_signing_key_y: p.clearance_signing_key.y, note_id: source.note_id,
                            final_balance: source.current_balance, destination: args.destination.slice(2).match(/../g).map(x => parseInt(x, 16)),
                            withdrawal_nullifier: quantity(7000 + Number(source.note_id)), has_clearance: args.mode === 'mutual', withdrawal_tag: '0x17' } };
                } else throw new Error(`Unexpected expensive-worker operation: ${operation}`);
                this.dispatchEvent(new MessageEvent('message', { data: { id, result } }));
            }).catch(error => this.dispatchEvent(new MessageEvent('message', { data: { id, error: error.message } })));
        }
        terminate() {}
    };
    const decodeWords = data => data.slice(10).match(/.{64}/g) || [];
    const mine = transaction => {
        const codec = globalThis.zkapiWallet, selector = transaction.data.slice(2, 10), words = decodeWords(transaction.data);
        if (![codec.ABI.deposit, codec.ABI.approve, codec.ABI.mutualClose, codec.ABI.initiateEscapeWithdrawal].includes(selector)) {
            throw new Error(`Fixture refused unsupported transaction selector: ${selector}`);
        }
        const hash = `0x${word(++chain.nonce)}`; chain.block += 1; chain.finalized = chain.block;
        let logs = [];
        if (selector === codec.ABI.deposit) {
            const id = chain.nextNoteId++; chain.notes[id] = 1;
            logs = [{ address: trusted.contract_address, topics: [codec.ABI.noteDeposited, `0x${word(id)}`, `0x${words[0]}`],
                data: `0x${words[1]}${word(Math.floor(Date.now() / 1000) + 86400)}${word(chain.root)}` }];
        } else if (selector === codec.ABI.mutualClose || selector === codec.ABI.initiateEscapeWithdrawal) {
            const id = Number(BigInt(`0x${words[8]}`)), escape = selector === codec.ABI.initiateEscapeWithdrawal;
            chain.notes[id] = escape ? 2 : 3;
            logs = [{ address: trusted.contract_address, topics: [escape ? codec.ABI.escapeInitiatedEvent : codec.ABI.mutualCloseEvent, `0x${word(id)}`],
                data: `0x${word(chain.root)}${words[9]}${words[10]}${escape ? word(Math.floor(Date.now() / 1000) + 86400) + word(101) : ''}` }];
        }
        chain.transactions[hash] = { ...transaction, hash, nonce: transaction.nonce || quantity(chain.nonce - 1) };
        chain.receipts[hash] = { transactionHash: hash, status: '0x1', blockNumber: quantity(chain.block), blockHash: `0x${word(chain.block)}`, logs };
        save(); return hash;
    };
    globalThis.ethereum = {
        isFixture: true, on() {}, removeListener() {},
        async request({ method, params = [] }) {
            await seeded; chain.walletCalls.push({ method, selector: params[0]?.data?.slice(0, 10) }); save();
            if (fixture.holdPreflightMethod === method) {
                fixture.holdPreflightMethod = null;
                await new Promise(resolve => { fixture.pendingPreflight = { method, resolve }; });
            }
            if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [account];
            if (method === 'eth_chainId') return quantity(trusted.chain_id);
            if (method === 'wallet_switchEthereumChain' || method === 'wallet_watchAsset') return true;
            if (method === 'eth_blockNumber') return quantity(chain.block);
            if (method === 'eth_getBlockByNumber') return { number: quantity(params[0] === 'finalized' ? chain.finalized : chain.block), hash: `0x${word(chain.block)}` };
            if (method === 'eth_estimateGas') return '0x100000';
            if (method === 'eth_getTransactionCount') return quantity(chain.nonce);
            if (method === 'eth_getTransactionReceipt') return chain.receipts[params[0]] || null;
            if (method === 'eth_getTransactionByHash') return chain.transactions[params[0]] || null;
            if (method === 'eth_call') {
                const selector = params[0].data.slice(2, 10), words = decodeWords(params[0].data);
                if (selector === 'fdab463d') return quantity(chain.root);
                if (selector === '7a2043a3') return quantity(chain.nextNoteId);
                if (['f3f480d9', 'c3a079ed'].includes(selector)) return quantity(86400);
                if (selector === '9f18e4ed') return `0x${word(42)}${word(5_000_000)}${word(Math.floor(Date.now() / 1000) + 86400)}${word(chain.notes[Number(BigInt(`0x${words[0]}`))] || 0)}`;
                if (['70a08231', 'dd62ed3e'].includes(selector)) return quantity(100_000_000);
                throw new Error(`Unexpected fixture eth_call selector: ${selector}`);
            }
            if (method === 'eth_sendTransaction') {
                const outcome = chain.outcomes.shift() || 'success'; save();
                if (outcome === 'reject') throw Object.assign(new Error('Fixture user rejected the MetaMask request.'), { code: 4001 });
                if (outcome === 'hold') return new Promise((resolve, reject) => { fixture.pendingWallet = { transaction: params[0], resolve, reject }; });
                return mine(params[0]);
            }
            throw new Error(`Fixture blocked unsupported wallet method: ${method}`);
        }
    };
    const notifyWallet = () => {
        const channel = new BroadcastChannel('zkapi-wallet:active-runtime');
        channel.postMessage({ updatedAt: Date.now() }); channel.close();
    };
    const fixture = globalThis.withdrawalRecoveryFixture = {
        ready: seeded, chain, pendingWallet: null, pendingPreflight: null, holdPreflightMethod: null,
        snapshot: async () => { await seeded; return snapshot(); },
        holdPreflight(method = 'eth_getTransactionCount') {
            if (!['eth_getTransactionCount', 'eth_estimateGas'].includes(method)) {
                throw new Error('Only a read-only transaction preflight can be held.');
            }
            fixture.holdPreflightMethod = method;
        },
        resolvePreflight() {
            const pending = fixture.pendingPreflight;
            if (!pending) throw new Error('No held fixture transaction preflight.');
            fixture.pendingPreflight = null; pending.resolve();
        },
        setOutcomes(...outcomes) { chain.outcomes = outcomes; save(); },
        resolveWallet(outcome = 'success') {
            const pending = fixture.pendingWallet; if (!pending) throw new Error('No held fixture wallet prompt.');
            fixture.pendingWallet = null;
            if (outcome === 'reject') pending.reject(Object.assign(new Error('Fixture user rejected the request.'), { code: 4001 }));
            else pending.resolve(mine(pending.transaction));
        },
        async addNewNote({ activeLease = true } = {}) {
            await seeded; const before = await snapshot();
            if (before.runtime?.state || before.runtime?.pendingDeposit) throw new Error('Park the original note before adding fixture funds.');
            const next = { ...before.runtime, fixtureOnly: true, state: note(8, 5_000_000), updatedAt: Date.now() };
            if (activeLease) {
                const future = Math.floor(Date.now() / 1000) + 3600;
                next.lease = { sessionId: 'fixture-new-chat', client_request_id: 'fixture-new-chat-request', ownerId: 'fixture-other-live-tab', expires_at: future, settle_after: future, fixtureOnly: true };
                next.journal = { nullifier: '0x8000', prepared_request: { client_request_id: 'fixture-new-chat-request' }, fixtureOnly: true };
            }
            await new Promise((resolve, reject) => { const tx = database.transaction('runtime', 'readwrite'); tx.objectStore('runtime').put(next, 'active'); tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error); });
            chain.notes[8] = 1; chain.nextNoteId = 9; save(); notifyWallet(); return next;
        },
        async reconcile() { await seeded; return globalThis.zkapiClient.reconcileBrowserWalletInBackground(); },
        async assertNewNoteUnchanged(expected) {
            const current = (await snapshot()).runtime;
            for (const field of ['state', 'journal', 'lease', 'pendingDeposit', 'preparedWithdrawal']) {
                if (JSON.stringify(current[field]) !== JSON.stringify(expected[field])) throw new Error(`Historical withdrawal changed selected ${field}.`);
            }
            return true;
        }
    };
    // A CSP supplied by the harness also blocks non-local connections. This
    // wrapper never delegates wallet operations or protocol fetches outward.
    save();
}
