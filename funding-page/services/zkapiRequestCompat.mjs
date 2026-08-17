// Publishing the exact private-note balance as a proof input would make the
// balance linkable. Pick a coarse, cumulative USD budget instead. The child key
// enforces this budget across the title, response, and all follow-ups in one
// chat; it is not a per-request token allowance.
export const CHAT_SPENDING_TIER_USD = Object.freeze([
    0.05,
    0.25,
    0.5,
    1,
    1.5,
    2,
    3,
    5
]);

// A high, deliberately conservative frontier-model price. It keeps OpenRouter
// from preflighting a model's entire context against the child key without
// recreating the former small fixed token quota.
export const CONSERVATIVE_COMPLETION_PRICE_USD_PER_TOKEN = 0.00005;
export const CHAT_OUTPUT_BUDGET_FRACTION = 0.9;
export const MAX_COMPATIBILITY_OUTPUT_TOKENS = 128_000;

export function selectLeaseSpendingLimitCredits(
    currentBalance,
    minimumChargeCap,
    creditsPerUsd = 1_000_000
) {
    const balance = Math.floor(Number(currentBalance));
    const minimum = Math.ceil(Number(minimumChargeCap));
    const scale = Number(creditsPerUsd);
    if (!Number.isSafeInteger(balance) || balance < 0
        || !Number.isSafeInteger(minimum) || minimum <= 0
        || !Number.isSafeInteger(scale) || scale <= 0) {
        throw new Error('Invalid private-balance lease budget configuration.');
    }

    let selected = minimum;
    for (const dollars of CHAT_SPENDING_TIER_USD) {
        const tier = Math.round(dollars * scale);
        if (tier >= minimum && tier <= balance) selected = tier;
    }
    return selected;
}

function positiveNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
}

export function ensureDirectCompletionLimit(body, { spendingLimitUsd, model } = {}) {
    const normalized = { ...(body || {}) };
    if (Object.hasOwn(normalized, 'max_tokens')
        || Object.hasOwn(normalized, 'max_completion_tokens')) {
        return normalized;
    }
    if (Object.hasOwn(normalized, 'max_output_tokens')) {
        normalized.max_tokens = normalized.max_output_tokens;
        delete normalized.max_output_tokens;
        return normalized;
    }

    const budget = positiveNumber(spendingLimitUsd);
    if (!budget) return normalized;

    const advertisedCompletionPrice = positiveNumber(model?.pricing?.completion);
    const completionPrice = Math.max(
        advertisedCompletionPrice || 0,
        CONSERVATIVE_COMPLETION_PRICE_USD_PER_TOKEN
    );
    const advertisedMaximum = positiveNumber(model?.top_provider?.max_completion_tokens);
    const maximum = Math.min(
        advertisedMaximum || MAX_COMPATIBILITY_OUTPUT_TOKENS,
        MAX_COMPATIBILITY_OUTPUT_TOKENS
    );
    normalized.max_tokens = Math.max(1, Math.min(
        maximum,
        Math.floor((budget * CHAT_OUTPUT_BUDGET_FRACTION) / completionPrice)
    ));
    return normalized;
}
