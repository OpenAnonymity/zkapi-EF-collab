import {
    buildUsageLedgerEntry, mergeUsageLedgerEntries, recoverUsageLedgerFromMessages,
    summarizeUsageLedger, upsertUsageLedgerEntry
} from './modelPricing.mjs';

const RETIREMENT_TIMEOUT_MS = 45_000;

function abortError() {
    const error = new Error('Request canceled');
    error.name = 'AbortError';
    error.isCancelled = true;
    return error;
}

function waitFor(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
        const abort = () => reject(abortError());
        signal.addEventListener('abort', abort, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}

/** The entire private-payment lifecycle belongs to this product, not OA Chat. */
export function createZkapiChatRuntimeCore({ client, backend, createInferenceService, modelConfiguration, retirementTimeoutMs = RETIREMENT_TIMEOUT_MS, retryDelay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) } = {}) {
    if (!client || !backend || typeof createInferenceService !== 'function' || !modelConfiguration) {
        throw new Error('Private chat runtime dependencies are required.');
    }
    let context = null;
    let transition = null;
    let retirement = null;
    let disposed = false;
    const previews = new Map();
    const queuedSessions = new Map();
    const inferenceService = createInferenceService({
        backends: [backend],
        defaultBackendId: backend.id,
        resolveDefaultModelConfig: modelConfiguration.getDefaultModelConfig
    });

    function publish() {
        if (!disposed) context?.refreshPresentation();
    }

    function setTransition(value) {
        transition = value ? { ...value, updatedAt: Date.now() } : null;
        publish();
    }

    function logSettlement(action, message, sessionId) {
        try { context?.logLocalEvent?.(action, message, { sessionId }); }
        catch (_) { /* Presentation diagnostics must not stop settlement. */ }
    }

    function reportSnapshot(snapshot) {
        const activities = snapshot?.activities || [];
        const activity = activities.at(-1);
        for (const sessionId of queuedSessions.keys()) {
            const progress = activity?.kind === 'settlement'
                ? { ...activity, kind: 'settlement' }
                : { kind: 'settlement', phase: 'settling' };
            context?.setProgress(sessionId, progress);
        }
        publish();
    }

    function startRetirement(sessionId, { cancelWork = true } = {}) {
        if (retirement) return retirement;
        const ownerId = client.activeLease?.session_id || sessionId;
        if (!ownerId) return Promise.resolve();
        setTransition({ phase: 'settling', sessionId: ownerId,
            title: context?.getSession(ownerId)?.title || 'Previous chat',
            message: 'Closing the previous chat key in the background.' });
        logSettlement('lease-settlement-start', 'Closing the previous chat key in the background.', ownerId);
        // Assign the promise before any await; a rapid Send sees this barrier.
        const job = Promise.resolve().then(async () => {
            if (cancelWork) await context?.cancelSessionWork(ownerId);
            const deadline = Date.now() + retirementTimeoutMs;
            while (true) {
                if (client.activeLease && client.activeLease.session_id !== ownerId) break;
                try {
                    await client.settleActiveLease();
                    break;
                } catch (error) {
                    const retryable = ['lease_requests_in_flight', 'lease_pending', 'lease_settlement_pending'].includes(error?.code)
                        || /still (?:settling|being finalized)/i.test(error?.message || '');
                    const retryAfter = Number(error?.data?.retry_after_seconds ?? error?.data?.error?.retry_after_seconds);
                    const delay = Number.isFinite(retryAfter) && retryAfter >= 0
                        ? Math.max(250, Math.ceil(retryAfter * 1000)) : 1000;
                    if (!retryable || Date.now() + delay > deadline) throw error;
                    await retryDelay(delay);
                }
            }
            setTransition({ phase: 'ready', sessionId: ownerId, message: 'Previous chat settled.' });
            logSettlement('lease-settlement-complete', 'Previous chat key settled. Remaining balance is available.', ownerId);
        });
        retirement = job;
        job.then(() => {
            if (retirement === job) retirement = null;
        }, error => {
            if (retirement === job) retirement = null;
            setTransition({ phase: 'error', sessionId: ownerId, message: error?.message || 'Could not finish the previous chat.' });
            logSettlement('lease-settlement-error', 'Could not finish the previous chat. Retry to continue.', ownerId);
        });
        return job;
    }

    async function recordUsage({ sessionId, requestId, usage, pricing = null, kind = 'response', final = true }) {
        const session = context?.getSession(sessionId);
        const entry = buildUsageLedgerEntry({ id: requestId, kind, usage,
            pricing: structuredClone(pricing || usage?.pricing || null), model: usage?.model });
        if (!session || !entry) return null;
        let sessionPreviews = previews.get(sessionId);
        if (!sessionPreviews) previews.set(sessionId, sessionPreviews = new Map());
        if (final) {
            session.zkapiUsageLedger = upsertUsageLedgerEntry(session.zkapiUsageLedger, entry);
            sessionPreviews.delete(requestId);
            await context.saveSession(session);
        } else sessionPreviews.set(requestId, entry);
        if (!disposed) context?.refreshPresentation({ usageOnly: true });
        return {
            promptTokens: entry.promptTokens, completionTokens: entry.completionTokens,
            totalTokens: entry.totalTokens, estimatedCostUsd: entry.estimatedCostUsd,
            usageProviderReported: entry.providerReported, usagePricing: structuredClone(entry.pricing),
            zkapiUsageRecorded: true
        };
    }

    return {
        inferenceService,
        modelConfiguration,
        features: { accounts: false, tickets: false, memory: false, scrubber: false, council: false },
        reuseAccessOnFork: false,
        transformForkMessage(message) {
            // A fork retains the conversation, not historical charges. Its
            // first new request obtains access owned by the new session.
            const snapshot = structuredClone(message);
            for (const field of ['promptTokens', 'completionTokens', 'totalTokens',
                'estimatedCostUsd', 'usageProviderReported', 'usagePricing', 'zkapiUsageRecorded']) {
                delete snapshot[field];
            }
            return snapshot;
        },
        async acquireAccess(options) {
            return inferenceService.requestAccess(options.session, { signal: options.signal });
        },
        attach(value) {
            context = value;
            disposed = false;
            const unsubscribe = client.subscribe((snapshot, detail) => {
                if (detail?.reason !== 'clock') reportSnapshot(snapshot);
            });
            void client.init().then(publish, publish);
            return () => { disposed = true; unsubscribe(); };
        },
        async checkCanSend({ signal } = {}) {
            if (signal?.aborted) throw abortError();
            await client.init();
            if (signal?.aborted) throw abortError();
            if (client.withdrawalBlocksChat || !client.hasNote) {
                context?.openFunding();
                return false;
            }
            return true;
        },
        onNewChat({ sessionId }) {
            if (sessionId || client.activeLease) void startRetirement(sessionId).catch(() => {});
        },
        async prepareTurn({ sessionId, signal, onProgress }) {
            if (signal?.aborted) throw abortError();
            const activeOwner = client.activeLease?.session_id;
            if (!retirement && activeOwner && activeOwner !== sessionId) startRetirement(activeOwner);
            if (transition?.phase === 'error' && !retirement) startRetirement(transition.sessionId, { cancelWork: transition.sessionId !== sessionId });
            if (!retirement) return;
            queuedSessions.set(sessionId, (queuedSessions.get(sessionId) || 0) + 1);
            onProgress?.({ kind: 'settlement', phase: 'settling' });
            publish();
            try { await waitFor(retirement, signal); }
            finally {
                const remaining = (queuedSessions.get(sessionId) || 1) - 1;
                if (remaining) queuedSessions.set(sessionId, remaining);
                else queuedSessions.delete(sessionId);
                publish();
            }
        },
        async beforeDelete({ sessionIds }) {
            // The wallet snapshot may already be clear while settlement is
            // still publishing its durable result. Keep its owner recoverable.
            if (retirement && (!sessionIds || sessionIds.includes(transition?.sessionId))) {
                await retirement;
            }
            const active = client.activeLease;
            if (active && (!sessionIds || sessionIds.includes(active.session_id))) {
                await startRetirement(active.session_id);
            }
            if (await client.hasPendingLease()) throw new Error('Private access is still finishing. Try again shortly.');
        },
        getTransition: () => transition,
        getSessionStatus(session) {
            if (queuedSessions.has(session?.id)) return { tone: 'waiting', label: 'Queued' };
            if (transition?.sessionId === session?.id && transition.phase === 'settling') return { tone: 'working', label: 'Finishing' };
            if (transition?.sessionId === session?.id && transition.phase === 'error') return { tone: 'error', label: 'Needs attention' };
            return null;
        },
        getSessionUsageSummary(sessionOrId) {
            const session = typeof sessionOrId === 'string' ? context?.getSession(sessionOrId) : sessionOrId;
            return summarizeUsageLedger(mergeUsageLedgerEntries(session?.zkapiUsageLedger || [],
                [...(previews.get(session?.id)?.values() || [])]));
        },
        recordUsage,
        discardUsagePreview({ sessionId, requestId }) {
            const sessionPreviews = previews.get(sessionId);
            if (!sessionPreviews?.delete(requestId)) return;
            if (!sessionPreviews.size) previews.delete(sessionId);
            if (!disposed) context?.refreshPresentation({ usageOnly: true });
        },
        async restoreSession(session, messages) {
            if (!session) return;
            // A late history read must never recreate a concurrently deleted
            // chat, or overwrite the newer live session object with its copy.
            session = context?.getSession(session.id);
            if (!session) return;
            const previous = session.zkapiUsageLedger || [];
            const recovered = recoverUsageLedgerFromMessages(previous, messages);
            if (recovered.length !== previous.length) {
                session.zkapiUsageLedger = recovered;
                await context?.saveSession(session);
                if (!disposed) context?.refreshPresentation({ usageOnly: true });
            }
        }
    };
}
