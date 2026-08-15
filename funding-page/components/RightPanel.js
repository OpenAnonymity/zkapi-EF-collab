import zkapiClient from '../services/zkapiClient.js';

const RIGHT_PANEL_WIDTH = 288;

export default class RightPanel {
    constructor(app) {
        this.app = app;
        this.currentSession = app.getCurrentSession?.() || null;
        this.isDesktop = window.innerWidth >= 1024;
        const saved = localStorage.getItem('oa-right-panel-visible');
        this.isVisible = saved === 'true' ? true : saved === 'false' ? false : this.isDesktop;
        this.unsubscribe = zkapiClient.subscribe(() => this.render());
        this.resizeHandler = () => {
            this.isDesktop = window.innerWidth >= 1024;
            this.updatePanelVisibility();
        };
        window.addEventListener('resize', this.resizeHandler);
    }

    mount() {
        this.render();
        this.updatePanelVisibility();
        void zkapiClient.init().catch(() => this.render());
    }

    onSessionChange(session) {
        this.currentSession = session;
        this.render();
    }

    renderTopSectionOnly() {
        this.render();
    }

    openFunding() {
        this.app.accountModal?.open?.('fund');
    }

    applyInvitationCodeFromLink() {
        this.openFunding();
    }

    escapeHtml(value) {
        const div = document.createElement('div');
        div.textContent = value == null ? '' : String(value);
        return div.innerHTML;
    }

    sessionStatus() {
        const lease = zkapiClient.activeLease;
        if (!this.currentSession) return 'Start a chat to create a private session key.';
        if (!lease) return 'The first request in this chat creates a bounded ephemeral key.';
        if (lease.session_id === this.currentSession.id) {
            return `This chat reuses one bounded key for its title, response, and follow-ups. ${zkapiClient.formatExpiry(lease.expires_at)} remaining.`;
        }
        return `Another chat owns the current key for ${zkapiClient.formatExpiry(lease.expires_at)}.`;
    }

    render() {
        const panel = document.getElementById('right-panel-content');
        if (!panel) return;
        const note = zkapiClient.note;
        const funding = zkapiClient.config?.funding || {};
        const remaining = note ? zkapiClient.formatMoney(note.current_balance) : '$0.00';
        const percent = note?.deposit_amount
            ? Math.max(0, Math.min(100, Number(note.current_balance) / Number(note.deposit_amount) * 100))
            : 0;
        const modeTitle = zkapiClient.isDirectMode ? 'Prompt-private' : 'Server proxy';
        const modeDetail = zkapiClient.isDirectMode
            ? 'Prompts go from this machine to the provider with a bounded key.'
            : 'The zkAPI server proxies request content in this mode.';
        const hasError = !!zkapiClient.lastError;

        panel.innerHTML = `
            <div style="min-height:calc(3rem + 1px)" class="px-3 bg-muted/10 flex items-center">
                <div class="flex items-center justify-between w-full">
                    <h2 class="text-sm font-semibold text-foreground">System Panel</h2>
                    <button id="close-right-panel" class="inline-flex items-center justify-center rounded-md transition-colors hover-highlight text-muted-foreground hover:text-foreground h-9 w-9 cursor-pointer select-none" aria-label="Hide system panel">
                        <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4V4Z" fill="currentColor" fill-opacity=".15" stroke="none"/><path d="M14 4v16"/></svg>
                    </button>
                </div>
            </div>
            <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
                <section class="border-b border-border p-3">
                    <div class="flex items-center justify-between">
                        <div class="flex items-center gap-1.5"><span class="zkapi-status-dot ${hasError ? 'error' : 'online'}"></span><span class="text-xs font-medium text-foreground">${hasError ? 'Daemon unavailable' : modeTitle}</span></div>
                        <span class="text-[10px] text-muted-foreground">local</span>
                    </div>
                    <p class="mt-2 text-[11px] leading-relaxed text-muted-foreground">${hasError ? this.escapeHtml(zkapiClient.lastError.message) : modeDetail}</p>
                </section>
                <section class="border-b border-border p-3">
                    <div class="rounded-lg border border-border bg-muted/10 p-3">
                        <div class="flex items-center justify-between"><span class="text-xs text-muted-foreground">Private balance</span><span class="${note ? 'badge-status-success' : 'bg-muted text-muted-foreground'} rounded-full px-2 py-0.5 text-[9px] font-medium">${note ? `note #${note.note_id}` : 'not funded'}</span></div>
                        <p class="mt-1 text-xl font-semibold tracking-tight text-foreground">${remaining}</p>
                        <div class="mt-3 h-1 overflow-hidden rounded-full bg-muted"><div class="h-full rounded-full bg-blue-600" style="width:${percent}%"></div></div>
                        <div class="mt-3 grid ${note ? 'grid-cols-2' : 'grid-cols-1'} gap-2">
                            <button id="zkapi-panel-fund" class="zkapi-primary-button" type="button">${note ? 'Details' : 'Fund with MetaMask'}</button>
                            ${note ? '<button id="zkapi-panel-withdraw" class="zkapi-secondary-button" type="button">Withdraw</button>' : ''}
                        </div>
                    </div>
                </section>
                <section class="border-b border-border p-3">
                    <div class="flex items-center gap-1.5">
                        <svg class="h-3.5 w-3.5 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 5.25a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.5 20.25a7.5 7.5 0 0 1 15 0"/></svg>
                        <h3 class="text-xs font-medium text-foreground">Private session</h3>
                    </div>
                    <p class="mt-2 text-[11px] leading-relaxed text-muted-foreground">${this.sessionStatus()}</p>
                    ${this.currentSession ? `<p class="mt-2 break-all font-mono text-[9px] text-muted-foreground/70">${this.escapeHtml(this.currentSession.id)}</p>` : ''}
                </section>
                <section class="flex-1 p-3">
                    <div class="flex items-center gap-1.5"><svg class="h-3.5 w-3.5 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/></svg><h3 class="text-xs font-medium text-foreground">Payment state</h3></div>
                    <dl class="zkapi-panel-details mt-3">
                        <div><dt>Network</dt><dd>${zkapiClient.networkName()}</dd></div>
                        <div><dt>Expires</dt><dd>${note ? zkapiClient.formatExpiry(note.expiry_ts) : '—'}</dd></div>
                        <div><dt>Vault</dt><dd>${zkapiClient.compact(funding.contract_address, 6)}</dd></div>
                        <div><dt>Indexer</dt><dd>${zkapiClient.config ? 'connected' : 'checking'}</dd></div>
                        <div><dt>Withdrawal</dt><dd>${zkapiClient.withdrawal?.phase || 'ready'}</dd></div>
                    </dl>
                    <p class="mt-5 text-center text-[9px] text-muted-foreground/60">OA Chat UI · zkAPI payment adapter · MIT</p>
                </section>
            </div>`;

        panel.querySelector('#close-right-panel')?.addEventListener('click', () => this.hide());
        panel.querySelector('#zkapi-panel-fund')?.addEventListener('click', () => this.app.accountModal?.open?.(note ? 'balance' : 'fund'));
        panel.querySelector('#zkapi-panel-withdraw')?.addEventListener('click', () => this.app.accountModal?.open?.('withdraw'));
    }

    show() {
        this.isVisible = true;
        localStorage.setItem('oa-right-panel-visible', 'true');
        this.updatePanelVisibility();
        this.render();
    }

    hide() {
        this.isVisible = false;
        localStorage.setItem('oa-right-panel-visible', 'false');
        this.updatePanelVisibility();
    }

    toggle() {
        if (this.isVisible) this.hide();
        else this.show();
    }

    closeRightPanel() {
        this.hide();
    }

    updatePanelVisibility() {
        const panel = document.getElementById('right-panel');
        const app = document.getElementById('app');
        const showButton = document.getElementById('show-right-panel-btn');
        if (!panel) return;

        document.documentElement.toggleAttribute('data-right-panel-hidden', !this.isVisible);
        panel.classList.toggle('right-panel-visible', this.isVisible);
        panel.style.width = this.isVisible ? `${RIGHT_PANEL_WIDTH}px` : '0px';
        panel.style.minWidth = this.isVisible ? `${RIGHT_PANEL_WIDTH}px` : '0px';
        panel.style.borderLeftWidth = this.isVisible ? '1px' : '0px';
        panel.setAttribute('aria-hidden', this.isVisible ? 'false' : 'true');
        app?.classList.toggle('right-panel-open', this.isVisible && this.isDesktop);
        showButton?.classList.toggle('system-panel-toggle-visible', !this.isVisible);
    }
}
