import zkapiClient from '../services/zkapiClient.js';
import { updateZkapiBalanceControl } from './ZkapiStateExperience.js';

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
        this.unsubscribe = zkapiClient.subscribe((_snapshot, detail) => {
            if (detail?.reason === 'clock') return;
            this.updateTabIndicator();
            // An unfunded modal contains an editable amount. Rebuilding it on
            // background refreshes resets that value and steals input focus.
            // Mutating actions render once from run() after they complete.
            if (this.isOpen && !this.busy && zkapiClient.note
                && !this.overlay?.contains(document.activeElement)) this.render();
        });
        this.clockUnsubscribe = zkapiClient.subscribeClock(({ now } = {}) => {
            this.handleZkapiClock(now);
        });
        this.attachTabListener();
        this.updateTabIndicator();
        void zkapiClient.init().catch(() => this.updateTabIndicator());

        window.addEventListener('zkapi-payment-required', (event) => {
            this.open(event.detail?.view || 'fund');
        });
    }

    attachTabListener() {
        const tabBtn = document.getElementById('account-tab-btn');
        if (tabBtn) tabBtn.onclick = () => this.isOpen ? this.close() : this.open();
    }

    updateTabIndicator() {
        const tabBtn = document.getElementById('account-tab-btn');
        if (!tabBtn) return;
        updateZkapiBalanceControl(tabBtn, this.app);
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

    handleZkapiClock(now = Date.now()) {
        if (!this.isOpen || !this.overlay) return;
        const setText = (element, value) => {
            if (element && element.textContent !== value) element.textContent = value;
        };

        const noteExpiry = this.overlay.querySelector('[data-zkapi-balance-expiry]');
        if (noteExpiry && zkapiClient.note) {
            setText(noteExpiry, `expires in ${zkapiClient.formatExpiry(zkapiClient.note.expiry_ts)}`);
        }
        const leaseExpiry = this.overlay.querySelector('[data-zkapi-active-lease-expiry]');
        const rawLease = zkapiClient.config?.active_lease;
        if (leaseExpiry && rawLease) {
            setText(leaseExpiry, zkapiClient.formatExpiry(rawLease.expires_at));
        }

        const withdrawal = zkapiClient.withdrawal;
        if (this.view !== 'withdraw' || withdrawal?.phase !== 'pending') return;
        const deadline = Number(withdrawal.challengeDeadline || 0);
        const clockNow = Number.isFinite(Number(now)) ? Number(now) : Date.now();
        const ready = deadline > 0 && clockNow >= deadline * 1000;
        const remaining = zkapiClient.formatExpiry(deadline);
        setText(
            this.overlay.querySelector('[data-zkapi-escape-countdown]'),
            ready ? 'The safety window is complete.' : `Finalize in ${remaining}.`
        );
        const finalizeButton = this.overlay.querySelector('#zkapi-finalize-btn');
        if (finalizeButton) {
            setText(finalizeButton, ready ? 'Finalize in MetaMask' : `Finalize in ${remaining}`);
            finalizeButton.disabled = !ready || this.busy;
        }
    }

    async run(action, activityDetails = null) {
        if (this.busy) return;
        this.busy = true;
        this.render();
        const activityId = activityDetails
            ? zkapiClient.beginActivity(activityDetails.kind, {
                ...activityDetails,
                message: activityDetails.message || 'Starting…'
            })
            : null;
        const report = (message, phase = null) => {
            this.setStatus(message);
            if (activityId) zkapiClient.updateActivity(activityId, {
                message,
                ...(phase ? { phase } : {})
            });
        };
        try {
            await action(report);
            if (activityId) zkapiClient.completeActivity(activityId, {
                message: this.status || 'Complete.'
            });
            this.app.showToast?.(this.status || 'Private balance updated.', 'success', 5000);
        } catch (error) {
            const rejected = error?.code === 4001;
            this.setStatus(rejected
                ? 'MetaMask canceled the transaction. No funds moved; you can safely try again.'
                : error.shortMessage || error.message || String(error), !rejected);
            if (activityId) {
                if (rejected) zkapiClient.cancelActivity(activityId, this.status);
                else zkapiClient.failActivity(activityId, error);
            }
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
        const tokenSymbol = this.escapeHtml(zkapiClient.billingTokenSymbol);
        const mainnetWarning = zkapiClient.isMainnetFunding
            ? '<div class="rounded-lg border border-amber-300/70 bg-amber-50/70 p-3 text-[11px] leading-relaxed text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100"><strong>Ethereum Mainnet:</strong> this deposits real USDC into experimental, unaudited zkAPI contracts and uses real ETH for gas. Private Merkle-tree updates are unusually gas-heavy on L1; zkAPI does not set the gas limit or fee rate, so review MetaMask’s maximum before confirming. Only use funds you can afford to lose.</div>'
            : '';
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
                    ${mainnetWarning}
                    ${zkapiClient.config?.funding?.demo_mint_enabled ? '<p class="text-[11px] text-muted-foreground">Sepolia demo billing tokens are minted automatically if your wallet needs them. You only pay testnet gas.</p>' : ''}
                    <button id="zkapi-deposit-btn" class="zkapi-primary-button w-full" type="button" ${this.busy ? 'disabled' : ''}>
                        ${this.busy ? 'Waiting for MetaMask…' : 'Continue with MetaMask'}
                    </button>
                    <button id="zkapi-watch-token-btn" class="zkapi-secondary-button w-full" type="button" ${this.busy ? 'disabled' : ''}>Add ${tokenSymbol} to MetaMask</button>
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
                        <span class="badge-status-success rounded-full px-2 py-1 text-[10px] font-medium">Ready</span>
                    </div>
                    <div class="mt-4 h-1.5 overflow-hidden rounded-full bg-muted"><div class="h-full rounded-full bg-blue-600" style="width:${percent}%"></div></div>
                    <div class="mt-2 flex justify-between text-[11px] text-muted-foreground"><span>${zkapiClient.formatMoney(spent)} used</span><span data-zkapi-balance-expiry>expires in ${zkapiClient.formatExpiry(note.expiry_ts)}</span></div>
                </div>
                ${zkapiClient.withdrawalBlocksChat ? '<div class="rounded-lg border border-amber-300/60 bg-amber-50/60 p-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">A withdrawal is prepared or pending. Finish it before sending another message.</div>' : ''}
                ${zkapiClient.activeLease ? `<div class="rounded-lg border border-blue-300/60 bg-blue-50/60 p-3 text-xs text-blue-800 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-200"><p>The current chat key can be settled now; there is no need to wait <span data-zkapi-active-lease-expiry>${zkapiClient.formatExpiry(zkapiClient.activeLease.expires_at)}</span> for expiry.</p><button id="zkapi-settle-key-btn" class="zkapi-secondary-button mt-3 w-full" type="button" ${this.busy ? 'disabled' : ''}>Settle key now</button></div>` : ''}
                <div class="grid grid-cols-2 gap-2">
                    <button id="zkapi-refresh-btn" class="zkapi-secondary-button" type="button" ${this.busy ? 'disabled' : ''}>Refresh</button>
                    <button id="zkapi-withdraw-view-btn" class="zkapi-secondary-button" type="button" ${this.busy ? 'disabled' : ''}>Withdraw</button>
                </div>
                <div class="grid ${zkapiClient.config?.funding?.demo_mint_enabled ? 'grid-cols-2' : 'grid-cols-1'} gap-2">
                    <button id="zkapi-watch-token-btn" class="zkapi-secondary-button" type="button" ${this.busy ? 'disabled' : ''}>Add ${tokenSymbol} to MetaMask</button>
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
                        <p class="mt-2 text-xs leading-relaxed text-muted-foreground">Your note is frozen. <span data-zkapi-escape-countdown>${ready ? 'The safety window is complete.' : `Finalize in ${zkapiClient.formatExpiry(deadline)}.`}</span></p>
                    </div>
                    <dl class="zkapi-details">
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
                    <span class="text-xs text-muted-foreground">Private balance</span>
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
            return this.run(async (report) => {
                await zkapiClient.deposit(amount, report);
                this.depositAmount = null;
                this.view = 'balance';
                this.setStatus('Deposit confirmed. Your private balance is ready.');
            }, { kind: 'deposit', title: 'Adding funds', phase: 'wallet', message: 'Connecting to MetaMask…', blocksSend: true });
        });
        this.overlay.querySelector('#zkapi-watch-token-btn')?.addEventListener('click', () => this.run(async (report) => {
            await zkapiClient.addBillingTokenToWallet(report);
        }, { kind: 'token', title: 'Adding token to MetaMask', phase: 'wallet' }));
        this.overlay.querySelector('#zkapi-mint-token-btn')?.addEventListener('click', () => this.run(async (report) => {
            await zkapiClient.mintDemoTokens('10', report);
        }, { kind: 'token', title: 'Getting test ZKAPI', phase: 'wallet' }));
        this.overlay.querySelector('#zkapi-refresh-btn')?.addEventListener('click', () => this.run(async (report) => {
            report('Reading the latest private balance…', 'syncing');
            await zkapiClient.refresh();
            this.setStatus('Private balance refreshed.');
        }, { kind: 'refresh', title: 'Refreshing balance', phase: 'syncing' }));
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
        withdrawButton?.addEventListener('click', () => this.run(async (report) => {
            const result = await zkapiClient.withdraw(this.withdrawMode, report);
            this.setStatus(result.status === 'closed'
                ? `${zkapiClient.formatMoney(result.event.finalBalance)} returned to MetaMask.`
                : `Escape started. Finalize after ${new Date(result.deadline * 1000).toLocaleString()}.`);
        }, {
            kind: this.withdrawMode === 'escape' ? 'escape' : 'withdraw',
            title: this.withdrawMode === 'escape' ? 'Starting account recovery' : 'Returning your balance',
            phase: 'settling',
            blocksSend: true
        }));
        this.overlay.querySelector('#zkapi-sync-withdrawal-btn')?.addEventListener('click', () => this.run(async (report) => {
            await zkapiClient.syncWithdrawal(report);
        }, { kind: 'withdraw-sync', title: 'Checking withdrawal', phase: 'syncing', blocksSend: true }));
        this.overlay.querySelector('#zkapi-finalize-btn')?.addEventListener('click', () => this.run(async (report) => {
            const result = await zkapiClient.finalizeEscape(report);
            this.view = 'balance';
            this.setStatus(`${zkapiClient.formatMoney(result.event.finalBalance)} returned to MetaMask.`);
        }, { kind: 'escape-finalize', title: 'Finishing account recovery', phase: 'wallet', blocksSend: true }));
    }
}
