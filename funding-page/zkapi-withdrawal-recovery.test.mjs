import assert from 'node:assert/strict';
import test from 'node:test';
import { backgroundWithdrawalClaims, isUnsubmittedParkedMutualWithdrawal } from './services/zkapiWithdrawalRecovery.mjs';

const parked = () => ({ deploymentId: 'test', noteId: 7, mode: 'mutual', phase: 'parked',
    state: { note_id: 7 }, preparedWithdrawal: { mode: 'mutual', phase: 'prepared', noteId: 7 } });

test('only a never-broadcast parked mutual authorization receives immediate legacy repair', () => {
    for (const phase of ['parked', 'restored', 'challenged_unconfirmed', 'recovery_unconfirmed']) {
        assert.equal(isUnsubmittedParkedMutualWithdrawal({ ...parked(), phase,
            challengeObservedBlock: 200, finalityCheckedBlock: 100, lastObservedBlock: 200,
            finalitySource: 'finalized', error: 'The escape was challenged.' }), true);
    }
    for (const patch of [{ mode: 'escape' }, { state: { note_id: 8 } },
        { chainStatus: 'closed' }, { chainStatus: 'pending_withdrawal' }, { phase: 'submitted_unconfirmed' }]) {
        assert.equal(isUnsubmittedParkedMutualWithdrawal({ ...parked(), ...patch }), false);
    }
});

test('no live wallet, transaction or challenge evidence can be mistaken for canceled preparation', () => {
    const evidence = {
        transactionHash: '0x1', submissionId: 'claim', startSubmissionId: 'claim',
        finalizeSubmissionId: 'claim', finalizeTransactionHash: '0x1', startRetryNonce: 0,
        submissionNonce: 0, startSubmissionNonce: 0, startBlockNumber: 1,
        closeBlockNumber: 1, challengeDeadline: 1, closedAt: 1,
        transactionHashes: ['0x1'], transactionAttempts: [{}],
        supersededStartSubmissionClaims: [{}], ambiguousStartReplacements: [{}],
        ambiguousReplacements: [{}], finalizeAttempts: [{}], startRecoveryPending: true,
        submissionOutcome: 'result_unknown', startSubmissionOutcome: 'receipt_missing'
    };
    for (const [field, value] of Object.entries(evidence)) {
        for (const nested of [false, true]) {
            const record = parked();
            (nested ? record.preparedWithdrawal : record)[field] = value;
            assert.equal(isUnsubmittedParkedMutualWithdrawal(record), false, `${nested ? 'plan' : 'record'}.${field}`);
        }
    }
    assert.equal(isUnsubmittedParkedMutualWithdrawal(parked(), [{ deploymentId: 'test', noteId: 7, status: 'submitted' }]), false);
    assert.equal(isUnsubmittedParkedMutualWithdrawal(parked(), [{ deploymentId: 'test', noteId: 8, status: 'submitted' }]), true);
    assert.equal(isUnsubmittedParkedMutualWithdrawal(parked(), [{ deploymentId: 'test', noteId: 7, status: 'reverted' }]), true);
});

test('older ambiguous claim journals only borrow a sender from their exact operation and nonce', () => {
    const from = `0x${'11'.repeat(20)}`;
    const record = { startRetryFrom: from, startRetryNonce: 0, startRetryOperationId: 'old',
        ambiguousStartReplacements: [{ operationId: 'old', submissionId: 'A', nonce: 0 },
            { operationId: 'different', submissionId: 'B', nonce: 0 }],
        preparedWithdrawal: { operationId: 'old', ambiguousReplacements: [{ submissionId: 'C', nonce: 0 }] } };
    const claims = backgroundWithdrawalClaims(record);
    assert.equal(claims.find(claim => claim.submissionId === 'A').from, from);
    assert.equal(claims.find(claim => claim.submissionId === 'C').from, from);
    assert.equal(claims.find(claim => claim.submissionId === 'B').from, null);
    record.transactionAttempts = [{ operationId: 'old', nonce: 0, from: `0x${'22'.repeat(20)}` }];
    assert.equal(backgroundWithdrawalClaims(record).find(claim => claim.submissionId === 'A').from, null);
});
