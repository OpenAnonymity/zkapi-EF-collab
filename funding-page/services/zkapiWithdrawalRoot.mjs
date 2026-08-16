export function sameFelt(left, right) {
    try {
        return BigInt(left) === BigInt(right);
    } catch {
        return false;
    }
}

export async function waitForExpectedActiveRoot(loadPath, expectedActiveRoot, {
    attempts = 20,
    delayMs = 500,
    sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
} = {}) {
    const limit = expectedActiveRoot == null ? 1 : attempts;
    for (let attempt = 0; attempt < limit; attempt += 1) {
        const path = await loadPath();
        if (expectedActiveRoot == null || sameFelt(path.active_root, expectedActiveRoot)) return path;
        if (attempt + 1 < limit) await sleep(delayMs);
    }
    const error = new Error('The zkAPI indexer is still catching up with the latest Sepolia vault root. Try again in a few seconds.');
    error.code = 'indexer_root_lag';
    throw error;
}

