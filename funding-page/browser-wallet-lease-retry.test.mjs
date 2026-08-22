import assert from 'node:assert/strict';
import test from 'node:test';

// The browser runtime's OA transport installs a diagnostic singleton on
// window at module load time. No DOM is needed for these focused runtime tests.
globalThis.window = { location: { hostname: 'localhost' } };

const {
    BrowserWalletHttpError,
    BrowserWalletRuntime
} = await import('./services/browserWalletRuntime.js');

function retryableError(message = 'internal error: OA returned 429 Too Many Requests') {
    return new BrowserWalletHttpError(message, 500, 'internal_error', {
        status: 'error',
        error_code: 'internal_error',
        error_message: message,
        retriable: true
    });
}

function runtimeForLeaseRequests() {
    const runtime = new BrowserWalletRuntime();
    runtime.config = {
        funding: { protocol_server_url: 'https://protocol.example' }
    };
    return runtime;
}

test('remoteJson preserves top-level zkAPI error details', async () => {
    const runtime = runtimeForLeaseRequests();
    runtime.remoteFetch = async () => new Response(JSON.stringify({
        status: 'error',
        error_code: 'internal_error',
        error_message: 'internal error: upstream returned 429 Too Many Requests',
        retriable: true
    }), {
        status: 500,
        headers: { 'content-type': 'application/json' }
    });

    await assert.rejects(
        runtime.remoteJson('https://protocol.example/v2/openrouter/leases'),
        error => {
            assert.equal(error.name, 'BrowserWalletHttpError');
            assert.equal(error.status, 500);
            assert.equal(error.code, 'internal_error');
            assert.equal(error.message, 'internal error: upstream returned 429 Too Many Requests');
            assert.equal(error.data.retriable, true);
            assert.equal(error.data.retry_after_seconds, undefined);
            return true;
        }
    );
});

test('remoteJson preserves Retry-After when the proxy body omits it', async () => {
    const runtime = runtimeForLeaseRequests();
    runtime.remoteFetch = async () => new Response(JSON.stringify({
        status: 'error',
        error_code: 'oa_minute_request_limit',
        error_message: 'OA is limiting new temporary keys.',
        retriable: true
    }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '17' }
    });

    await assert.rejects(
        runtime.remoteJson('https://protocol.example/v2/openrouter/leases'),
        error => {
            assert.equal(error.status, 429);
            assert.equal(error.code, 'oa_minute_request_limit');
            assert.equal(error.data.retry_after_seconds, 17);
            return true;
        }
    );
});

test('lease retries reuse the byte-identical prepared request and report rate-limit waits', async () => {
    const runtime = runtimeForLeaseRequests();
    const request = {
        client_request_id: 'fixed-idempotency-id',
        proof: { a: ['proof-created-once'] },
        public_inputs: { solvency_bound: 5_000_000 }
    };
    const attempts = [];
    const waits = [];
    const progress = [];
    let clock = 0;
    runtime.remoteJson = async (url, init) => {
        attempts.push({ url, ...init });
        if (attempts.length < 3) throw retryableError();
        return { status: 'active', client_request_id: request.client_request_id };
    };

    const lease = await runtime.requestLeaseWithRetry(
        request,
        (phase, message) => progress.push({ phase, message }),
        null,
        {
            maxWaitMs: 100,
            maxAttempts: 5,
            initialRetryMs: 10,
            maxRetryMs: 20,
            now: () => clock,
            sleep: async milliseconds => {
                waits.push(milliseconds);
                clock += milliseconds;
            }
        }
    );

    assert.equal(lease.client_request_id, request.client_request_id);
    assert.equal(attempts.length, 3);
    assert.deepEqual(waits, [10, 20]);
    assert.ok(attempts.every(attempt => attempt.url.endsWith('/v2/openrouter/leases')));
    assert.ok(attempts.every(attempt => attempt.body === attempts[0].body));
    assert.deepEqual(JSON.parse(attempts[0].body), request);
    assert.ok(progress.some(entry => entry.phase === 'waiting'
        && /OA is briefly limiting new temporary keys/.test(entry.message)));
    assert.equal(progress.at(-1).message, 'Retrying temporary key creation…');
});

test('lease issuance does not infer retryability from an HTTP 500 status', async () => {
    const runtime = runtimeForLeaseRequests();
    const error = new BrowserWalletHttpError('HTTP 500', 500, 'internal_error', {
        status: 'error',
        error_code: 'internal_error',
        error_message: 'HTTP 500',
        retriable: false
    });
    let attempts = 0;
    let sleeps = 0;
    runtime.remoteJson = async () => {
        attempts += 1;
        throw error;
    };

    await assert.rejects(
        runtime.requestLeaseWithRetry(
            { client_request_id: 'do-not-retry' },
            () => {},
            null,
            { sleep: async () => { sleeps += 1; } }
        ),
        candidate => candidate === error
    );
    assert.equal(attempts, 1);
    assert.equal(sleeps, 0);
});

test('lease retry backoff is bounded by its deadline', async () => {
    const runtime = runtimeForLeaseRequests();
    const error = retryableError('internal error: temporary OA failure');
    let attempts = 0;
    let clock = 0;
    const waits = [];
    runtime.remoteJson = async () => {
        attempts += 1;
        throw error;
    };

    await assert.rejects(
        runtime.requestLeaseWithRetry(
            { client_request_id: 'bounded-retry' },
            () => {},
            null,
            {
                maxWaitMs: 25,
                maxAttempts: 20,
                initialRetryMs: 10,
                maxRetryMs: 10,
                now: () => clock,
                sleep: async milliseconds => {
                    waits.push(milliseconds);
                    clock += milliseconds;
                }
            }
        ),
        candidate => candidate === error
    );
    assert.equal(attempts, 3);
    assert.deepEqual(waits, [10, 10]);
    assert.equal(clock, 20);
});

test('an hourly Retry-After beyond the wait budget fails immediately with saved-message guidance', async () => {
    const runtime = runtimeForLeaseRequests();
    const error = new BrowserWalletHttpError(
        'OA org key issuance was rate limited.',
        429,
        'oa_hourly_issuance_budget',
        {
            status: 'error',
            error_code: 'oa_hourly_issuance_budget',
            retriable: true,
            retry_after_seconds: 2_700
        }
    );
    let attempts = 0;
    let sleeps = 0;
    runtime.remoteJson = async () => {
        attempts += 1;
        throw error;
    };

    await assert.rejects(
        runtime.requestLeaseWithRetry(
            { client_request_id: 'hourly-capacity' },
            () => {},
            null,
            { maxWaitMs: 75_000, sleep: async () => { sleeps += 1; } }
        ),
        candidate => {
            assert.equal(candidate, error);
            assert.match(candidate.shortMessage, /message is saved and was not sent/i);
            assert.match(candidate.shortMessage, /about 45 minutes/i);
            return true;
        }
    );
    assert.equal(attempts, 1);
    assert.equal(sleeps, 0);
});

test('an exhausted legacy 429 without Retry-After never invents a one-second retry', async () => {
    const runtime = runtimeForLeaseRequests();
    const error = retryableError();
    runtime.remoteJson = async () => { throw error; };

    await assert.rejects(
        runtime.requestLeaseWithRetry(
            { client_request_id: 'legacy-no-retry-after' },
            () => {},
            null,
            { maxAttempts: 1 }
        ),
        candidate => {
            assert.equal(candidate, error);
            assert.match(candidate.shortMessage, /use Retry in a moment/i);
            assert.doesNotMatch(candidate.shortMessage, /1 second/i);
            return true;
        }
    );
});

test('lease retry backoff stops promptly when its signal is aborted', async () => {
    const runtime = runtimeForLeaseRequests();
    const controller = new AbortController();
    let attempts = 0;
    runtime.remoteJson = async () => {
        attempts += 1;
        throw retryableError();
    };

    const pending = runtime.requestLeaseWithRetry(
        { client_request_id: 'abort-retry' },
        () => {},
        controller.signal,
        { initialRetryMs: 1_000, maxRetryMs: 1_000 }
    );
    setTimeout(() => controller.abort(), 5);

    await assert.rejects(pending, error => error.name === 'AbortError');
    assert.equal(attempts, 1);
});

test('issueLease prepares one proof before delegating all transport attempts', async () => {
    const runtime = runtimeForLeaseRequests();
    runtime.manifest = { deployment_id: 'focused-test' };
    runtime.runtime = { state: { note_id: 44 }, journal: null };
    runtime.ownerId = 'test-owner';
    runtime.reload = async () => runtime.runtime;
    runtime.recoverPending = async () => {};
    let prepareCalls = 0;
    const prepared = {
        client_request_id: 'single-prepared-request',
        proof: { a: ['single-proof'] },
        public_inputs: { solvency_bound: 5_000_000 }
    };
    runtime.prepareLeaseRequest = async () => {
        prepareCalls += 1;
        return prepared;
    };
    let delegatedRequest = null;
    runtime.requestLeaseWithRetry = async request => {
        delegatedRequest = request;
        return {
            client_request_id: request.client_request_id,
            api_key: 'one-show-key',
            expires_at: 2_000_000_000,
            settle_after: 2_000_000_060,
            spending_limit_usd: 5
        };
    };
    runtime.verifyLease = async () => {};
    runtime.commit = async next => {
        runtime.runtime = next;
        return next;
    };
    runtime.scheduleSettlement = () => {};

    const lease = await runtime.issueLease('chat-session');

    assert.equal(prepareCalls, 1);
    assert.equal(delegatedRequest, prepared);
    assert.equal(lease.client_request_id, prepared.client_request_id);
    assert.equal(runtime.activeLease.sessionId, 'chat-session');
});

test('lease retirement honors Retry-After without changing the settlement request', async () => {
    const runtime = runtimeForLeaseRequests();
    const request = {
        client_request_id: 'settlement-request',
        proof: { a: ['original-proof'] },
        public_inputs: { solvency_bound: 5_000_000 }
    };
    const error = new BrowserWalletHttpError(
        'OA usage reporting is rate limited.',
        429,
        'oa_minute_request_limit',
        { retriable: true, retry_after_seconds: 7 }
    );
    const bodies = [];
    const waits = [];
    let attempts = 0;
    let clock = 0;
    runtime.remoteJson = async (_url, init) => {
        attempts += 1;
        bodies.push(init.body);
        if (attempts === 1) throw error;
        return { status: 'finalized' };
    };

    const result = await runtime.retireRequest(request.client_request_id, request, null, {
        maxWaitMs: 10_000,
        now: () => clock,
        sleep: async milliseconds => {
            waits.push(milliseconds);
            clock += milliseconds;
        }
    });

    assert.equal(result.status, 'finalized');
    assert.deepEqual(waits, [7_000]);
    assert.equal(bodies.length, 2);
    assert.ok(bodies.every(body => body === bodies[0]));
    assert.deepEqual(JSON.parse(bodies[0]), request);
});

test('lease retirement crosses the OA finalization boundary with the exact original request', async () => {
    const runtime = runtimeForLeaseRequests();
    const request = {
        client_request_id: 'settlement-boundary-request',
        proof: { a: ['proof-must-not-change'] },
        public_inputs: { solvency_bound: 25_000_000 }
    };
    const pending = [
        new BrowserWalletHttpError(
            'OpenRouter lease is already active or awaiting settlement',
            409,
            'lease_pending',
            { retriable: true, retry_after_seconds: 4 }
        ),
        new BrowserWalletHttpError(
            'OpenRouter lease settlement is still pending',
            409,
            'lease_settlement_pending',
            { retriable: true, retry_after_seconds: 11 }
        )
    ];
    const bodies = [];
    const waits = [];
    let clock = 0;
    runtime.remoteJson = async (_url, init) => {
        bodies.push(init.body);
        const error = pending.shift();
        if (error) throw error;
        return { status: 'finalized' };
    };

    const result = await runtime.retireRequest(request.client_request_id, request, null, {
        maxWaitMs: 45_000,
        now: () => clock,
        sleep: async milliseconds => {
            waits.push(milliseconds);
            clock += milliseconds;
        }
    });

    assert.equal(result.status, 'finalized');
    assert.deepEqual(waits, [4_000, 11_000]);
    assert.equal(clock, 15_000);
    assert.equal(bodies.length, 3);
    assert.ok(bodies.every(body => body === bodies[0]));
    assert.deepEqual(JSON.parse(bodies[0]), request);
});

for (const code of ['lease_pending', 'lease_settlement_pending']) {
    test(`lease issuance never retries retirement-only ${code}`, async () => {
        const runtime = runtimeForLeaseRequests();
        const error = new BrowserWalletHttpError(
            'The previous lease is still settling.',
            409,
            code,
            { retriable: true, retry_after_seconds: 15 }
        );
        let attempts = 0;
        let sleeps = 0;
        runtime.remoteJson = async () => {
            attempts += 1;
            throw error;
        };

        await assert.rejects(
            runtime.requestLeaseWithRetry(
                { client_request_id: `issuance-${code}` },
                () => {},
                null,
                { sleep: async () => { sleeps += 1; } }
            ),
            candidate => candidate === error
        );
        assert.equal(attempts, 1);
        assert.equal(sleeps, 0);
    });
}
