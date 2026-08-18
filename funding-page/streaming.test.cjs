const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const moduleUrl = pathToFileURL(path.join(__dirname, 'services/oaSseStream.mjs'));
const streamingStateUrl = pathToFileURL(path.join(__dirname, 'domain/streamingState.js'));

test('queued settlement remains distinct from access and response waits', async () => {
    const { normalizePendingPhase } = await import(streamingStateUrl);
    assert.equal(normalizePendingPhase('settling-previous'), 'settling-previous');
    assert.equal(normalizePendingPhase('requesting-key'), 'requesting-key');
    assert.equal(normalizePendingPhase('waiting'), 'requesting-key');
    assert.equal(normalizePendingPhase('stream-open'), 'waiting-response');
});

test('OA SSE transport delivers complete lines before the response finishes', async () => {
    const { consumeSseBody } = await import(moduleUrl);
    const encoder = new TextEncoder();
    let sendSecondChunk;
    const waitForSecondChunk = new Promise(resolve => { sendSecondChunk = resolve; });
    let firstChunkObserved;
    const observedFirstChunk = new Promise(resolve => { firstChunkObserved = resolve; });
    const lines = [];

    const body = new ReadableStream({
        async start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hel'));
            controller.enqueue(encoder.encode('lo"}}]}\n'));
            await waitForSecondChunk;
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":" world"}}]}\r\n'));
            controller.enqueue(encoder.encode('data: [DONE]\n'));
            controller.close();
        }
    });

    const consuming = consumeSseBody(body, line => {
        lines.push(line);
        if (lines.length === 1) firstChunkObserved();
    });

    await observedFirstChunk;
    assert.deepEqual(lines, ['data: {"choices":[{"delta":{"content":"hello"}}]}']);
    sendSecondChunk();
    await consuming;
    assert.deepEqual(lines, [
        'data: {"choices":[{"delta":{"content":"hello"}}]}',
        'data: {"choices":[{"delta":{"content":" world"}}]}',
        'data: [DONE]'
    ]);
});
