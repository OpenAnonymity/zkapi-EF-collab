const SENSITIVE_HEADER_NAMES = new Set([
    'authorization',
    'proxy-authorization',
    'cookie',
    'set-cookie',
    'api-key',
    'x-api-key',
    'x-auth-token',
    'x-access-token',
    'x-inference-ticket'
]);
const SENSITIVE_FIELD_NAMES = new Set([
    'key',
    'apikey',
    'token',
    'accesstoken',
    'refreshtoken',
    'credential',
    'secret',
    'sharedsecret',
    'managementkey',
    'privatekey',
    'authorization',
    'auth',
    'password',
    'cookie',
    'setcookie',
    'inferenceticket'
]);
const REDACTED = '[REDACTED]';

function headerEntries(headers) {
    if (!headers) return [];
    if (Array.isArray(headers)) return headers;
    if (typeof headers.entries === 'function') return Array.from(headers.entries());
    return Object.entries(headers);
}

export function sanitizeNetworkHeaders(headers) {
    const sanitized = {};
    for (const [rawName, value] of headerEntries(headers)) {
        const name = String(rawName);
        const normalizedName = name.trim().toLowerCase();
        sanitized[name] = SENSITIVE_HEADER_NAMES.has(normalizedName)
            ? REDACTED
            : value;
    }
    return sanitized;
}

function normalizedFieldName(name) {
    return String(name).replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function sanitizeNetworkString(value) {
    const trimmed = value.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}'))
        || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
            const parsed = JSON.parse(value);
            if (parsed && typeof parsed === 'object') {
                return JSON.stringify(sanitizeNetworkValue(parsed));
            }
        } catch {
            // Preserve ordinary non-JSON diagnostic text after token masking.
        }
    }
    return value
        .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [REDACTED]')
        .replace(/\bsk-(?:or-v1-)?[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]');
}

export function sanitizeNetworkValue(value, seen = new WeakSet()) {
    if (typeof value === 'string') return sanitizeNetworkString(value);
    if (value == null || typeof value !== 'object') return value;
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);

    if (Array.isArray(value)) {
        return value.map(entry => sanitizeNetworkValue(entry, seen));
    }

    if (value instanceof Error) {
        return {
            name: value.name,
            message: value.message
        };
    }

    const sanitized = {};
    for (const [name, entry] of Object.entries(value)) {
        sanitized[name] = SENSITIVE_FIELD_NAMES.has(normalizedFieldName(name))
            ? REDACTED
            : sanitizeNetworkValue(entry, seen);
    }
    return sanitized;
}
