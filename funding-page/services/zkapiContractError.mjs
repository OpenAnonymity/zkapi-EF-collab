const CONTRACT_ERRORS = Object.freeze({
    '0x09bde339': {
        code: 'invalid_proof',
        message: 'The vault rejected the withdrawal proof. Refresh the page and prepare the withdrawal again.'
    },
    '0x607447de': {
        code: 'stale_root',
        message: 'The vault changed while the withdrawal was being prepared. The Merkle path and proof must be refreshed.'
    },
    '0x947e59c5': {
        code: 'replayed_nullifier',
        message: 'This private state was already used or reserved. Check the withdrawal’s on-chain status before retrying.'
    },
    '0x61a83aab': {
        code: 'note_not_active',
        message: 'This private note is no longer active. Check its on-chain withdrawal status.'
    },
    '0xc52e3eff': {
        code: 'invalid_balance',
        message: 'The withdrawal balance is not valid for this private note.'
    },
    '0x9722445b': {
        code: 'invalid_deployment',
        message: 'The withdrawal proof does not match this zkAPI deployment.'
    },
    '0xd9876be8': {
        code: 'invalid_siblings',
        message: 'The vault rejected the withdrawal Merkle path. Prepare a fresh withdrawal and try again.'
    },
    '0x3be553f2': {
        code: 'not_pending_withdrawal',
        message: 'This note does not have an escape withdrawal waiting to be finalized.'
    },
    '0x151f07fe': {
        code: 'challenge_not_expired',
        message: 'The escape safety window has not finished yet.'
    },
    '0x5274afe7': {
        code: 'token_transfer_failed',
        message: 'The vault could not return the billing tokens. Check the deployed token and vault balances.'
    }
});

function matchingSelector(value) {
    if (typeof value !== 'string') return null;
    for (const match of value.matchAll(/0x[0-9a-fA-F]{8,}/g)) {
        const selector = match[0].slice(0, 10).toLowerCase();
        if (CONTRACT_ERRORS[selector]) return selector;
    }
    return null;
}

export function contractRevertSelector(error) {
    const queue = [error];
    const seen = new Set();
    while (queue.length) {
        const value = queue.shift();
        if (value == null || seen.has(value)) continue;
        if (typeof value === 'string') {
            const selector = matchingSelector(value);
            if (selector) return selector;
            try {
                queue.push(JSON.parse(value));
            } catch {
                // Most provider messages are plain text rather than JSON.
            }
            continue;
        }
        if (typeof value !== 'object') continue;
        seen.add(value);
        for (const nested of Object.values(value)) queue.push(nested);
    }
    return null;
}

export function contractEstimateError(error) {
    const selector = contractRevertSelector(error);
    const detail = selector ? CONTRACT_ERRORS[selector] : null;
    const providerMessage = error?.shortMessage || error?.message || String(error);
    const wrapped = new Error(detail?.message
        || `Could not estimate a safe transaction gas limit: ${providerMessage}`);
    wrapped.name = 'ZkapiContractError';
    wrapped.code = detail?.code || 'gas_estimation_failed';
    wrapped.selector = selector;
    wrapped.cause = error;
    return wrapped;
}

