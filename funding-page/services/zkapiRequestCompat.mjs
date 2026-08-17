// Keep a bounded output so OpenRouter never reserves a model's full context
// against the proof-bound child key. 1,024 tokens fits the $0.05 lease even for
// the deployment's most expensive current models, while avoiding the silent
// mid-sentence cutoffs caused by the old 256-token ceiling.
export const DIRECT_OPENROUTER_DEFAULT_MAX_TOKENS = 1024;

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
