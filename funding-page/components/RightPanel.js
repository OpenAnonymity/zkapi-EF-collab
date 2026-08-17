import OaRightPanelBase from './OaRightPanelBase.js';
import zkapiClient from '../services/zkapiClient.js';

/**
 * OA's System Panel with its ticket purchase/redemption section replaced by
 * zkAPI private-note billing. The ephemeral-key, proxy, and activity UI below
 * that seam stays on the upstream OA implementation.
 */
export default class RightPanel extends OaRightPanelBase {
    constructor(app) {
        super(app);
        this.zkapiUnsubscribe = zkapiClient.subscribe(() => this.loadSessionData());
    }

    loadSessionData() {
        const session = this.currentSession;
        const lease = zkapiClient.activeLease;
        const ownsLease = !!session && lease?.session_id === session.id;
        const accessInfo = session
            ? this.app.services.inference.getAccessInfo(session)
            : null;

        // OA persists its raw key on the chat. zkAPI deliberately persists
        // only the chat binding and keeps the real child key in memory.
        this.apiKey = ownsLease ? accessInfo?.token || session.id : null;
        this.apiKeyInfo = ownsLease ? {
            ...(accessInfo?.info || {}),
            stationId: lease.station_id || accessInfo?.info?.stationId || null,
            clientRequestId: lease.client_request_id
        } : null;
        this.expiresAt = ownsLease
            ? new Date(Number(lease.expires_at) * 1000).toISOString()
            : null;
        this.networkLogs = this.app.services.networkLogger.getAllLogs();
        this.previousLogCount = this.networkLogs.length;
        this.startExpirationTimer();
        this.renderTopSectionOnly();
        this.updateStatusIndicator();

        requestAnimationFrame(() => this.scrollToBottomInstant());
    }

    onSessionChange(session) {
        this.currentSession = session;
        this.loadSessionData();
    }

    billingSectionHTML() {
        const note = zkapiClient.note;
        const balance = note ? zkapiClient.formatMoney(note.current_balance) : '$0.00';
        const used = note
            ? zkapiClient.formatMoney(Math.max(0, Number(note.deposit_amount || 0) - Number(note.current_balance || 0)))
            : '$0.00';
        const percent = note?.deposit_amount
            ? Math.max(0, Math.min(100, Number(note.current_balance) / Number(note.deposit_amount) * 100))
            : 0;
        const hasError = !!zkapiClient.lastError;
        const transition = this.app.newChatSettlementState;
        const transitionBadge = transition?.phase === 'error'
            ? 'attention'
            : transition?.phase === 'ready'
                ? 'key closed'
                : transition
                    ? 'settling key'
                    : null;
        const transitionNotice = transition ? `
            <div class="mt-3 flex items-start gap-2 rounded-lg border ${transition.phase === 'error'
                ? 'border-destructive/30 bg-destructive/5 text-destructive'
                : transition.phase === 'ready'
                    ? 'border-green-300/60 bg-green-50/60 text-green-800 dark:border-green-500/30 dark:bg-green-500/10 dark:text-green-200'
                    : 'border-amber-300/60 bg-amber-50/60 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100'} p-2 text-[10px] leading-snug">
                <span class="mt-0.5 h-1.5 w-1.5 flex-shrink-0 rounded-full ${transition.phase === 'error' ? 'bg-destructive' : transition.phase === 'ready' ? 'bg-status-success' : 'bg-amber-500 animate-pulse'}"></span>
                <span>${this.escapeHtml(transition.message)}</span>
            </div>` : '';

        return `
            <div class="p-3">
                <div class="flex items-center justify-between">
                    <div class="flex items-center gap-1.5">
                        <svg class="h-3.5 w-3.5 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v12m3-9.5C15 7.12 13.66 6 12 6S9 7.12 9 8.5 10.34 11 12 11s3 1.12 3 2.5S13.66 16 12 16s-3-1.12-3-2.5M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/></svg>
                        <span class="text-xs font-medium">Private balance: <span class="font-semibold">${balance}</span></span>
                    </div>
                    <span class="rounded-full px-2 py-0.5 text-[9px] font-medium ${hasError || transition?.phase === 'error' ? 'bg-destructive/10 text-destructive' : transition ? (transition.phase === 'ready' ? 'badge-status-success' : 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200') : note ? 'badge-status-success' : 'bg-muted text-muted-foreground'}">${hasError ? 'unavailable' : transitionBadge || (note ? `note #${note.note_id}` : 'not funded')}</span>
                </div>
                <div class="mt-3 h-1 overflow-hidden rounded-full bg-muted"><div class="h-full rounded-full bg-blue-600 transition-all" style="width:${percent}%"></div></div>
                <div class="mt-2 flex items-center justify-between text-[10px] text-muted-foreground"><span>${used} used</span><span>${note ? `expires in ${zkapiClient.formatExpiry(note.expiry_ts)}` : 'Fund with MetaMask to chat'}</span></div>
                ${transitionNotice}
                <div class="mt-3 grid ${note ? 'grid-cols-2' : 'grid-cols-1'} gap-1.5">
                    <button id="zkapi-panel-fund" class="btn-ghost-hover inline-flex h-8 items-center justify-center rounded-md border border-border bg-background px-3 text-xs font-medium shadow-sm transition-all">${note ? 'Balance details' : 'Fund with MetaMask'}</button>
                    ${note ? '<button id="zkapi-panel-withdraw" class="btn-ghost-hover inline-flex h-8 items-center justify-center rounded-md border border-border bg-background px-3 text-xs font-medium shadow-sm transition-all">Withdraw</button>' : ''}
                </div>
                ${hasError ? `<p class="mt-2 text-[10px] leading-snug text-destructive">${this.escapeHtml(zkapiClient.lastError.message)}</p>` : ''}
            </div>
            <div class="mx-3 mb-3 rounded-lg border border-border bg-muted/5 p-2">
                <div class="flex items-center gap-2"><span class="inline-flex h-4 w-4 items-center justify-center rounded-full border border-border text-[9px] text-muted-foreground">?</span><span class="flex-1 text-xs font-semibold text-foreground">How zkAPI billing works</span></div>
                <p class="mt-1 text-[10px] leading-snug text-muted-foreground">MetaMask funds a private prepaid note. zkAPI proves available balance without attaching your wallet identity to model requests, then obtains one short-lived OA ephemeral key for this chat. The key is reused for the title, response, and follow-ups until it expires or is settled.</p>
            </div>
        `;
    }

    generateTopSectionHTML() {
        const oa = super.generateTopSectionHTML();
        const marker = '<!-- API Key Panel -->';
        const keyAndProxy = oa.slice(oa.indexOf(marker));
        return `${this.billingSectionHTML()}${keyAndProxy}`;
    }

    getMissingApiKeyStatus() {
        const transition = this.app.newChatSettlementState;
        if (transition?.phase === 'settling' || transition?.phase === 'waiting') {
            return {
                label: 'Closing previous chat key',
                badge: 'Settling',
                badgeClass: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200'
            };
        }
        if (transition?.phase === 'ready') {
            return {
                label: 'Previous key closed · fresh key requested on send',
                badge: 'Ready',
                badgeClass: 'badge-status-success'
            };
        }
        if (transition?.phase === 'error') {
            return {
                label: 'Previous key could not be closed',
                badge: 'Action needed',
                badgeClass: 'bg-destructive/10 text-destructive'
            };
        }
        return super.getMissingApiKeyStatus();
    }

    attachTopSectionEventListeners() {
        // Preserve OA's ephemeral-key, verifier, and network-proxy controls.
        super.attachTopSectionEventListeners();
        document.getElementById('zkapi-panel-fund')?.addEventListener('click', () => {
            this.app.accountModal?.open?.(zkapiClient.note ? 'balance' : 'fund');
        });
        document.getElementById('zkapi-panel-withdraw')?.addEventListener('click', () => {
            this.app.accountModal?.open?.('withdraw');
        });
    }

    async handleRenewApiKey() {
        if (this.isRenewingKey || !this.currentSession) return;
        this.isRenewingKey = true;
        this.renderTopSectionOnly();
        try {
            this.app.services.inference.clearAccessInfo(this.currentSession);
            await this.app.data.saveSession(this.currentSession);
            await this.app.acquireAndSetAccess(this.currentSession);
            this.loadSessionData();
        } catch (error) {
            this.app.showToast?.(error.message || 'Could not refresh the private key.', 'error');
        } finally {
            this.isRenewingKey = false;
            this.renderTopSectionOnly();
        }
    }

    applyInvitationCodeFromLink() {
        this.app.accountModal?.open?.('fund');
    }

    destroy() {
        this.zkapiUnsubscribe?.();
        this.zkapiUnsubscribe = null;
        super.destroy();
    }
}
