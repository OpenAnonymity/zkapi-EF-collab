const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'components/ChatArea.js'), 'utf8');
const isolatedSource = source
    .replace(/^import .*;\n/gm, '')
    .replace('export default class ChatArea', 'class ChatArea')
    .concat('\nChatArea;');
const ChatArea = vm.runInNewContext(isolatedSource, { console });

function createChatArea(app) {
    const chatArea = Object.create(ChatArea.prototype);
    chatArea.app = app;
    chatArea.render = async () => {};
    return chatArea;
}

function actionButton() {
    const classes = new Set();
    const attributes = new Map();
    return {
        disabled: false,
        classList: {
            toggle(name, enabled) {
                if (enabled) classes.add(name);
                else classes.delete(name);
            },
            contains(name) {
                return classes.has(name);
            }
        },
        setAttribute(name, value) {
            attributes.set(name, String(value));
        },
        removeAttribute(name) {
            attributes.delete(name);
        },
        getAttribute(name) {
            return attributes.get(name) ?? null;
        }
    };
}

test('regenerate keeps its original session and user-message target across navigation', async () => {
    let currentSession = { id: 'session-a' };
    const stoppedSessions = [];
    const readSessions = [];
    const deletedMessages = [];
    const regenerationTargets = [];
    const mutationEvents = [];
    let releaseStop;
    const stopGate = new Promise(resolve => { releaseStop = resolve; });
    const messages = [
        { id: 'user-a', role: 'user' },
        { id: 'assistant-a', role: 'assistant' },
        { id: 'assistant-after', role: 'assistant' }
    ];
    const app = {
        getCurrentSession: () => currentSession,
        beginSessionMutation(sessionId) {
            mutationEvents.push(`begin:${sessionId}`);
            return { sessionId };
        },
        endSessionMutation(sessionId) {
            mutationEvents.push(`end:${sessionId}`);
        },
        isSessionDeleted: () => false,
        async stopSessionStreamingAndWait(sessionId) {
            stoppedSessions.push(sessionId);
            currentSession = { id: 'session-b' };
            await stopGate;
            return true;
        },
        data: {
            async getSessionMessages(sessionId) {
                readSessions.push(sessionId);
                return messages;
            },
            async deleteMessage(messageId) {
                deletedMessages.push(messageId);
            }
        },
        async regenerateResponse(target) {
            regenerationTargets.push(target);
        }
    };
    const button = actionButton();

    const action = createChatArea(app).handleRegenerateMessage('assistant-a', button);
    assert.equal(button.disabled, true);
    assert.equal(button.classList.contains('is-processing'), true);
    assert.equal(button.getAttribute('aria-busy'), 'true');
    releaseStop();
    await action;

    assert.deepEqual(mutationEvents, ['begin:session-a', 'end:session-a']);
    assert.deepEqual(stoppedSessions, ['session-a']);
    assert.deepEqual(readSessions, ['session-a']);
    assert.deepEqual(deletedMessages, ['assistant-a', 'assistant-after']);
    assert.equal(regenerationTargets.length, 1);
    assert.equal(regenerationTargets[0].sessionId, 'session-a');
    assert.equal(regenerationTargets[0].userMessageId, 'user-a');
    assert.equal(button.disabled, false);
    assert.equal(button.classList.contains('is-processing'), false);
    assert.equal(button.getAttribute('aria-busy'), null);
});

test('resend keeps its original session and user-message target across navigation', async () => {
    const originalSession = { id: 'session-a' };
    let currentSession = originalSession;
    const stoppedSessions = [];
    const readSessions = [];
    const deletedMessages = [];
    const prunedTargets = [];
    const regenerationTargets = [];
    const mutationEvents = [];
    let releaseStop;
    const stopGate = new Promise(resolve => { releaseStop = resolve; });
    const messages = [
        { id: 'user-before', role: 'user' },
        { id: 'user-a', role: 'user' },
        { id: 'assistant-a', role: 'assistant' }
    ];
    const app = {
        getCurrentSession: () => currentSession,
        beginSessionMutation(sessionId) {
            mutationEvents.push(`begin:${sessionId}`);
            return { sessionId };
        },
        endSessionMutation(sessionId) {
            mutationEvents.push(`end:${sessionId}`);
        },
        isSessionDeleted: () => false,
        async stopSessionStreamingAndWait(sessionId) {
            stoppedSessions.push(sessionId);
            currentSession = { id: 'session-b' };
            await stopGate;
            return true;
        },
        data: {
            async getSessionMessages(sessionId) {
                readSessions.push(sessionId);
                return messages;
            },
            async deleteMessage(messageId) {
                deletedMessages.push(messageId);
            }
        },
        async pruneMemoryRetrievedContextFromMessage(session, _messages, messageIndex) {
            prunedTargets.push({ sessionId: session.id, messageIndex });
        },
        async regenerateResponse(target) {
            regenerationTargets.push(target);
        }
    };
    const button = actionButton();

    const action = createChatArea(app).handleResendMessage('user-a', button);
    assert.equal(button.disabled, true);
    assert.equal(button.classList.contains('is-processing'), true);
    assert.equal(button.getAttribute('aria-busy'), 'true');
    releaseStop();
    await action;

    assert.deepEqual(mutationEvents, ['begin:session-a', 'end:session-a']);
    assert.deepEqual(stoppedSessions, ['session-a']);
    assert.deepEqual(readSessions, ['session-a']);
    assert.deepEqual(prunedTargets, [{ sessionId: 'session-a', messageIndex: 1 }]);
    assert.deepEqual(deletedMessages, ['assistant-a']);
    assert.equal(regenerationTargets.length, 1);
    assert.equal(regenerationTargets[0].sessionId, 'session-a');
    assert.equal(regenerationTargets[0].userMessageId, 'user-a');
    assert.equal(button.disabled, false);
    assert.equal(button.classList.contains('is-processing'), false);
    assert.equal(button.getAttribute('aria-busy'), null);
});
