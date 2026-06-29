//! Token-usage → cost → zkAPI credit conversion.
//!
//! The zkAPI protocol charges an opaque `u128` amount per request (the
//! `charge_applied` field). For the OpenAnonymity integration we define that
//! unit concretely so token-usage billing is meaningful end to end:
//!
//! ```text
//! 1 credit = 1 micro-US-dollar = $0.000001
//! ```
//!
//! So a request that costs the operator `$C` upstream is charged
//! `ceil(C * 1_000_000)` credits (with a 1-credit floor for any non-zero
//! cost, so a real inference call never rounds down to "free"). This keeps the
//! charge a plain integer the protocol's homomorphic Pedersen update can
//! deduct, while remaining an exact, auditable function of real spend.
//!
//! Cost itself comes from two sources, in priority order:
//!   1. The upstream's own reported cost (OpenRouter returns `usage.cost` in
//!      USD when `usage.include` is set). This is authoritative.
//!   2. A built-in per-model price table (OpenAI does not report cost, only
//!      token counts), used to compute cost from `prompt_tokens` /
//!      `completion_tokens`.

/// Number of credits per US dollar. 1 credit = 1 micro-dollar.
pub const CREDITS_PER_USD: f64 = 1_000_000.0;

/// Convert a US-dollar cost into integer zkAPI credits.
///
/// Rounds up so the operator is never under-paid, with a 1-credit floor for
/// any strictly-positive cost. A cost of exactly zero (e.g. a free key
/// issuance) maps to zero credits.
pub fn usd_to_credits(cost_usd: f64) -> u128 {
    if !cost_usd.is_finite() || cost_usd <= 0.0 {
        return 0;
    }
    let credits = (cost_usd * CREDITS_PER_USD).ceil();
    if credits < 1.0 {
        1
    } else {
        credits as u128
    }
}

/// Convert integer zkAPI credits back into US dollars (for display).
pub fn credits_to_usd(credits: u128) -> f64 {
    credits as f64 / CREDITS_PER_USD
}

/// A per-model price, in US dollars per **single** token.
#[derive(Debug, Clone, Copy)]
pub struct ModelPrice {
    pub prompt_usd_per_token: f64,
    pub completion_usd_per_token: f64,
}

impl ModelPrice {
    /// Build from the conventional "USD per 1M tokens" quote.
    const fn per_million(prompt: f64, completion: f64) -> Self {
        Self {
            prompt_usd_per_token: prompt / 1_000_000.0,
            completion_usd_per_token: completion / 1_000_000.0,
        }
    }

    pub fn cost_usd(&self, prompt_tokens: u64, completion_tokens: u64) -> f64 {
        prompt_tokens as f64 * self.prompt_usd_per_token
            + completion_tokens as f64 * self.completion_usd_per_token
    }
}

/// Built-in OpenAI price table (USD per 1M tokens), longest-prefix matched.
///
/// OpenAI responses report token counts but not cost, so we price them here.
/// Ordered most-specific-first; `openai_price` walks it and takes the first
/// model id that is a prefix match.
const OPENAI_PRICES: &[(&str, ModelPrice)] = &[
    ("gpt-4o-mini", ModelPrice::per_million(0.15, 0.60)),
    ("gpt-4o", ModelPrice::per_million(2.50, 10.00)),
    ("gpt-4.1-nano", ModelPrice::per_million(0.10, 0.40)),
    ("gpt-4.1-mini", ModelPrice::per_million(0.40, 1.60)),
    ("gpt-4.1", ModelPrice::per_million(2.00, 8.00)),
    ("gpt-4-turbo", ModelPrice::per_million(10.00, 30.00)),
    ("gpt-4", ModelPrice::per_million(30.00, 60.00)),
    ("gpt-3.5-turbo", ModelPrice::per_million(0.50, 1.50)),
    ("o4-mini", ModelPrice::per_million(1.10, 4.40)),
    ("o3-mini", ModelPrice::per_million(1.10, 4.40)),
    ("o3", ModelPrice::per_million(2.00, 8.00)),
    ("o1-mini", ModelPrice::per_million(1.10, 4.40)),
    ("o1", ModelPrice::per_million(15.00, 60.00)),
];

/// Fallback price used when a model id is unknown (gpt-4o-mini rates). The
/// caller is told via the returned bool so it can flag estimated pricing.
const FALLBACK_PRICE: ModelPrice = ModelPrice::per_million(0.15, 0.60);

/// Look up a model's price. Returns `(price, exact)` where `exact` is false
/// when the fallback table entry was used.
pub fn openai_price(model: &str) -> (ModelPrice, bool) {
    let model = model.trim();
    // Strip a date suffix like "-2024-07-18" by matching on prefixes.
    let mut best: Option<(&str, ModelPrice)> = None;
    for (id, price) in OPENAI_PRICES {
        if model.starts_with(id) {
            // Prefer the longest matching id (most specific).
            if best.map(|(b, _)| id.len() > b.len()).unwrap_or(true) {
                best = Some((id, *price));
            }
        }
    }
    match best {
        Some((_, price)) => (price, true),
        None => (FALLBACK_PRICE, false),
    }
}

/// Compute the OpenAI-priced cost for a request, returning the dollar cost and
/// whether the price was an exact table hit.
pub fn openai_cost_usd(model: &str, prompt_tokens: u64, completion_tokens: u64) -> (f64, bool) {
    let (price, exact) = openai_price(model);
    (price.cost_usd(prompt_tokens, completion_tokens), exact)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credit_conversion_rounds_up_with_floor() {
        // $0.0000051 (the gpt-4o-mini "say hi" call) -> 5.1 credits -> 6.
        assert_eq!(usd_to_credits(0.0000051), 6);
        // Exactly representable amount is not inflated beyond ceil.
        assert_eq!(usd_to_credits(0.000010), 10);
        // Any sub-micro-dollar positive cost still costs at least 1 credit.
        assert_eq!(usd_to_credits(0.0000001), 1);
        // Zero / free maps to zero credits.
        assert_eq!(usd_to_credits(0.0), 0);
        assert_eq!(usd_to_credits(-1.0), 0);
    }

    #[test]
    fn credits_round_trip_to_usd() {
        assert!((credits_to_usd(1_000_000) - 1.0).abs() < 1e-12);
        assert!((credits_to_usd(6) - 0.000006).abs() < 1e-12);
    }

    #[test]
    fn openai_price_matches_gpt4o_mini_exactly() {
        // 14 prompt + 5 completion at gpt-4o-mini == $0.0000051 (matches the
        // value OpenRouter reported for the same model in the live check).
        let (cost, exact) = openai_cost_usd("gpt-4o-mini-2024-07-18", 14, 5);
        assert!(exact);
        assert!((cost - 0.0000051).abs() < 1e-12, "cost was {cost}");
    }

    #[test]
    fn openai_price_prefers_longest_prefix() {
        // "gpt-4o-mini" must win over "gpt-4o" for a mini model id.
        let (mini, _) = openai_price("gpt-4o-mini");
        let (full, _) = openai_price("gpt-4o");
        assert!(mini.prompt_usd_per_token < full.prompt_usd_per_token);
    }

    #[test]
    fn unknown_model_falls_back_inexact() {
        let (_, exact) = openai_cost_usd("some-unknown-model", 100, 100);
        assert!(!exact);
    }
}
