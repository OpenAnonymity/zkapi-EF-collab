import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// ZkapiStateExperience imports the browser client singleton even though the
// panel renderer itself is pure. Supply the smallest browser shell needed to
// import it so these tests exercise rendered markup rather than source text.
const storage = {
    getItem() { return null; },
    setItem() {},
    removeItem() {}
};
globalThis.localStorage = storage;
globalThis.sessionStorage = storage;
globalThis.window = globalThis;
globalThis.location = { hostname: 'localhost', href: 'http://localhost/funding/' };
globalThis.window.location = globalThis.location;
globalThis.window.addEventListener = () => {};
globalThis.window.dispatchEvent = () => {};
globalThis.zkapiWallet = {
    ABI: {},
    abiWord() {},
    addressWord() {},
    callData() {},
    encodeDeposit() {},
    encodeFinalizeEscape() {},
    encodeWithdrawal() {},
    escapePeriodBadge() {},
    escapePeriodLabel() {},
    escapePeriodPhrase() {},
    formatTokenAmount() {},
    parseNoteDeposited() {},
    parseTokenAmount() {},
    parseWithdrawalReceipt() {}
};

const {
    renderZkapiComposerStatus,
    renderZkapiPanelExperience
} = await import('./components/ZkapiStateExperience.js');

function lowTextState(proposal, overrides = {}) {
    const primary = {
        phase: 'queued',
        tone: 'working',
        title: 'Message queued',
        detail: 'Accepted. Waiting for the previous private chat to finish.',
        compact: 'Message queued',
        busy: true,
        blocksSend: true,
        ...overrides.primary
    };
    return {
        proposal,
        showComposer: true,
        primary,
        panelPrimary: primary,
        activities: [],
        runningActivities: [],
        journey: [],
        ...overrides
    };
}

function composerElement() {
    const attributes = new Map();
    return {
        className: '',
        innerHTML: '',
        dataset: {},
        setAttribute(name, value) {
            attributes.set(name, String(value));
        },
        getAttribute(name) {
            return attributes.get(name) ?? null;
        },
        removeAttribute(name) {
            attributes.delete(name);
        },
        querySelector() {
            return { addEventListener() {} };
        }
    };
}

test('low-text proposal panels render compact summaries with detail collapsed', () => {
    for (const proposal of ['receipt', 'relay', 'ambient', 'capsule']) {
        const html = renderZkapiPanelExperience(lowTextState(proposal));
        const summary = html.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] || '';

        assert.match(html, /<details\b/);
        assert.doesNotMatch(html, /<details\b[^>]*\sopen(?:\s|>)/);
        assert.match(summary, />Queued</);
        assert.doesNotMatch(summary, /Message queued/);
        assert.doesNotMatch(summary, /Waiting for the previous private chat/);
        assert.match(html, /<strong>Message queued<\/strong>/);
        assert.match(html, /Waiting for the previous private chat/);
    }
});

test('low-text panel escapes operation copy and stays hidden when idle', () => {
    const unsafe = lowTextState('receipt', {
        primary: {
            phase: 'error',
            tone: 'error',
            title: '<script>bad()</script>',
            detail: '<img src=x onerror=bad()>',
            compact: 'Unsafe',
            busy: false,
            blocksSend: true
        }
    });
    const html = renderZkapiPanelExperience(unsafe);
    assert.doesNotMatch(html, /<script>|<img/);
    assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
    assert.match(html, /&lt;img src=x onerror=bad\(\)&gt;/);

    const idle = lowTextState('receipt', {
        showComposer: false,
        primary: {
            phase: 'ready',
            tone: 'success',
            title: 'Ready',
            detail: 'Ready.',
            compact: 'Ready',
            busy: false,
            blocksSend: false
        }
    });
    assert.equal(renderZkapiPanelExperience(idle), '');
});

test('passive unfunded state stays hidden even when the send gate requests composer visibility', () => {
    for (const proposal of ['receipt', 'relay', 'ambient', 'capsule']) {
        const state = lowTextState(proposal, {
            showComposer: true,
            primary: {
                phase: 'unfunded',
                tone: 'neutral',
                title: 'Add funds to start chatting',
                detail: 'Use MetaMask once.',
                compact: 'Add funds',
                busy: false,
                blocksSend: true
            }
        });
        const element = composerElement();

        assert.equal(renderZkapiPanelExperience(state), '');
        renderZkapiComposerStatus(element, null, state);
        assert.equal(element.className, 'hidden');
        assert.equal(element.innerHTML, '');
        assert.equal(element.dataset.zkapiStateSignature, undefined);
    }
});

test('passive state clears the visual signature so the same active phase renders again', () => {
    const active = lowTextState('relay');
    const passive = lowTextState('relay', {
        showComposer: true,
        primary: {
            phase: 'ready',
            tone: 'success',
            title: 'Ready to chat',
            detail: 'A private key will be created when you send.',
            compact: 'Ready',
            busy: false,
            blocksSend: false
        }
    });
    const element = composerElement();

    renderZkapiComposerStatus(element, null, active);
    const activeSignature = element.dataset.zkapiStateSignature;
    assert.match(element.className, /zkapi-composer-state--relay/);
    assert.match(element.innerHTML, />Queued</);

    renderZkapiComposerStatus(element, null, passive);
    assert.equal(element.className, 'hidden');
    assert.equal(element.dataset.zkapiStateSignature, undefined);

    renderZkapiComposerStatus(element, null, active);
    assert.equal(element.dataset.zkapiStateSignature, activeSignature);
    assert.match(element.className, /zkapi-composer-state--relay/);
    assert.match(element.innerHTML, />Queued</);
});

test('capsule uses static hold and error endpoints without implying accepted success', () => {
    const element = composerElement();
    const waiting = lowTextState('capsule', {
        primary: {
            phase: 'escape-wait',
            tone: 'waiting',
            title: 'Recovery window in progress',
            detail: 'Wait for the safety window.',
            compact: 'Recovery window in progress',
            busy: false,
            blocksSend: true
        }
    });

    renderZkapiComposerStatus(element, null, waiting);
    assert.match(element.innerHTML, /zkapi-state-glyph--waiting/);
    assert.match(element.innerHTML, /zkapi-capsule-origin--neutral/);
    assert.match(element.innerHTML, /zkapi-capsule-end--hold/);
    assert.doesNotMatch(element.innerHTML, /✓|→/);
    assert.equal(element.getAttribute('aria-busy'), 'false');

    const error = lowTextState('capsule', {
        primary: {
            phase: 'error',
            tone: 'error',
            title: 'Previous chat needs attention',
            detail: 'Try again.',
            compact: 'Needs attention',
            busy: false,
            blocksSend: true
        }
    });
    renderZkapiComposerStatus(element, null, error);
    assert.match(element.innerHTML, /zkapi-state-glyph--error/);
    assert.match(element.innerHTML, /zkapi-capsule-origin--neutral/);
    assert.match(element.innerHTML, /zkapi-capsule-end--error/);
    assert.doesNotMatch(element.innerHTML, /✓|→/);

    const closing = lowTextState('capsule', {
        primary: {
            phase: 'closing',
            tone: 'working',
            title: 'Finishing previous chat',
            detail: 'Closing its private key.',
            compact: 'Finishing previous chat',
            busy: true,
            blocksSend: false
        }
    });
    renderZkapiComposerStatus(element, null, closing);
    assert.match(element.innerHTML, /zkapi-capsule-origin--neutral/);
    assert.match(element.innerHTML, /zkapi-capsule-end--closing/);
    assert.doesNotMatch(element.innerHTML, /✓|→/);
});

test('recovery controls have a visible busy state and reduced motion keeps pending copy readable', () => {
    const css = fs.readFileSync(new URL('./zkapi.css', import.meta.url), 'utf8');
    const reducedMotion = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'));

    assert.match(css, /\.user-delivery-details summary\s*\{[\s\S]*?min-height: 1\.5rem/);
    assert.match(css, /\.user-delivery-actions button\[aria-busy="true"\][\s\S]*?pointer-events: none/);
    assert.match(css, /\.message-action-btn\.is-processing::after,[\s\S]*?animation: zkapiActionOrbit/);
    assert.match(css, /\.chat-session\[data-deleting="true"\]\s*\{[\s\S]*?cursor: wait/);
    assert.match(reducedMotion, /\.pending-response-streaming\s*\{[\s\S]*?animation: none !important/);
    assert.match(reducedMotion, /\.message-action-btn\.is-processing::after/);
    assert.match(reducedMotion, /-webkit-text-fill-color: currentColor !important/);
});
