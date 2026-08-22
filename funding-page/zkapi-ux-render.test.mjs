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
globalThis.document = {
    documentElement: { dataset: {} },
    createElement() {
        let textContent = '';
        return {
            set textContent(value) { textContent = String(value ?? ''); },
            get textContent() { return textContent; },
            get innerHTML() {
                return textContent
                    .replaceAll('&', '&amp;')
                    .replaceAll('<', '&lt;')
                    .replaceAll('>', '&gt;')
                    .replaceAll('"', '&quot;')
                    .replaceAll("'", '&#39;');
            }
        };
    }
};

// MessageTemplates loads the preference facade at module evaluation time.
// Give it a tiny successful IndexedDB shell so this DOM-rendering test remains
// deterministic and does not wait for the production database timeout.
const settings = new Map();
const request = (result) => {
    const value = {};
    queueMicrotask(() => {
        value.result = typeof result === 'function' ? result() : result;
        value.onsuccess?.({ target: value });
    });
    return value;
};
const settingsStore = {
    get(key) { return request(() => settings.has(key) ? { key, value: settings.get(key) } : undefined); },
    put(entry) { return request(() => { settings.set(entry.key, entry.value); return entry.key; }); },
    delete(key) { return request(() => settings.delete(key)); }
};
const fakeDb = {
    version: 4,
    close() {},
    transaction() { return { objectStore: () => settingsStore }; }
};
globalThis.indexedDB = {
    open() { return request(fakeDb); }
};
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
const { createVanillaUiInterface } = await import('./ui/appInterface.js');
const { default: Sidebar } = await import('./components/Sidebar.js');
const { default: RightPanel } = await import('./components/RightPanel.js');
const { default: AccountModal } = await import('./components/AccountModal.js');
const { default: WelcomePanel } = await import('./components/WelcomePanel.js');
const { default: zkapiClient } = await import('./services/zkapiClient.js');
const {
    buildMessageHTML,
    buildTypingIndicator
} = await import('./components/MessageTemplates.js');
const { processMessagesForApi } = await import('./domain/messageContent.js');

function lowTextState(proposal, overrides = {}) {
    const { primary: primaryOverrides = {}, ...stateOverrides } = overrides;
    const primary = {
        phase: 'queued',
        tone: 'working',
        title: 'Message queued',
        detail: 'Accepted. Waiting for the previous private chat to finish.',
        compact: 'Message queued',
        busy: true,
        blocksSend: true,
        ...primaryOverrides
    };
    return {
        proposal,
        showComposer: true,
        primary,
        panelPrimary: primary,
        activities: [],
        runningActivities: [],
        journey: [],
        ...stateOverrides
    };
}

function composerElement() {
    const attributes = new Map();
    let innerHTML = '';
    let innerHTMLWrites = 0;
    return {
        className: '',
        dataset: {},
        set innerHTML(value) {
            innerHTML = String(value);
            innerHTMLWrites += 1;
        },
        get innerHTML() {
            return innerHTML;
        },
        get innerHTMLWrites() {
            return innerHTMLWrites;
        },
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

test('unchanged clock renders retain composer descendants for every UX proposal', () => {
    for (const proposal of ['quiet', 'guided', 'activity', 'receipt', 'relay', 'ambient', 'capsule']) {
        const state = lowTextState(proposal, {
            journey: [
                { id: 'balance', label: 'Check balance', state: 'complete' },
                { id: 'key', label: 'Create private key', state: 'active' }
            ]
        });
        const element = composerElement();

        renderZkapiComposerStatus(element, null, state);
        const writesAfterFirstRender = element.innerHTMLWrites;
        renderZkapiComposerStatus(element, null, state);

        assert.equal(
            element.innerHTMLWrites,
            writesAfterFirstRender,
            `${proposal} must not replace identical animated descendants`
        );
    }
});

test('composer memoization still renders changed labels and guided journey steps', () => {
    const element = composerElement();
    const activityState = lowTextState('receipt', {
        primary: { phase: 'requesting', activity: { kind: 'settlement' } }
    });
    renderZkapiComposerStatus(element, null, activityState);
    const firstWrites = element.innerHTMLWrites;
    renderZkapiComposerStatus(element, null, lowTextState('receipt', {
        primary: { phase: 'requesting', activity: { kind: 'access' } }
    }));
    assert.equal(element.innerHTMLWrites, firstWrites + 1);
    assert.match(element.innerHTML, />Securing</);

    const guided = composerElement();
    const firstJourney = lowTextState('guided', {
        journey: [{ id: 'balance', label: 'Check balance', state: 'active' }]
    });
    renderZkapiComposerStatus(guided, null, firstJourney);
    const guidedWrites = guided.innerHTMLWrites;
    renderZkapiComposerStatus(guided, null, {
        ...firstJourney,
        journey: [{ id: 'balance', label: 'Check balance', state: 'complete' }]
    });
    assert.equal(guided.innerHTMLWrites, guidedWrites + 1);
    assert.match(guided.innerHTML, /data-state="complete"/);
});

test('same-phase lease retries refresh every proposal without adding low-text clutter', () => {
    const retryMessage = 'Temporary-key service is busy. Retrying in 2 seconds…';
    for (const proposal of ['quiet', 'guided', 'activity', 'receipt', 'relay', 'ambient', 'capsule']) {
        const activity = {
            id: `access-${proposal}`,
            kind: 'access',
            phase: 'requesting',
            status: 'running',
            title: 'Starting private chat',
            message: retryMessage,
            blocksSend: true,
            startedAt: 1,
            updatedAt: 2
        };
        const initial = lowTextState(proposal, {
            primary: {
                phase: 'requesting',
                title: activity.title,
                detail: 'Creating a temporary key for this chat…',
                compact: activity.title,
                activity
            },
            activities: [{ ...activity, message: 'Creating a temporary key for this chat…' }],
            runningActivities: [activity]
        });
        const retrying = lowTextState(proposal, {
            primary: {
                phase: 'requesting',
                title: activity.title,
                detail: retryMessage,
                compact: activity.title,
                activity
            },
            activities: [activity],
            runningActivities: [activity]
        });
        const element = composerElement();

        renderZkapiComposerStatus(element, null, initial);
        const before = element.innerHTML;
        renderZkapiComposerStatus(element, null, retrying);

        assert.notEqual(element.className, 'hidden', `${proposal} must retain an active retry signal`);
        assert.notEqual(element.innerHTML, before, `${proposal} must not memoize stale retry copy`);
        assert.match(element.innerHTML, /Temporary-key service is busy/);
        assert.equal(element.getAttribute('aria-busy'), 'true');
        assert.match(renderZkapiPanelExperience(retrying), /Temporary-key service is busy/);
        if (['receipt', 'relay'].includes(proposal)) {
            assert.match(element.innerHTML, />Retrying</);
        }
        if (['receipt', 'relay', 'ambient', 'capsule'].includes(proposal)) {
            assert.match(element.innerHTML, /role="status"/);
            assert.match(element.innerHTML, /aria-live="polite"/);
        }
    }
});

test('live UI facades render New Chat settlement state in sidebar and right panel', () => {
    const oldChat = { id: 'old-chat', title: 'Old chat' };
    const app = {
        state: {
            currentSessionId: 'new-chat',
            sessions: [oldChat],
            sessionsById: new Map([[oldChat.id, oldChat]])
        },
        elements: {},
        newChatSettlementState: null
    };
    const ui = createVanillaUiInterface(app, { chatDBImpl: {} });
    const sidebar = Object.create(Sidebar.prototype);
    sidebar.app = ui.sidebar;
    sidebar.deletingSessionIds = new Set();
    const panel = Object.create(RightPanel.prototype);
    panel.app = ui.componentApp;

    app.newChatSettlementState = {
        phase: 'settling',
        sessionId: oldChat.id,
        message: 'Closing in the background.'
    };

    assert.equal(ui.sidebar.newChatSettlementState, app.newChatSettlementState);
    assert.equal(ui.componentApp.newChatSettlementState, app.newChatSettlementState);
    assert.match(sidebar.buildSessionHTML(oldChat), /Closing private key/);
    assert.deepEqual(panel.getMissingApiKeyStatus(), {
        label: 'Closing previous chat key',
        badge: 'Settling',
        badgeClass: 'bg-amber-100 text-amber-800 dark:bg-amber-500\/15 dark:text-amber-200'
    });

    app.newChatSettlementState = {
        phase: 'ready',
        sessionId: oldChat.id,
        message: 'Finished.'
    };
    assert.match(sidebar.buildSessionHTML(oldChat), /Private key settled/);
    assert.equal(panel.getMissingApiKeyStatus().badge, 'Ready');
});

test('time-only ticks use a separate channel from semantic client changes', () => {
    let clockEvents = 0;
    let semanticEvents = 0;
    let globalSemanticEvents = 0;
    const originalWindowDispatch = globalThis.window.dispatchEvent;
    globalThis.window.dispatchEvent = () => { globalSemanticEvents += 1; };
    const unsubscribeClock = zkapiClient.subscribeClock(detail => {
        clockEvents += 1;
        assert.equal(typeof detail.now, 'number');
    });
    const unsubscribeSemantic = zkapiClient.subscribe(() => { semanticEvents += 1; });

    try {
        zkapiClient.emitClock();
        assert.equal(clockEvents, 1);
        assert.equal(semanticEvents, 0);
        assert.equal(globalSemanticEvents, 0);

        zkapiClient.emitChange('runtime');
        assert.equal(clockEvents, 1);
        assert.equal(semanticEvents, 1);
        assert.equal(globalSemanticEvents, 1);
    } finally {
        unsubscribeClock();
        unsubscribeSemantic();
        globalThis.window.dispatchEvent = originalWindowDispatch;
    }
});

test('unchanged quiet refreshes do not fan out semantic UI events', async () => {
    const original = {
        browserMode: zkapiClient.browserMode,
        config: zkapiClient.config,
        wallet: zkapiClient.wallet,
        withdrawal: zkapiClient.withdrawal,
        lastError: zkapiClient.lastError,
        apiJson: zkapiClient.apiJson
    };
    zkapiClient.browserMode = false;
    zkapiClient.config = { version: 1 };
    zkapiClient.wallet = { note: null };
    zkapiClient.withdrawal = null;
    zkapiClient.lastError = null;
    zkapiClient.apiJson = async path => path === '/zkapi/v1/config'
        ? { version: 1 }
        : { note: null };
    let semanticEvents = 0;
    const unsubscribe = zkapiClient.subscribe(() => { semanticEvents += 1; });

    try {
        await zkapiClient.refresh({ quiet: true });
        assert.equal(semanticEvents, 0);

        zkapiClient.apiJson = async path => path === '/zkapi/v1/config'
            ? { version: 2 }
            : { note: null };
        await zkapiClient.refresh({ quiet: true });
        assert.equal(semanticEvents, 1, 'a real runtime change must still notify subscribers');
    } finally {
        unsubscribe();
        zkapiClient.browserMode = original.browserMode;
        zkapiClient.config = original.config;
        zkapiClient.wallet = original.wallet;
        zkapiClient.withdrawal = original.withdrawal;
        zkapiClient.lastError = original.lastError;
        zkapiClient.apiJson = original.apiJson;
    }
});

test('right-panel clock ticks update countdown text without replacing interactive UI', () => {
    const originalDocument = globalThis.document;
    let loads = 0;
    let expiryText = '';
    globalThis.document = {
        querySelector(selector) {
            if (selector.includes('[data-zkapi-note-expiry]')) {
                return {
                    set textContent(value) { expiryText = value; },
                    get textContent() { return expiryText; }
                };
            }
            return null;
        }
    };

    const panel = Object.create(RightPanel.prototype);
    panel.loadSessionData = () => { loads += 1; };
    try {
        panel.handleZkapiClock();
        assert.equal(loads, 0, 'a clock tick must not rebuild the panel');
        panel.handleZkapiChange({ reason: 'clock' });
        assert.equal(loads, 0, 'a legacy clock event must remain non-rendering');
        panel.handleZkapiChange({ reason: 'note' });
        assert.equal(loads, 1, 'a real billing update should still rebuild the panel');
    } finally {
        globalThis.document = originalDocument;
    }
});

test('account clock patches preserve the modal and enable escape finalization at its deadline', () => {
    const originalWallet = zkapiClient.wallet;
    const originalConfig = zkapiClient.config;
    const originalWithdrawal = zkapiClient.withdrawal;
    const originalFormatExpiry = zkapiClient.formatExpiry;
    const originalActiveElement = globalThis.document.activeElement;
    const countdown = { textContent: '' };
    const finalizeButton = { textContent: '', disabled: true };
    const noteExpiry = { textContent: '' };
    const leaseExpiry = { textContent: '' };
    const withdrawalCheckbox = { checked: true };
    let overlayWrites = 0;
    const overlay = {
        scrollTop: 137,
        set innerHTML(_value) { overlayWrites += 1; },
        querySelector(selector) {
            if (selector === '[data-zkapi-escape-countdown]') return countdown;
            if (selector === '#zkapi-finalize-btn') return finalizeButton;
            if (selector === '[data-zkapi-balance-expiry]') return noteExpiry;
            if (selector === '[data-zkapi-active-lease-expiry]') return leaseExpiry;
            if (selector === '#zkapi-withdraw-confirm') return withdrawalCheckbox;
            return null;
        }
    };
    const deadline = 2_000_000_000;
    zkapiClient.wallet = { note: { expiry_ts: deadline + 10_000 } };
    zkapiClient.config = { active_lease: { expires_at: deadline } };
    zkapiClient.withdrawal = { phase: 'pending', challengeDeadline: deadline };
    let expiryLabel = '1m';
    zkapiClient.formatExpiry = () => expiryLabel;
    globalThis.document.activeElement = finalizeButton;

    const modal = Object.create(AccountModal.prototype);
    modal.isOpen = true;
    modal.overlay = overlay;
    modal.view = 'withdraw';
    modal.busy = false;
    try {
        modal.handleZkapiClock(deadline * 1000 - 1);
        assert.equal(finalizeButton.disabled, true);
        assert.equal(finalizeButton.textContent, 'Finalize in 1m');
        assert.equal(countdown.textContent, 'Finalize in 1m.');
        assert.equal(globalThis.document.activeElement, finalizeButton);
        assert.equal(withdrawalCheckbox.checked, true);
        assert.equal(overlay.scrollTop, 137);
        assert.equal(overlayWrites, 0, 'the dialog subtree must remain mounted');

        modal.handleZkapiClock(deadline * 1000);
        assert.equal(finalizeButton.disabled, false);
        assert.equal(finalizeButton.textContent, 'Finalize in MetaMask');
        assert.equal(countdown.textContent, 'The safety window is complete.');
        assert.equal(globalThis.document.activeElement, finalizeButton);
        assert.equal(withdrawalCheckbox.checked, true);
        assert.equal(overlay.scrollTop, 137);
        assert.equal(overlayWrites, 0, 'crossing the deadline must not rebuild the dialog');

        modal.view = 'balance';
        modal.handleZkapiClock(deadline * 1000);
        assert.equal(noteExpiry.textContent, 'expires in 1m');
        assert.equal(leaseExpiry.textContent, '1m');
        expiryLabel = 'expired';
        modal.handleZkapiClock(deadline * 1000 + 1);
        assert.equal(leaseExpiry.textContent, 'expired');
        assert.equal(overlayWrites, 0);
    } finally {
        zkapiClient.wallet = originalWallet;
        zkapiClient.config = originalConfig;
        zkapiClient.withdrawal = originalWithdrawal;
        zkapiClient.formatExpiry = originalFormatExpiry;
        globalThis.document.activeElement = originalActiveElement;
    }
});

test('welcome success is edge-triggered and retains focus across later state events', () => {
    const originalDocument = globalThis.document;
    const originalWallet = zkapiClient.wallet;
    const focusedChild = { id: 'welcome-continue' };
    const overlay = {};
    globalThis.document = {
        ...originalDocument,
        activeElement: focusedChild,
        getElementById(id) { return id === 'welcome-panel' ? overlay : null; }
    };
    zkapiClient.wallet = { has_note: true, note: { current_balance: 1 } };
    const panel = new WelcomePanel({});
    panel.isOpen = true;
    panel.step = 'welcome';
    panel.busy = false;
    let renders = 0;
    panel.render = () => { renders += 1; };

    try {
        zkapiClient.emitClock();
        assert.equal(renders, 0, 'clock ticks must not reach the welcome renderer');
        zkapiClient.emitChange('runtime');
        assert.equal(renders, 1);
        assert.equal(panel.step, 'success');
        assert.equal(globalThis.document.activeElement, focusedChild);

        zkapiClient.emitChange('runtime');
        assert.equal(renders, 1, 'duplicate funded state must retain the existing success DOM');
        assert.equal(globalThis.document.activeElement, focusedChild);
    } finally {
        panel.unsubscribe?.();
        zkapiClient.wallet = originalWallet;
        globalThis.document = originalDocument;
    }
});

test('right-panel disclosures preserve both open and closed state across real rerenders', () => {
    const originalDocument = globalThis.document;
    const basePrototype = Object.getPrototypeOf(RightPanel.prototype);
    const originalBaseRender = basePrototype.renderTopSectionOnly;
    const disclosure = (open) => {
        const listeners = new Map();
        return {
            open,
            addEventListener(type, listener) { listeners.set(type, listener); },
            toggle(value) {
                this.open = value;
                listeners.get('toggle')?.();
            }
        };
    };
    let current = {
        experience: disclosure(true),
        billing: disclosure(true)
    };
    let replacement = {
        experience: disclosure(false),
        billing: disclosure(false)
    };
    let afterBaseRender = false;
    globalThis.document = {
        querySelector(selector) {
            const set = afterBaseRender ? replacement : current;
            return selector.includes('billing-explainer') ? set.billing : set.experience;
        }
    };
    basePrototype.renderTopSectionOnly = () => { afterBaseRender = true; };

    const panel = Object.create(RightPanel.prototype);
    try {
        panel.renderTopSectionOnly();
        assert.equal(replacement.experience.open, true);
        assert.equal(replacement.billing.open, true);

        replacement.billing.toggle(false);
        current = replacement;
        replacement = {
            experience: disclosure(false),
            billing: disclosure(true)
        };
        afterBaseRender = false;
        panel.renderTopSectionOnly();
        assert.equal(replacement.experience.open, true);
        assert.equal(replacement.billing.open, false, 'closing the billing disclosure must persist');
    } finally {
        basePrototype.renderTopSectionOnly = originalBaseRender;
        globalThis.document = originalDocument;
    }
});

test('Securing appears only in the assistant pending row while live', () => {
    const user = {
        id: 'user-1',
        sessionId: 'chat-a',
        role: 'user',
        content: 'Explain HTTPS',
        timestamp: 1,
        deliveryState: 'securing'
    };
    const userHtml = buildMessageHTML(user, {}, [], '', { isSessionStreaming: true });
    const assistantHtml = buildTypingIndicator(
        'typing-1',
        'OpenAI',
        'OpenAI: GPT-5.3 Instant',
        1,
        'requesting-key'
    );

    assert.doesNotMatch(userHtml, /user-delivery-row/);
    assert.doesNotMatch(userHtml, />Securing</);
    assert.match(assistantHtml, />Securing</);

    const interruptedHtml = buildMessageHTML(user, {}, [], '', { isSessionStreaming: false });
    assert.match(interruptedHtml, />Not sent</);
    assert.match(interruptedHtml, />Retry</);
});

test('returning to a chat preserves its complete conversation and excludes the other chat', () => {
    const chatA = [
        { role: 'user', content: 'Explain HTTPS.' },
        { role: 'assistant', content: 'HTTPS combines HTTP with TLS.' },
        { role: 'user', content: 'go on' }
    ];
    const chatB = [
        { role: 'user', content: 'Explain photosynthesis.' },
        { role: 'assistant', content: 'Plants turn light into chemical energy.' }
    ];

    // Reselecting a chat must rebuild from that chat's durable messages; a new
    // ephemeral key changes billing transport, not conversation semantics.
    const selectedSessionMessages = new Map([
        ['chat-a', chatA],
        ['chat-b', chatB]
    ]).get('chat-a');
    const request = processMessagesForApi(selectedSessionMessages, 'openai/gpt-5.3-chat');

    assert.deepEqual(request, chatA);
    assert.equal(request.some(message => /photosynthesis/i.test(message.content)), false);
    assert.deepEqual(request.map(message => message.role), ['user', 'assistant', 'user']);
});

test('consumer-facing payment UI omits note numbers and the redundant sidebar account pill', () => {
    const panel = fs.readFileSync(new URL('./components/RightPanel.js', import.meta.url), 'utf8');
    const account = fs.readFileSync(new URL('./components/AccountModal.js', import.meta.url), 'utf8');
    const client = fs.readFileSync(new URL('./services/zkapiClient.js', import.meta.url), 'utf8');
    const index = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');

    for (const source of [panel, account, client]) {
        assert.doesNotMatch(source, /(?:private\s+)?note\s*#/i);
    }
    assert.doesNotMatch(index, /id="account-tab-btn"/);
    assert.match(index, /id="show-right-panel-btn"[^>]+aria-controls="right-panel"/);
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
    assert.match(css, /\.zkapi-composer-live-status\s*\{[\s\S]*?clip: rect\(0, 0, 0, 0\)/);
    assert.match(reducedMotion, /\.pending-response-streaming\s*\{[\s\S]*?animation: none !important/);
    assert.match(reducedMotion, /\.message-action-btn\.is-processing::after/);
    assert.match(reducedMotion, /-webkit-text-fill-color: currentColor !important/);
});
