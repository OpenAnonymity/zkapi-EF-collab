import { AccountModal, WelcomePanel } from '../../oa-chat/chat/publicApi.js';
import ZkapiAccountModal from '../components/AccountModal.js';
import PaymentModeRightPanel from '../components/PaymentModeRightPanel.js';
import { createZkapiUi } from './createZkapiUi.js';
import { updateZkapiBalanceControl } from '../components/ZkapiStateExperience.js';

/** Keep the normal OA account and history; expose funding once in the toolbar. */
export function createPaymentModeUi(runtime) {
    const zkUi = createZkapiUi(runtime);
    let app;
    let privateBalance;
    let fundingButton;
    let modeControl;
    let previousMode;

    const openFunding = () => {
        if (runtime.getMode() === 'zkapi') privateBalance?.open();
        else app?.rightPanel?.show();
    };

    function renderControls() {
        if (!app || !modeControl) return;
        const mode = runtime.getMode();
        const busy = runtime.isModeLocked();
        modeControl.setAttribute('aria-busy', runtime.isSwitching() ? 'true' : 'false');
        for (const button of modeControl.querySelectorAll('[data-payment-mode]')) {
            button.setAttribute('aria-pressed', String(button.dataset.paymentMode === mode));
            button.disabled = busy;
            button.title = busy ? 'Finish or stop the current response to switch payment methods.'
                : `Use ${button.dataset.paymentMode === 'zkapi' ? 'zkAPI' : 'tickets'} for this chat and new chats. Your history stays the same.`;
        }
        if (mode !== previousMode) {
            fundingButton.innerHTML = '<span class="account-tab-dot" aria-hidden="true"></span><span data-private-balance-label></span>';
            fundingButton.onclick = openFunding;
            previousMode = mode;
        }
        if (mode === 'zkapi') updateZkapiBalanceControl(fundingButton, app);
        else {
            const count = app.services.tickets?.getTicketCount() || 0;
            fundingButton.querySelector('[data-private-balance-label]').textContent = `${count} ticket${count === 1 ? '' : 's'}`;
            fundingButton.dataset.status = count ? 'logged-in' : 'none';
            fundingButton.title = 'Manage inference tickets';
            fundingButton.setAttribute('aria-label', `${count} inference tickets. Manage tickets`);
            fundingButton.setAttribute('aria-busy', 'false');
        }
    }

    return {
        integration: { ...zkUi.integration, getMode: session => runtime.getMode(session) },
        components: {
            accountModal(facade) {
                app = facade;
                const account = new AccountModal(facade);
                // This runtime capability is invoked by zkAPI preflight. Its
                // destination must not change when the user navigates away.
                account.openFunding = () => privateBalance?.open('fund');
                return account;
            },
            welcomePanel(facade) {
                // First paint stays in chat so both methods are discoverable.
                // The existing ticket onboarding remains available on demand.
                const welcome = new WelcomePanel(facade);
                welcome.init = async () => {};
                return welcome;
            },
            rightPanel: facade => new PaymentModeRightPanel(facade)
        },
        mountShell() {
            document.getElementById('chat-toolbar').classList.add('payment-mode-toolbar');
            const panelToggle = document.getElementById('show-right-panel-btn');
            modeControl = document.createElement('div');
            modeControl.className = 'payment-mode-control';
            modeControl.setAttribute('role', 'group');
            modeControl.setAttribute('aria-label', 'Chat payment method');
            modeControl.innerHTML = '<button type="button" id="payment-mode-tickets" data-payment-mode="tickets" aria-pressed="false">Tickets</button><button type="button" id="payment-mode-zkapi" data-payment-mode="zkapi" aria-pressed="false">zkAPI</button>';
            modeControl.addEventListener('click', async event => {
                const button = event.target.closest('[data-payment-mode]');
                if (!button || button.disabled) return;
                try { await runtime.changeMode(button.dataset.paymentMode); }
                catch (error) { app.showToast(error.message || 'Could not switch payment method. Please try again.', 'error'); }
                renderControls();
            });
            fundingButton = document.createElement('button');
            fundingButton.id = 'payment-funding-btn';
            fundingButton.type = 'button';
            fundingButton.className = 'zkapi-private-balance-control payment-funding-control';
            panelToggle.before(modeControl, fundingButton);
            const overlay = document.createElement('div');
            overlay.id = 'payment-balance-modal';
            overlay.className = document.getElementById('account-modal').className;
            overlay.classList.add('hidden');
            document.body.append(overlay);
            privateBalance = new ZkapiAccountModal(app, { triggerId: 'payment-funding-btn', overlayId: 'payment-balance-modal' });
            // Wallet notifications update only the active funding control.
            privateBalance.updateTabIndicator = renderControls;
            window.addEventListener('tickets-updated', renderControls);
            for (const id of ['scrubber-shortcut-hint', 'scrubber-preview-hint', 'scrubber-settings-section',
                'memory-settings-section', 'memory-context-toggle', 'parallel-settings-section',
                'council-inline-models', 'chat-mode-toggle']) {
                const element = document.getElementById(id);
                if (element) { element.hidden = true; element.inert = true; element.style.display = 'none'; }
            }
            renderControls();
        },
        presentation: {
            getPendingPresentation: (phase, progress) => runtime.getMode() === 'zkapi'
                ? zkUi.presentation.getPendingPresentation(phase, progress) : null,
            getModelPricing: model => runtime.getMode() === 'zkapi'
                ? zkUi.presentation.getModelPricing(model) : null,
            getSessionStatus: session => runtime.getSessionStatus(session),
            renderComposer: renderControls
        }
    };
}
