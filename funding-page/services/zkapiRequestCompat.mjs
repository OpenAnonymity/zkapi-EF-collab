// Keep browser-direct requests aligned with crates/zkapi-clientd/src/compat.rs.
// Without an explicit ceiling OpenRouter can reserve a model's full maximum
// output against the small proof-bound child-key limit and reject an otherwise
// affordable request before it runs.
export const DIRECT_OPENROUTER_DEFAULT_MAX_TOKENS = 256;

export function ensureDirectCompletionLimit(body) {
    const normalized = { ...(body || {}) };
    if (Object.hasOwn(normalized, 'max_tokens')
        || Object.hasOwn(normalized, 'max_completion_tokens')) {
        return normalized;
    }
    if (Object.hasOwn(normalized, 'max_output_tokens')) {
        normalized.max_tokens = normalized.max_output_tokens;
        delete normalized.max_output_tokens;
    } else {
        normalized.max_tokens = DIRECT_OPENROUTER_DEFAULT_MAX_TOKENS;
    }
    return normalized;
}
