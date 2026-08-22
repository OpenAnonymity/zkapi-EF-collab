import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
    sanitizeNetworkHeaders,
    sanitizeNetworkValue
} from './services/networkLogSanitizer.mjs';
import networkLogger from './services/networkLogger.js';

const fundingRoot = path.dirname(fileURLToPath(import.meta.url));

test('network logs fully redact credentials regardless of header casing', () => {
    const sanitized = sanitizeNetworkHeaders({
        authorization: 'Bearer live-ephemeral-key',
        Authorization: 'Bearer second-live-key',
        'X-API-Key': 'provider-secret',
        Cookie: 'session=secret',
        'content-type': 'application/json'
    });

    assert.equal(sanitized.authorization, '[REDACTED]');
    assert.equal(sanitized.Authorization, '[REDACTED]');
    assert.equal(sanitized['X-API-Key'], '[REDACTED]');
    assert.equal(sanitized.Cookie, '[REDACTED]');
    assert.equal(sanitized['content-type'], 'application/json');
    assert.doesNotMatch(JSON.stringify(sanitized), /live-|provider-secret|session=secret/);
});

test('network header sanitizer supports the browser Headers representation', () => {
    const headers = new Headers({
        Authorization: 'Bearer live-ephemeral-key',
        'Content-Type': 'application/json'
    });
    const sanitized = sanitizeNetworkHeaders(headers);

    assert.equal(sanitized.authorization, '[REDACTED]');
    assert.equal(sanitized['content-type'], 'application/json');
});

test('network log responses recursively redact one-show keys and credentials', () => {
    const sanitized = sanitizeNetworkValue({
        source: 'oa_org',
        key: 'sk-or-v1-live-child-key',
        nested: {
            api_key: 'second-live-child-key',
            credential: 'ticket-secret',
            key_hash: 'safe-public-hash'
        },
        rows: [{ token: 'bearer-token', model: 'test/model' }]
    });

    assert.equal(sanitized.key, '[REDACTED]');
    assert.equal(sanitized.nested.api_key, '[REDACTED]');
    assert.equal(sanitized.nested.credential, '[REDACTED]');
    assert.equal(sanitized.nested.key_hash, 'safe-public-hash');
    assert.equal(sanitized.rows[0].token, '[REDACTED]');
    assert.doesNotMatch(JSON.stringify(sanitized), /live-child|ticket-secret|bearer-token/);
});

test('network logger sanitizes request and response credentials even when a caller forgets', () => {
    networkLogger.clearLogs();
    networkLogger.logRequest({
        request: {
            headers: { authorization: 'Bearer forgotten-live-key' },
            body: { credential: 'forgotten-ticket' }
        },
        response: { key: 'sk-or-v1-forgotten-response-key' }
    });

    const [entry] = networkLogger.getAllLogs();
    assert.equal(entry.request.headers.authorization, '[REDACTED]');
    assert.equal(entry.request.body.credential, '[REDACTED]');
    assert.equal(entry.response.key, '[REDACTED]');
    assert.doesNotMatch(JSON.stringify(entry), /forgotten-live|forgotten-ticket|forgotten-response/);
});

test('serialized JSON and bearer diagnostics cannot smuggle credentials into logs', () => {
    const serialized = sanitizeNetworkValue('{"key":"sk-or-v1-serialized-secret","ok":true}');
    const diagnostic = sanitizeNetworkValue('request failed: Authorization: Bearer live-diagnostic-secret');

    assert.deepEqual(JSON.parse(serialized), { key: '[REDACTED]', ok: true });
    assert.equal(diagnostic, 'request failed: Authorization: Bearer [REDACTED]');
});

test('TLS inspection parses metadata without retaining verbose request lines', () => {
    const source = fs.readFileSync(path.join(fundingRoot, 'services/networkProxy.js'), 'utf8');
    assert.doesNotMatch(source, /rawLogs/);
    assert.match(source, /this\.parseTlsOutput\(text\)/);
});
