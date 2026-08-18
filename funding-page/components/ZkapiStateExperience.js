import zkapiClient from '../services/zkapiClient.js';
import { deriveZkapiUxState } from '../services/zkapiUxState.mjs';

function escapeFallback(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

export function getZkapiExperience(app, sessionId = app?.state?.currentSessionId) {
    return deriveZkapiUxState({
        snapshot: zkapiClient.snapshot(),
        transition: app?.newChatSettlementState || null,
        sessionId
    });
}

function stateGlyph(primary) {
    if (primary.tone === 'working') {
        return '<span class="zkapi-state-spinner" aria-hidden="true"></span>';
    }
    if (primary.tone === 'error') {
        return '<span class="zkapi-state-glyph zkapi-state-glyph--error" aria-hidden="true">!</span>';
    }
    if (primary.tone === 'success') {
        return '<span class="zkapi-state-glyph zkapi-state-glyph--success" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="m3.25 8.25 3 3 6.5-6.5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.6"/></svg></span>';
    }
    return '<span class="zkapi-state-glyph" aria-hidden="true"></span>';
}

function renderJourney(state, escapeHtml = escapeFallback, compact = false) {
    return `
        <ol class="zkapi-journey ${compact ? 'zkapi-journey--compact' : ''}" aria-label="Private chat progress">
            ${state.journey.map((step, index) => `
                <li class="zkapi-journey-step" data-state="${step.state}" ${step.state === 'active' ? 'aria-current="step"' : ''}>
                    <span class="zkapi-journey-marker" aria-hidden="true">${step.state === 'complete' ? '✓' : index + 1}</span>
                    <span class="zkapi-journey-label">${escapeHtml(step.label)}</span>
                </li>`).join('')}
        </ol>`;
}

function activityStatus(activity) {
    if (activity.status === 'success') return 'Done';
    if (activity.status === 'error') return 'Needs attention';
    if (activity.status === 'canceled') return 'Canceled';
    return 'In progress';
}

function renderActivityRows(state, escapeHtml = escapeFallback, limit = 4) {
    const rows = state.activities.slice(-limit).reverse();
    if (!rows.length) {
        return '<p class="zkapi-activity-empty">Private balance activity will appear here.</p>';
    }
    return `<ul class="zkapi-activity-list">${rows.map(activity => `
        <li class="zkapi-activity-row" data-status="${activity.status}">
            <span class="zkapi-activity-indicator" aria-hidden="true"></span>
            <span class="zkapi-activity-copy">
                <strong>${escapeHtml(activity.title || 'Private balance')}</strong>
                <small>${escapeHtml(activity.error || activity.message || activityStatus(activity))}</small>
            </span>
            <span class="zkapi-activity-state">${activityStatus(activity)}</span>
        </li>`).join('')}</ul>`;
}

export function renderZkapiPanelExperience(state, escapeHtml = escapeFallback) {
    const { primary, proposal } = state;
    if (proposal === 'guided') {
        return `
            <section class="zkapi-panel-experience zkapi-panel-experience--guided" aria-label="Private chat status">
                <div class="zkapi-panel-state-heading">
                    ${stateGlyph(primary)}
                    <div><strong>${escapeHtml(primary.title)}</strong><p>${escapeHtml(primary.detail)}</p></div>
                </div>
                ${renderJourney(state, escapeHtml)}
            </section>`;
    }
    if (proposal === 'activity') {
        return `
            <section class="zkapi-panel-experience zkapi-panel-experience--activity" aria-label="Private balance activity">
                <div class="zkapi-panel-state-heading">
                    ${stateGlyph(primary)}
                    <div><strong>Private activity</strong><p>${escapeHtml(primary.compact)}</p></div>
                    ${state.runningActivities.length ? `<span class="zkapi-running-count">${state.runningActivities.length} active</span>` : ''}
                </div>
                ${renderActivityRows(state, escapeHtml)}
            </section>`;
    }
    if (!state.showComposer && primary.tone !== 'error') return '';
    return `
        <section class="zkapi-panel-experience zkapi-panel-experience--quiet" aria-label="Private chat status">
            <div class="zkapi-panel-state-heading">
                ${stateGlyph(primary)}
                <div><strong>${escapeHtml(primary.title)}</strong><p>${escapeHtml(primary.detail)}</p></div>
            </div>
        </section>`;
}

function showActivityPanel(app) {
    const panel = app?.rightPanel;
    if (!panel) return;
    panel.show?.();
    panel.loadSessionData?.();
}

export function renderZkapiComposerStatus(element, app) {
    if (!element) return;
    const state = getZkapiExperience(app);
    const { primary, proposal } = state;
    if (!state.showComposer) {
        element.className = 'hidden';
        element.innerHTML = '';
        element.removeAttribute('aria-busy');
        return;
    }

    element.className = `zkapi-composer-state zkapi-composer-state--${proposal}`;
    element.setAttribute('aria-busy', primary.busy ? 'true' : 'false');
    if (proposal === 'guided') {
        element.innerHTML = `
            <div class="zkapi-composer-guided-heading">
                ${stateGlyph(primary)}
                <span><strong>${escapeFallback(primary.title)}</strong><small>${escapeFallback(primary.detail)}</small></span>
            </div>
            ${renderJourney(state, escapeFallback, true)}`;
    } else if (proposal === 'activity') {
        element.innerHTML = `
            <div class="zkapi-composer-inline">
                ${stateGlyph(primary)}
                <span class="zkapi-composer-copy"><strong>${escapeFallback(primary.compact)}</strong><small>${escapeFallback(primary.detail)}</small></span>
                <button type="button" data-zkapi-open-activity>View activity</button>
            </div>`;
        element.querySelector('[data-zkapi-open-activity]')?.addEventListener('click', () => showActivityPanel(app));
    } else {
        element.innerHTML = `
            <div class="zkapi-composer-inline">
                ${stateGlyph(primary)}
                <span class="zkapi-composer-copy"><strong>${escapeFallback(primary.compact)}</strong><small>${escapeFallback(primary.detail)}</small></span>
            </div>`;
    }
}

export function updateZkapiBalanceControl(button, app) {
    if (!button) return;
    const state = getZkapiExperience(app);
    const { primary, note } = state;
    const label = button.querySelector('[data-private-balance-label]');
    let status = note ? 'logged-in' : 'none';
    let text = note ? zkapiClient.formatMoney(note.current_balance) : 'Private balance';
    if (primary.tone === 'working') {
        status = 'busy';
        text = primary.compact;
    } else if (primary.tone === 'error') {
        status = 'attention';
        text = 'Payment needs attention';
    } else if (primary.phase === 'escape-wait' || primary.phase === 'withdrawal') {
        status = 'waiting';
        text = primary.compact;
    }
    button.dataset.status = status;
    button.title = `${primary.title}. ${primary.detail}`;
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-busy', primary.busy ? 'true' : 'false');
    if (label) label.textContent = text;
}
