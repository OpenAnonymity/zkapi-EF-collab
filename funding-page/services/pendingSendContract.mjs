export function capturePendingSendDraft({
    rawContent = '',
    files = [],
    searchEnabled = false,
    scrubberPending = null,
    modelName = null,
    memoryMode = false,
    reasoningEnabled = true,
    reasoningEffort = null,
    sessionId = null
} = {}) {
    const capturedFiles = Object.freeze([...files]);
    return {
        rawContent,
        content: rawContent.trim(),
        files: capturedFiles,
        hasFiles: capturedFiles.length > 0,
        searchEnabled: Boolean(searchEnabled),
        scrubberPending,
        modelName,
        memoryMode: Boolean(memoryMode),
        reasoningEnabled: Boolean(reasoningEnabled),
        reasoningEffort,
        sessionId,
        accepted: false
    };
}

export function retainUnacceptedText(liveText, acceptedRawContent) {
    return liveText === acceptedRawContent ? '' : liveText;
}

export function retainUnacceptedFiles(liveFiles = [], acceptedFiles = []) {
    const accepted = new Set(acceptedFiles);
    return liveFiles.filter(file => !accepted.has(file));
}

export function sameScrubberDraft(value, accepted) {
    return Boolean(value && accepted
        && value.redacted === accepted.redacted
        && value.original === accepted.original);
}
