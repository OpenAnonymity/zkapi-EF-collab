export const PAYMENT_MODES = Object.freeze({ tickets: 'openrouter', zkapi: 'zkapi' });
export const PAYMENT_MODE_PREFERENCE = 'oa-payment-mode';

/** Payment chooses access issuance; OA remains the owner of every transcript. */
export function createPaymentModeRuntimeCore({ zkRuntime, inferenceService, acquireVerifiedAccess,
    modelConfiguration, preferenceStorage = null, initialMode = 'tickets' }) {
    let context = null;
    let switching = false;
    const modeFor = session => session
        ? (session.inferenceBackend || inferenceService.getLegacyBackendId?.(session)) === 'zkapi' ? 'zkapi' : 'tickets'
        : inferenceService.getDefaultBackendId() === 'zkapi' ? 'zkapi' : 'tickets';
    inferenceService.setDefaultBackendId(PAYMENT_MODES[initialMode] || PAYMENT_MODES.tickets);

    const runtime = {
        ...zkRuntime,
        inferenceService,
        modelConfiguration,
        features: { ...zkRuntime.features, accounts: true, tickets: true },
        usesTicketAccess: session => modeFor(session) === 'tickets',
        getMode: (session = context?.getCurrentSession()) => modeFor(session),
        isSwitching: () => switching,
        isModeLocked: () => switching || Boolean(context?.isSessionBusy()),
        attach(value) {
            context = value;
            return zkRuntime.attach(value);
        },
        async changeMode(mode) {
            if (!Object.hasOwn(PAYMENT_MODES, mode)) throw new Error('Choose Tickets or zkAPI.');
            if (!context) throw new Error('Chat is still loading. Please try again.');
            if (runtime.isModeLocked()) throw new Error('Finish or stop the current response before switching payment methods.');
            switching = true;
            context.refreshPresentation();
            try {
                await context.changeSessionBackend(PAYMENT_MODES[mode]);
                inferenceService.setDefaultBackendId(PAYMENT_MODES[mode]);
                try { preferenceStorage?.setItem(PAYMENT_MODE_PREFERENCE, mode); } catch { /* Session choice is still durable. */ }
            } finally {
                switching = false;
                context.refreshPresentation();
            }
        },
        async beforeBackendChange({ session, previousBackendId }) {
            if (previousBackendId === 'zkapi') await zkRuntime.retireSessionAccess(session.id);
            // An OA key and a zkAPI session binding are different credentials.
            // Never carry either into the other backend's issuance request.
            delete session.zkapiSessionId;
            delete session.zkapiSettleBeforeAccess;
        },
        acquireAccess(options) {
            return modeFor(options.session) === 'tickets'
                ? acquireVerifiedAccess(options)
                : inferenceService.requestAccess(options.session, { signal: options.signal });
        },
        checkCanSend(options = {}) {
            return modeFor(context?.getSession(options.sessionId)) === 'tickets'
                ? true : zkRuntime.checkCanSend(options);
        },
        prepareTurn(options) {
            if (modeFor(context?.getSession(options.sessionId)) === 'zkapi') return zkRuntime.prepareTurn(options);
        },
        onNewChat({ sessionId }) {
            if (modeFor(context?.getSession(sessionId)) === 'zkapi') zkRuntime.onNewChat({ sessionId });
        },
        shouldCancelOnNewChat: ({ session }) => session?.inferenceBackend === 'zkapi',
        recordUsage(options) {
            if (modeFor(context?.getSession(options.sessionId)) === 'zkapi') return zkRuntime.recordUsage(options);
        }
    };
    return runtime;
}
