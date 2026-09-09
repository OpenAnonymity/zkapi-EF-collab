import { TICKET_TIER_BUDGET_USD } from './zkapiModelBudget.mjs';

// Publish a reviewed model-tier budget, never the user's exact private balance.
// This is the key's cumulative cap across titles, responses and follow-ups.
export const CHAT_SPENDING_TIER_USD = Object.freeze(
    [...new Set(Object.values(TICKET_TIER_BUDGET_USD))].sort((a, b) => a - b)
);

export function leaseSpendingLimitCredits(spendingLimitUsd = 1, creditsPerUsd = 1_000_000) {
    const scale = Number(creditsPerUsd);
    const dollars = Number(spendingLimitUsd);
    const credits = Math.round(dollars * scale);
    if (!CHAT_SPENDING_TIER_USD.includes(dollars)
        || !Number.isSafeInteger(scale) || scale <= 0
        || !Number.isSafeInteger(credits) || credits <= 0) {
        throw new Error('Invalid private-balance model budget configuration.');
    }
    return credits;
}

// A high, deliberately conservative frontier-model price. It keeps OpenRouter
// from preflighting a model's entire context against the child key without
// recreating the former small fixed token quota.
export const CONSERVATIVE_COMPLETION_PRICE_USD_PER_TOKEN = 0.00005;
export const CHAT_OUTPUT_BUDGET_FRACTION = 0.9;
export const MAX_COMPATIBILITY_OUTPUT_TOKENS = 128_000;

export function selectLeaseSpendingLimitCredits(
    currentBalance,
    minimumChargeCap,
    creditsPerUsd = 1_000_000,
    spendingLimitUsd = 1
) {
    const balance = Math.floor(Number(currentBalance));
    const minimum = Math.ceil(Number(minimumChargeCap));
    const scale = Number(creditsPerUsd);
    if (!Number.isSafeInteger(balance) || balance < 0
        || !Number.isSafeInteger(minimum) || minimum <= 0
        || !Number.isSafeInteger(scale) || scale <= 0) {
        throw new Error('Invalid private-balance lease budget configuration.');
    }

    const fixedChatBudget = leaseSpendingLimitCredits(spendingLimitUsd, scale);
    if (minimum > fixedChatBudget) {
        throw new Error('This model budget is below the deployment’s minimum private-chat budget.');
    }
    if (balance < fixedChatBudget) {
        const error = new Error(`This model requires at least $${Number(spendingLimitUsd).toFixed(2)} in private balance for a new key. Choose a lower-cap model, or withdraw the remaining balance and fund a larger one.`);
        error.code = 'insufficient_chat_balance';
        error.required_credits = fixedChatBudget;
        error.required_balance_usd = Number(spendingLimitUsd);
        throw error;
    }
    return fixedChatBudget;
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
