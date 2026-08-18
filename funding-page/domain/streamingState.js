export function normalizePendingPhase(phase) {
    if (phase === 'settling-previous') return 'settling-previous';
    return phase === 'requesting-key' || phase === 'waiting'
        ? 'requesting-key'
        : 'waiting-response';
}
