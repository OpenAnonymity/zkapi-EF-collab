import AccountModal from '../components/AccountModal.js';
import WelcomePanel from '../components/WelcomePanel.js';
import RightPanel from '../components/RightPanel.js';
import { renderZkapiComposerStatus, updateZkapiBalanceControl } from '../components/ZkapiStateExperience.js';
import { derivePendingIndicatorPresentation } from '../domain/streamingState.js';
import { formatModelPricing, formatExactTokenPricing } from '../services/modelPricing.mjs';
import { mountZkapiShell } from '../components/ZkapiShell.js';

/** Compose payment surfaces with the shared OA renderer. No shared UI source is
 * copied or patched by the build, and no wallet material enters the chat UI API. */
export function createZkapiUi(runtime) {
    let componentApp = null;
    const capture = (app, Component) => {
        componentApp = app;
        return new Component(app);
    };
    const integration = {
        getTransition: () => runtime.getTransition?.() || null,
        getSessionUsageSummary: session => runtime.getSessionUsageSummary?.(session) || null
    };
    return {
        integration,
        mountShell() {
            const balance = mountZkapiShell();
            if (balance && componentApp) updateZkapiBalanceControl(balance, componentApp);
        },
        components: {
            accountModal: app => capture(app, AccountModal),
            welcomePanel: app => capture(app, WelcomePanel),
            rightPanel: app => capture(app, RightPanel)
        },
        presentation: {
            getPendingPresentation(phase, progress) {
                const paymentPhase = phase === 'preparing-access'
                    ? progress?.kind === 'settlement' ? 'settling-previous' : 'requesting-key'
                    : phase;
                return derivePendingIndicatorPresentation(paymentPhase, progress);
            },
            getModelPricing(model) {
                return {
                    label: formatModelPricing(model?.pricing) || 'Pricing unavailable',
                    description: formatExactTokenPricing(model?.pricing)
                        || 'The provider did not publish token pricing for this model.'
                };
            },
            getSessionStatus: session => runtime.getSessionStatus?.(session) || null,
            renderComposer() {
                if (!componentApp) return;
                let status = document.getElementById('zkapi-composer-status');
                if (!status) {
                    const actions = document.querySelector('.composer-bottom-actions');
                    if (actions) {
                        status = document.createElement('div');
                        status.id = 'zkapi-composer-status';
                        status.className = 'hidden';
                        status.setAttribute('aria-live', 'off');
                        actions.before(status);
                    }
                }
                renderZkapiComposerStatus(status, componentApp);
                const balanceButton = document.getElementById('account-tab-btn');
                if (balanceButton) updateZkapiBalanceControl(balanceButton, componentApp);
            }
        }
    };
}

export default createZkapiUi;
