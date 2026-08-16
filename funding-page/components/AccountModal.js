import zkapiClient from '../services/zkapiClient.js';

const MODAL_CLASSES = 'w-full max-w-md rounded-xl border border-border bg-background shadow-2xl mx-4 flex flex-col overflow-hidden';

export default class AccountModal {
    constructor(app) {
        this.app = app;
        this.isOpen = false;
        this.overlay = document.getElementById('account-modal');
        this.view = 'balance';
        this.withdrawMode = 'mutual';
        this.busy = false;
        this.status = '';
        this.statusError = false;
        this.depositAmount = null;
        this.returnFocusEl = null;
        this.escapeHandler = null;
        this.unsubscribe = zkapiClient.subscribe(() => {
            this.updateTabIndicator();
            // An unfunded modal contains an editable amount. Rebuilding it on
            // background refreshes resets that value and steals input focus.
            // Mutating actions render once from run() after they complete.
            if (this.isOpen && !this.busy && zkapiClient.note
                && !this.overlay?.contains(document.activeElement)) this.render();
        });
        this.attachTabListener();
        this.updateTabIndicator();
        void zkapiClient.init().catch(() => this.updateTabIndicator());

        window.addEventListener('zkapi-payment-required', () => this.open('fund'));
    }

    attachTabListener() {
        const tabBtn = document.getElementById('account-tab-btn');
        if (tabBtn) tabBtn.onclick = () => this.isOpen ? this.close() : this.open();
    }

    updateTabIndicator() {
        const tabBtn = document.getElementById('account-tab-btn');
        if (!tabBtn) return;
        const note = zkapiClient.note;
        tabBtn.dataset.status = note ? 'logged-in' : 'none';
        tabBtn.title = note
            ? `Private balance: ${zkapiClient.formatMoney(note.current_balance)}`
            : 'Fund a private balance with MetaMask';
        const label = tabBtn.querySelector('[data-private-balance-label]');
        if (label) label.textContent = note
            ? zkapiClient.formatMoney(note.current_balance)
            : 'Private balance';
    }

    open(view = 'balance') {
        if (!this.overlay) return;
        this.view = view;
        this.isOpen = true;
        this.returnFocusEl = document.activeElement;
        this.status = '';
        this.statusError = false;
        this.render();
        this.overlay.classList.remove('hidden');
        document.getElementById('account-tab-btn')?.setAttribute('aria-expanded', 'true');
        this.overlay.onclick = event => { if (event.target === this.overlay && !this.busy) this.close(); };
        this.escapeHandler = event => { if (event.key === 'Escape' && !this.busy) this.close(); };
        document.addEventListener('keydown', this.escapeHandler);
        void zkapiClient.refresh({ quiet: true });
    }

    openFunding() {
        this.open('fund');
    }

    openWithdrawal() {
        this.open('withdraw');
        void zkapiClient.syncWithdrawal(() => {}).catch(() => {});
    }

    close() {
        if (!this.isOpen || this.busy) return;
        this.isOpen = false;
        this.overlay.classList.add('hidden');
        this.overlay.innerHTML = '';
        document.getElementById('account-tab-btn')?.setAttribute('aria-expanded', 'false');
        if (this.escapeHandler) document.removeEventListener('keydown', this.escapeHandler);
        this.escapeHandler = null;
        this.returnFocusEl?.focus?.();
        this.returnFocusEl = null;
    }

    escapeHtml(value) {
        const div = document.createElement('div');
        div.textContent = value == null ? '' : String(value);
        return div.innerHTML;
    }

    setStatus(message, isError = false) {
        this.status = message;
        this.statusError = isError;
        const withdrawalAmount = this.overlay?.querySelector('[data-withdraw-amount]');
        if (withdrawalAmount && zkapiClient.note) {
            withdrawalAmount.textContent = zkapiClient.formatMoney(zkapiClient.note.current_balance);
        }
        if (!zkapiClient.activeLease) {
            this.overlay?.querySelector('[data-active-lease-notice]')?.remove();
        }
        const element = this.overlay?.querySelector('[data-payment-status]');
        if (element) {
            element.textContent = message;
            element.classList.toggle('text-destructive', isError);
            element.classList.toggle('text-muted-foreground', !isError);
            element.classList.toggle('hidden', !message);
        }
    }

    async run(action) {
        if (this.busy) return;
        this.busy = true;
        this.render();
        try {
            await action();
            this.app.showToast?.(this.status || 'Private balance updated.', 'success', 5000);
        } catch (error) {
            const rejected = error?.code === 4001;
            this.setStatus(rejected
                ? 'MetaMask canceled the transaction. No funds moved; you can safely try again.'
                : error.shortMessage || error.message || String(error), !rejected);
            this.app.showToast?.(this.status, 'error', 6000);
        } finally {
            this.busy = false;
            this.render();
        }
    }

    progressPercent(note) {
        if (!note?.deposit_amount) return 0;
        return Math.max(0, Math.min(100,
            Number(note.current_balance) / Number(note.deposit_amount) * 100));
    }

    renderBalance() {
        const note = zkapiClient.note;
        if (!note) {
            const depositAmount = this.depositAmount
                ?? zkapiClient.suggestedDeposit.toFixed(zkapiClient.suggestedDeposit < 0.01 ? 6 : 2);
            return `
                <div class="p-5 space-y-4">
                    <div class="rounded-lg border border-border bg-muted/20 p-4">
                        <p class="text-sm font-medium text-foreground">Fund once, chat privately</p>
                        <p class="mt-1 text-xs leading-relaxed text-muted-foreground">MetaMask deposits billing tokens into a private prepaid note. The note secret and chat history remain on this machine.</p>
                    </div>
                    <label class="block">
                        <span class="text-xs font-medium text-foreground">Deposit amount</span>
                        <div class="mt-1.5 flex h-10 items-center rounded-lg border border-input bg-background px-3 input-focus-clean">
                            <span class="text-sm text-muted-foreground">$</span>
                            <input id="zkapi-deposit-amount" class="min-w-0 flex-1 bg-transparent px-1 text-sm text-foreground outline-none" inputmode="decimal" value="${this.escapeHtml(depositAmount)}" />
                        </div>
                    </label>
                    ${zkapiClient.config?.funding?.demo_mint_enabled ? '<p class="text-[11px] text-muted-foreground">Sepolia demo billing tokens are minted automatically if your wallet needs them. You only pay testnet gas.</p>' : ''}
                    <button id="zkapi-deposit-btn" class="zkapi-primary-button w-full" type="button" ${this.busy ? 'disabled' : ''}>
                        ${this.busy ? 'Waiting for MetaMask…' : 'Continue with MetaMask'}
                    </button>
                    <button id="zkapi-watch-token-btn" class="zkapi-secondary-button w-full" type="button" ${this.busy ? 'disabled' : ''}>Add ZKAPI to MetaMask</button>
                </div>`;
        }

        const spent = Math.max(0, Number(note.deposit_amount) - Number(note.current_balance));
        const percent = this.progressPercent(note);
        return `
            <div class="p-5 space-y-4">
                <div class="zkapi-balance-card">
                    <div class="flex items-start justify-between gap-3">
                        <div>
                            <p class="text-xs text-muted-foreground">Available</p>
                            <p class="mt-1 text-2xl font-semibold tracking-tight text-foreground">${zkapiClient.formatMoney(note.current_balance)}</p>
                        </div>
                        <span class="badge-status-success rounded-full px-2 py-1 text-[10px] font-medium">Private note #${note.note_id}</span>
                    </div>
                    <div class="mt-4 h-1.5 overflow-hidden rounded-full bg-muted"><div class="h-full rounded-full bg-blue-600" style="width:${percent}%"></div></div>
                    <div class="mt-2 flex justify-between text-[11px] text-muted-foreground"><span>${zkapiClient.formatMoney(spent)} used</span><span>expires in ${zkapiClient.formatExpiry(note.expiry_ts)}</span></div>
                </div>
                ${zkapiClient.withdrawalBlocksChat ? '<div class="rounded-lg border border-amber-300/60 bg-amber-50/60 p-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">A withdrawal is prepared or pending. Finish it before sending another message.</div>' : ''}
                ${zkapiClient.activeLease ? `<div class="rounded-lg border border-blue-300/60 bg-blue-50/60 p-3 text-xs text-blue-800 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-200"><p>The current chat key can be settled now; there is no need to wait ${zkapiClient.formatExpiry(zkapiClient.activeLease.expires_at)} for expiry.</p><button id="zkapi-settle-key-btn" class="zkapi-secondary-button mt-3 w-full" type="button" ${this.busy ? 'disabled' : ''}>Settle key now</button></div>` : ''}
                <div class="grid grid-cols-2 gap-2">
                    <button id="zkapi-refresh-btn" class="zkapi-secondary-button" type="button" ${this.busy ? 'disabled' : ''}>Refresh</button>
                    <button id="zkapi-withdraw-view-btn" class="zkapi-secondary-button" type="button" ${this.busy ? 'disabled' : ''}>Withdraw</button>
                </div>
                <div class="grid ${zkapiClient.config?.funding?.demo_mint_enabled ? 'grid-cols-2' : 'grid-cols-1'} gap-2">
                    <button id="zkapi-watch-token-btn" class="zkapi-secondary-button" type="button" ${this.busy ? 'disabled' : ''}>Add ZKAPI to MetaMask</button>
                    ${zkapiClient.config?.funding?.demo_mint_enabled ? `<button id="zkapi-mint-token-btn" class="zkapi-secondary-button" type="button" ${this.busy ? 'disabled' : ''}>Get 10 test ZKAPI</button>` : ''}
                </div>
                <dl class="zkapi-details">
                    <div><dt>Network</dt><dd>${zkapiClient.networkName()}</dd></div>
                    <div><dt>Request mode</dt><dd>${zkapiClient.isDirectMode ? 'Prompt-private' : 'Server proxy'}</dd></div>
                    <div><dt>Vault</dt><dd>${zkapiClient.compact(zkapiClient.config?.funding?.contract_address, 8)}</dd></div>
                </dl>
            </div>`;
    }

    renderWithdrawal() {
        const note = zkapiClient.note;
        const withdrawal = zkapiClient.withdrawal;
        if (!note && withdrawal?.phase !== 'pending') {
            return '<div class="p-5 text-sm text-muted-foreground">There is no active private note to withdraw.</div>';
        }

        if (withdrawal?.phase === 'pending') {
            const deadline = Number(withdrawal.challengeDeadline || 0);
            const ready = deadline > 0 && Date.now() >= deadline * 1000;
            return `
                <div class="p-5 space-y-4">
                    <div class="rounded-lg border border-blue-300/60 bg-blue-50/60 p-4 dark:border-blue-500/30 dark:bg-blue-500/10">
                        <div class="flex items-center justify-between gap-3">
                            <p class="text-sm font-medium text-foreground">Escape hatch pending</p>
                            <span class="rounded-full bg-blue-600 px-2 py-1 text-[10px] font-semibold text-white">${zkapiClient.escapePeriodBadge()}</span>
                        </div>
                        <p class="mt-2 text-xs leading-relaxed text-muted-foreground">Your note is frozen. ${ready ? 'The safety window is complete.' : `Finalize in ${zkapiClient.formatExpiry(deadline)}.`}</p>
                    </div>
                    <dl class="zkapi-details">
                        <div><dt>Note</dt><dd>#${withdrawal.noteId}</dd></div>
                        <div><dt>Destination</dt><dd>${zkapiClient.compact(withdrawal.destination, 9)}</dd></div>
                        <div><dt>Ready</dt><dd>${deadline ? new Date(deadline * 1000).toLocaleString() : 'Checking…'}</dd></div>
                    </dl>
                    <button id="zkapi-finalize-btn" class="zkapi-primary-button w-full" type="button" ${!ready || this.busy ? 'disabled' : ''}>${ready ? 'Finalize in MetaMask' : `Finalize in ${zkapiClient.formatExpiry(deadline)}`}</button>
                    <button id="zkapi-sync-withdrawal-btn" class="zkapi-secondary-button w-full" type="button" ${this.busy ? 'disabled' : ''}>Check on-chain status</button>
                </div>`;
        }

        const activeLease = zkapiClient.activeLease;
        const preparedMode = zkapiClient.config?.prepared_withdrawal?.mode;
        if (preparedMode === 'escape') this.withdrawMode = 'escape';
        return `
            <div class="p-5 space-y-4">
                <div class="flex items-center justify-between rounded-lg border border-border bg-muted/20 px-4 py-3">
                    <div><p class="text-xs text-muted-foreground">Amount returned</p><p data-withdraw-amount class="mt-0.5 text-lg font-semibold text-foreground">${zkapiClient.formatMoney(note?.current_balance)}</p></div>
                    <span class="text-xs text-muted-foreground">Note #${note?.note_id ?? '—'}</span>
                </div>
                <fieldset class="space-y-2" ${this.busy ? 'disabled' : ''}>
                    <legend class="mb-2 text-xs font-medium text-foreground">Withdrawal method</legend>
                    <label class="zkapi-choice ${this.withdrawMode === 'mutual' ? 'selected' : ''}">
                        <input type="radio" name="zkapi-withdraw-mode" value="mutual" ${this.withdrawMode === 'mutual' ? 'checked' : ''} ${preparedMode === 'escape' ? 'disabled' : ''} />
                        <span><strong>Mutual close</strong><small>Fastest. The zkAPI server co-signs the close.</small></span>
                    </label>
                    <label class="zkapi-choice ${this.withdrawMode === 'escape' ? 'selected' : ''}">
                        <input type="radio" name="zkapi-withdraw-mode" value="escape" ${this.withdrawMode === 'escape' ? 'checked' : ''} />
                        <span><strong>Escape hatch</strong><small>Unilateral recovery. Start now, wait ${zkapiClient.escapePeriodPhrase()}, then finalize.</small></span>
                    </label>
                </fieldset>
                <label class="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground"><input id="zkapi-withdraw-confirm" class="mt-0.5" type="checkbox" /> <span>I understand that withdrawing closes this private note and pauses chat until the flow is complete.</span></label>
                ${activeLease ? '<p data-active-lease-notice class="rounded-lg border border-blue-300/60 bg-blue-50/60 p-3 text-xs text-blue-800 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-200">The active chat key will settle automatically before withdrawal.</p>' : ''}
                <button id="zkapi-withdraw-btn" class="zkapi-primary-button w-full" type="button" disabled>${this.withdrawMode === 'mutual' ? 'Close note and withdraw' : `Start ${zkapiClient.escapePeriodLabel()} escape`}</button>
                <button id="zkapi-back-balance-btn" class="zkapi-secondary-button w-full" type="button" ${this.busy ? 'disabled' : ''}>Back to balance</button>
            </div>`;
    }

    render() {
        if (!this.overlay) return;
        const title = this.view === 'withdraw' ? 'Withdraw private balance' : 'Private balance';
        const subtitle = this.view === 'withdraw'
            ? 'Return the remaining note balance to MetaMask'
            : 'OA Chat · private prepaid access';
        this.overlay.innerHTML = `
            <div role="dialog" aria-modal="true" aria-labelledby="zkapi-payment-title" class="${MODAL_CLASSES}">
                <div class="flex items-start justify-between border-b border-border px-5 py-4">
                    <div><h2 id="zkapi-payment-title" class="text-base font-semibold text-foreground">${title}</h2><p class="mt-0.5 text-xs text-muted-foreground">${subtitle}</p></div>
                    <button id="zkapi-payment-close" class="btn-ghost-hover inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:text-foreground" type="button" aria-label="Close">
                        <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg>
                    </button>
                </div>
                <div class="max-h-[75vh] overflow-y-auto">${this.view === 'withdraw' ? this.renderWithdrawal() : this.renderBalance()}</div>
                <p data-payment-status class="${this.status ? '' : 'hidden'} border-t border-border px-5 py-3 text-xs ${this.statusError ? 'text-destructive' : 'text-muted-foreground'}">${this.escapeHtml(this.status)}</p>
            </div>`;

        this.overlay.querySelector('#zkapi-payment-close')?.addEventListener('click', () => this.close());
        const depositInput = this.overlay.querySelector('#zkapi-deposit-amount');
        depositInput?.addEventListener('input', () => {
            this.depositAmount = depositInput.value;
        });
        this.overlay.querySelector('#zkapi-deposit-btn')?.addEventListener('click', () => {
            // Capture the edited amount before run() marks the modal busy and
            // re-renders it with the suggested default value.
            const amount = depositInput?.value ?? this.depositAmount;
            this.depositAmount = amount;
            return this.run(async () => {
                await zkapiClient.deposit(amount, message => this.setStatus(message));
                this.depositAmount = null;
                this.view = 'balance';
                this.setStatus('Deposit confirmed. Your private balance is ready.');
            });
        });
        this.overlay.querySelector('#zkapi-watch-token-btn')?.addEventListener('click', () => this.run(async () => {
            await zkapiClient.addBillingTokenToWallet(message => this.setStatus(message));
        }));
        this.overlay.querySelector('#zkapi-mint-token-btn')?.addEventListener('click', () => this.run(async () => {
            await zkapiClient.mintDemoTokens('10', message => this.setStatus(message));
        }));
        this.overlay.querySelector('#zkapi-refresh-btn')?.addEventListener('click', () => this.run(async () => {
            await zkapiClient.refresh();
            this.setStatus('Private balance refreshed.');
        }));
        this.overlay.querySelector('#zkapi-settle-key-btn')?.addEventListener('click', () => this.run(async () => {
            await zkapiClient.settleActiveLease(message => this.setStatus(message));
            this.setStatus('Private key settled. Balance updated.');
        }));
        this.overlay.querySelector('#zkapi-withdraw-view-btn')?.addEventListener('click', () => {
            this.view = 'withdraw';
            this.render();
        });
        this.overlay.querySelector('#zkapi-back-balance-btn')?.addEventListener('click', () => {
            this.view = 'balance';
            this.render();
        });
        this.overlay.querySelectorAll('input[name="zkapi-withdraw-mode"]').forEach(input => {
            input.addEventListener('change', () => {
                this.withdrawMode = input.value;
                this.render();
            });
        });
        const confirm = this.overlay.querySelector('#zkapi-withdraw-confirm');
        const withdrawButton = this.overlay.querySelector('#zkapi-withdraw-btn');
        confirm?.addEventListener('change', () => {
            withdrawButton.disabled = !confirm.checked || this.busy;
        });
        withdrawButton?.addEventListener('click', () => this.run(async () => {
            const result = await zkapiClient.withdraw(this.withdrawMode, message => this.setStatus(message));
            this.setStatus(result.status === 'closed'
                ? `${zkapiClient.formatMoney(result.event.finalBalance)} returned to MetaMask.`
                : `Escape started. Finalize after ${new Date(result.deadline * 1000).toLocaleString()}.`);
        }));
        this.overlay.querySelector('#zkapi-sync-withdrawal-btn')?.addEventListener('click', () => this.run(async () => {
            await zkapiClient.syncWithdrawal(message => this.setStatus(message));
        }));
        this.overlay.querySelector('#zkapi-finalize-btn')?.addEventListener('click', () => this.run(async () => {
            const result = await zkapiClient.finalizeEscape(message => this.setStatus(message));
            this.view = 'balance';
            this.setStatus(`${zkapiClient.formatMoney(result.event.finalBalance)} returned to MetaMask.`);
        }));
    }
}
