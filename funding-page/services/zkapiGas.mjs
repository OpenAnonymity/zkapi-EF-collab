const GAS_MARGIN_NUMERATOR = 12n;
const GAS_MARGIN_DENOMINATOR = 10n;
const GAS_FIXED_PADDING = 50_000n;

export function bufferedGasLimit(estimate) {
    const value = typeof estimate === 'bigint' ? estimate : BigInt(estimate);
    if (value <= 0n) throw new Error('The wallet returned an invalid gas estimate.');
    const buffered = value * GAS_MARGIN_NUMERATOR / GAS_MARGIN_DENOMINATOR + GAS_FIXED_PADDING;
    return `0x${buffered.toString(16)}`;
}
