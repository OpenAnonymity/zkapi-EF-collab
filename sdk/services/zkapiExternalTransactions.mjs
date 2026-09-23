const PUBLIC_RECOVERY_FIELDS = [
    'recordId', 'operationId', 'submissionId', 'generation', 'noteId', 'mode',
    'destination', 'finalBalance', 'clearanceReserved', 'withdrawalNullifier',
    'amount', 'commitment'
];

export function externalRecoveryContext(recovery, funding, deploymentId) {
    const context = {
        version: 1,
        kind: recovery?.kind || 'token',
        deploymentId,
        chainId: Number(funding?.chain_id),
        contractAddress: funding?.contract_address
    };
    for (const key of PUBLIC_RECOVERY_FIELDS) {
        if (recovery?.submission?.[key] != null) context[key] = recovery.submission[key];
    }
    return context;
}

export function sameAddress(left, right) {
    return /^0x[0-9a-f]{40}$/i.test(left || '')
        && String(left).toLowerCase() === String(right).toLowerCase();
}

export function externalTransactionNonce(value) {
    if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(String(value ?? ''))) return null;
    const parsed = BigInt(value);
    return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : null;
}

export function assertExternalTransaction(actual, expected, hash, chainId) {
    const nonce = externalTransactionNonce(expected?.nonce);
    if (!/^0x[0-9a-f]{64}$/i.test(hash || '') || !actual
        || String(actual.hash || '').toLowerCase() !== hash.toLowerCase()
        || !sameAddress(actual.from, expected?.from)
        || !sameAddress(actual.to, expected?.to)
        || !/^0x(?:[0-9a-f]{2})+$/i.test(expected?.data || '')
        || String(actual.input ?? actual.data ?? '').toLowerCase() !== expected.data.toLowerCase()
        || nonce == null || externalTransactionNonce(actual.nonce) !== nonce
        || BigInt(actual.value ?? '0x0') !== 0n || BigInt(expected.value ?? '0x0') !== 0n
        || (actual.chainId != null && BigInt(actual.chainId) !== BigInt(chainId))
        || (expected.chainId != null && BigInt(expected.chainId) !== BigInt(chainId))) {
        throw new Error('The external transaction does not match the saved wallet request.');
    }
    return { from: actual.from.toLowerCase(), nonce };
}

export function hasDurableTransactionHash(record, hash) {
    if (!record) return false;
    const expected = hash.toLowerCase();
    return [record.transactionHash, record.finalizeTransactionHash,
        ...(record.transactionHashes || []), ...(record.finalizeTransactionHashes || []),
        ...(record.transactionAttempts || []).map(attempt => attempt.hash),
        ...(record.finalizeAttempts || []).map(attempt => attempt.hash)]
        .some(value => String(value || '').toLowerCase() === expected);
}
