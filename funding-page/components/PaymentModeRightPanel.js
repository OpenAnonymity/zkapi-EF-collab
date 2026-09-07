import { RightPanel as TicketRightPanel } from '../../oa-chat/chat/publicApi.js';
import ZkapiRightPanel from './RightPanel.js';

export default class PaymentModeRightPanel extends ZkapiRightPanel {
    isTicketMode() {
        return this.app.integration.getMode(this.currentSession) === 'tickets';
    }

    handleZkapiChange(detail) {
        if (!this.isTicketMode()) super.handleZkapiChange(detail);
    }

    loadSessionData() {
        return this.isTicketMode()
            ? TicketRightPanel.prototype.loadSessionData.call(this)
            : super.loadSessionData();
    }

    generateFundingSectionHTML() {
        return this.isTicketMode()
            ? TicketRightPanel.prototype.generateFundingSectionHTML.call(this)
            : super.generateFundingSectionHTML();
    }

    getMissingApiKeyStatus() {
        return this.isTicketMode()
            ? TicketRightPanel.prototype.getMissingApiKeyStatus.call(this)
            : super.getMissingApiKeyStatus();
    }

    handleRenewApiKey() {
        return this.isTicketMode()
            ? TicketRightPanel.prototype.handleRenewApiKey.call(this)
            : super.handleRenewApiKey();
    }

    applyInvitationCodeFromLink(...args) {
        return TicketRightPanel.prototype.applyInvitationCodeFromLink.call(this, ...args);
    }

    onRuntimePresentationChange() {
        const mode = this.app.integration.getMode();
        if (this.paymentMode !== mode) {
            this.paymentMode = mode;
            this.currentSession = this.app.getCurrentSession();
            this.loadSessionData();
        }
        if (mode === 'zkapi') super.onRuntimePresentationChange();
    }
}
