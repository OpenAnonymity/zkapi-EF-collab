// Evaluate after browser-composition-fixture.js in an isolated local browser,
// then send a one-line prompt using the UI. Read composerStyleCheck.verify()
// after the response completes. Repeat after reloading for each theme/viewport.
{
if (!['127.0.0.1', 'localhost'].includes(location.hostname) || !window.compositionFixture) {
    throw new Error('Install the localhost-only composition fixture first.');
}
window.composerStyleCheck?.disconnect();
const card = document.getElementById('input-card');
const initialHeight = card.getBoundingClientRect().height;
const records = [];
const observer = new MutationObserver(mutations => {
    const status = document.getElementById('chat-operation-status');
    if (!status || records.at(-1)?.text === status.textContent) return;
    // Ignore unrelated composer mutations and stale text from a previous send.
    if (!mutations.some(mutation => mutation.target === status || status.contains(mutation.target)
        || [...mutation.addedNodes].includes(status))) return;
    const style = getComputedStyle(status);
    const bounds = status.getBoundingClientRect();
    records.push({
        text: status.textContent,
        count: document.querySelectorAll('#chat-operation-status').length,
        role: status.getAttribute('role'),
        ariaHidden: status.getAttribute('aria-hidden'),
        hidden: status.hidden,
        display: style.display,
        visibility: style.visibility,
        position: style.position,
        clipPath: style.clipPath,
        width: bounds.width,
        height: bounds.height,
        composerHeight: card.getBoundingClientRect().height
    });
});
observer.observe(card, { childList: true, subtree: true, characterData: true });
window.composerStyleCheck = {
    records,
    disconnect: () => observer.disconnect(),
    verify() {
        let previousIndex = -1;
        for (const text of ['Message accepted.', 'Response complete.']) {
            const index = records.findIndex((item, i) => i > previousIndex && item.text === text);
            const record = records[index];
            if (!record) throw new Error(`The real chat lifecycle did not announce: ${text}`);
            previousIndex = index;
            if (record.count !== 1 || record.role !== 'status' || record.ariaHidden === 'true'
                || record.hidden || record.display === 'none' || record.visibility === 'hidden') {
                throw new Error(`Announcement lost its accessibility semantics: ${text}`);
            }
            if (record.position !== 'absolute' || record.clipPath !== 'inset(50%)'
                || record.width !== 1 || record.height !== 1
                || Math.abs(record.composerHeight - initialHeight) > 0.5) {
                throw new Error(`Announcement leaked into the composer layout: ${JSON.stringify(record)}`);
            }
        }
        return { passed: true, theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
            viewport: innerWidth, initialHeight, records };
    }
};
({ installed: true, initialHeight });
}
