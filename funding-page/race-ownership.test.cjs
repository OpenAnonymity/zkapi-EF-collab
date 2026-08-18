const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function sourceBlockAt(source, markerIndex) {
    assert.ok(markerIndex >= 0, 'source block marker is missing');
    const blockStart = source.indexOf('{', markerIndex);
    assert.ok(blockStart >= 0, 'source block opening brace is missing');
    let depth = 0;
    for (let index = blockStart; index < source.length; index += 1) {
        if (source[index] === '{') depth += 1;
        if (source[index] === '}') {
            depth -= 1;
            if (depth === 0) return source.slice(blockStart, index + 1);
        }
    }
    assert.fail('source block closing brace is missing');
}

function sourceMethodAt(source, marker) {
    const markerIndex = source.indexOf(marker);
    assert.ok(markerIndex >= 0, `source method marker is missing: ${marker}`);
    const parametersStart = source.indexOf('(', markerIndex);
    assert.ok(parametersStart >= 0, `source method parameters are missing: ${marker}`);
    let parameterDepth = 0;
    let parametersEnd = -1;
    for (let index = parametersStart; index < source.length; index += 1) {
        if (source[index] === '(') parameterDepth += 1;
        if (source[index] === ')') {
            parameterDepth -= 1;
            if (parameterDepth === 0) {
                parametersEnd = index;
                break;
            }
        }
    }
    assert.ok(parametersEnd >= 0, `source method parameters do not close: ${marker}`);
    const bodyStart = source.indexOf('{', parametersEnd);
    assert.ok(bodyStart >= 0, `source method body is missing: ${marker}`);
    return source.slice(markerIndex, bodyStart) + sourceBlockAt(source, bodyStart);
}

test('lease-capable title and Quick Ask jobs are owned before their first await', () => {
    const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    const constructor = sourceMethodAt(app, 'constructor()');
    const title = sourceMethodAt(app, 'async generateSessionTitleIfNeeded(');
    const quickAsk = sourceMethodAt(app, 'async inlineQuickAsk(');
    const cancel = sourceMethodAt(app, 'async cancelPendingSendsAndWait(');
    const newChat = sourceMethodAt(app, 'async handleNewChatRequest(');

    assert.match(constructor, /this\.titleGenerationJobs = new Map\(\)/);
    assert.match(constructor, /this\.quickAskJobs = new Map\(\)/);

    const titleOwned = title.indexOf('this.titleGenerationJobs.set(sessionId, job)');
    const titleFirstAwait = title.indexOf('await ');
    assert.ok(
        titleOwned >= 0 && titleFirstAwait > titleOwned,
        'automatic title generation must be cancellable before its first asynchronous boundary'
    );
    assert.match(title, /signal:\s*job\.controller\.signal/);
    assert.match(title, /this\.titleGenerationJobs\.get\(sessionId\) === job/);
    assert.match(title, /this\.titleGenerationJobs\.delete\(sessionId\)/);

    const quickAskOwned = quickAsk.indexOf('this.quickAskJobs.set(session.id, sessionQuickAskJobs)');
    const quickAskFirstAwait = quickAsk.indexOf('await ');
    assert.ok(
        quickAskOwned >= 0 && quickAskFirstAwait > quickAskOwned,
        'Quick Ask must be cancellable before its first asynchronous boundary'
    );
    assert.match(quickAsk, /sessionQuickAskJobs\.add\(quickAskJob\)/);
    assert.match(quickAsk, /jobs\?\.delete\(quickAskJob\)/);
    assert.match(quickAsk, /this\.quickAskJobs\.delete\(session\.id\)/);

    assert.match(cancel, /titleGenerationJobs[\s\S]*?job\.controller\?\.abort\(\)/);
    assert.match(cancel, /quickAskJobs[\s\S]*?job\.controller\?\.abort\(\)/);
    assert.match(cancel, /hasTitleGeneration/);
    assert.match(cancel, /hasQuickAsk/);
    assert.match(newChat, /hasTitleGeneration/);
    assert.match(newChat, /hasQuickAsk/);
});

test('title and OA streams thread cancellation through browser lease acquisition', () => {
    const api = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');
    const client = fs.readFileSync(path.join(__dirname, 'services/zkapiClient.js'), 'utf8');
    const runtime = fs.readFileSync(path.join(__dirname, 'services/browserWalletRuntime.js'), 'utf8');

    const title = sourceMethodAt(api, 'async generateSessionTitle(');
    const stream = sourceMethodAt(api, 'async streamCompletion(');
    const acquire = sourceMethodAt(client, 'async acquireInferenceAccess(');
    const acquireEphemeral = sourceMethodAt(runtime, 'async acquireEphemeralKey(');
    const ensureLease = sourceMethodAt(runtime, 'async ensureLease(');
    const issueLease = sourceMethodAt(runtime, 'async issueLease(');

    assert.match(title, /acquireInferenceAccess\(sessionId,\s*\{\s*signal:\s*options\.signal\s*\}\)/);
    assert.match(stream, /acquireInferenceAccess\(sessionId,\s*\{\s*signal:\s*abortController\?\.signal\s*\}\)/);
    assert.match(acquire, /const signal = options\.signal \|\| null/);
    assert.match(acquire, /acquireEphemeralKey\([\s\S]*?\{ signal \}/);
    assert.match(acquireEphemeral, /ensureLease\(sessionId, onProgress, signal\)/);
    assert.match(ensureLease, /issueLease\(normalized, onProgress, signal\)/);
    assert.match(issueLease, /throwIfAborted\(signal\)/);
    assert.match(issueLease, /remoteJson\([\s\S]*?signal/);
});

test('ordinary Send and exclusive timeline mutations cannot overlap ownership', () => {
    const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    const beginMutation = sourceMethodAt(app, 'beginSessionMutation(');
    const send = sourceMethodAt(app, 'async sendMessage(');

    assert.match(beginMutation, /exclusive[\s\S]*?sendSubmissionsInFlight\.has\(sessionId\)/);
    assert.match(beginMutation, /exclusive[\s\S]*?regenerationReservations\.has\(sessionId\)/);
    assert.match(beginMutation, /exclusive[\s\S]*?getSessionStreamingState\(sessionId\)\.isStreaming/);

    const hasGate = send.indexOf('this.exclusiveSessionMutationOwners.has(targetSessionId)');
    const getGate = send.indexOf('this.exclusiveSessionMutationOwners.get(targetSessionId)');
    const exclusiveGate = Math.max(hasGate, getGate);
    const firstAwait = send.indexOf('await ');
    assert.ok(
        exclusiveGate >= 0 && (firstAwait < 0 || exclusiveGate < firstAwait),
        'Send must reject an exclusively owned timeline synchronously'
    );
});

test('hidden durable lease requests are recovered or fail closed before history deletion', () => {
    const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    const client = fs.readFileSync(path.join(__dirname, 'services/zkapiClient.js'), 'utf8');
    const runtime = fs.readFileSync(path.join(__dirname, 'services/browserWalletRuntime.js'), 'utf8');

    const settlePrevious = sourceMethodAt(
        app,
        'startPreviousChatLeaseSettlement(previousSession, previousLease = null)'
    );
    const deleteSession = sourceMethodAt(app, 'async deleteSession(');
    const deleteAll = sourceMethodAt(app, 'async deleteAllChats(');
    const clientHasPending = sourceMethodAt(client, 'async hasPendingLease(');
    const runtimeHasPending = sourceMethodAt(runtime, 'async hasPendingLease(');

    assert.doesNotMatch(
        settlePrevious,
        /if\s*\(\s*!currentLease[\s\S]{0,160}\b(?:break|return)\b/,
        'settlement must invoke crash recovery when issuance left a journal but no active lease'
    );
    assert.match(settlePrevious, /await zkapiClient\.settleActiveLease\(\)/);

    assert.match(runtimeHasPending, /await this\.reload\(\)/);
    assert.match(runtimeHasPending, /this\.activeLease \|\| this\.runtime\?\.journal/);
    assert.match(clientHasPending, /browserWalletRuntime\.hasPendingLease\(\)/);
    assert.match(clientHasPending, /await this\.refresh\(\{ quiet: true \}\)/);

    assert.match(deleteSession, /await zkapiClient\.hasPendingLease\(\)/);
    assert.match(deleteSession, /startPreviousChatLeaseSettlement\(/);
    assert.match(deleteSession, /stillPending/);
    assert.match(deleteAll, /await zkapiClient\.hasPendingLease\(\)/);
    assert.match(deleteAll, /startPreviousChatLeaseSettlement\(/);
    assert.match(deleteAll, /private key is still being finalized/i);
});
