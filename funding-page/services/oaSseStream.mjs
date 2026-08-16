/**
 * Consume an SSE response incrementally, matching OA Chat's browser transport.
 * `onLine` runs as soon as each complete line arrives; the response is never
 * buffered into a single string or JSON value.
 */
export async function consumeSseBody(body, onLine) {
    if (!body?.getReader) {
        throw new Error('The inference response did not include a readable stream.');
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
            onLine(line.replace(/\r$/, ''));
        }
    }

    buffer += decoder.decode();
    if (buffer) onLine(buffer.replace(/\r$/, ''));
}
