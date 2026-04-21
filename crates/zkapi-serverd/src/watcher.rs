//! Challenge planner for stale escape-withdrawal disputes.
//!
//! The actual chain transport is deployment-specific, but the protocol logic
//! lives here: given a pending withdrawal nullifier and a Merkle sibling path
//! for the zeroed note slot, reconstruct the exact challenge payload from the
//! archived request proof previously finalized by the server.

use std::sync::Arc;

use zkapi_types::{Felt252, RequestPublicInputs, MERKLE_DEPTH};

use crate::nullifier_store::{NullifierStore, TranscriptRecord};

/// Fully reconstructed challenge action for `challengeEscapeWithdrawal`.
#[derive(Debug, Clone)]
pub struct ChallengeAction {
    pub note_id: u32,
    pub request_inputs: RequestPublicInputs,
    pub proof_envelope: Vec<u8>,
    pub siblings: [Felt252; MERKLE_DEPTH],
}

/// Builds challenge payloads from archived finalized transcripts.
pub struct ChallengeWatcher {
    store: Arc<NullifierStore>,
}

impl ChallengeWatcher {
    /// Create a new challenge watcher backed by the given nullifier store.
    pub fn new(store: Arc<NullifierStore>) -> Self {
        Self { store }
    }

    /// Return the archived finalized transcript for a nullifier, if present.
    pub fn finalized_transcript(&self, nullifier: &Felt252) -> Option<TranscriptRecord> {
        let record = self.store.lookup_by_nullifier(nullifier)?;
        (record.status == zkapi_types::NullifierStatus::Finalized).then_some(record)
    }

    /// Build the calldata needed to challenge a stale escape withdrawal.
    pub fn build_challenge_action(
        &self,
        note_id: u32,
        nullifier: &Felt252,
        siblings: [Felt252; MERKLE_DEPTH],
    ) -> Result<ChallengeAction, String> {
        let record = self
            .finalized_transcript(nullifier)
            .ok_or_else(|| "no finalized transcript for nullifier".to_string())?;

        let request_inputs_json = record
            .request_inputs_json
            .ok_or_else(|| "missing archived request inputs".to_string())?;
        let request_inputs: RequestPublicInputs = serde_json::from_str(&request_inputs_json)
            .map_err(|e| format!("invalid archived request inputs: {}", e))?;
        if request_inputs.request_nullifier != *nullifier {
            return Err("archived request nullifier mismatch".to_string());
        }

        let proof_envelope = record
            .proof_blob
            .ok_or_else(|| "missing archived proof blob".to_string())?;

        Ok(ChallengeAction {
            note_id,
            request_inputs,
            proof_envelope,
            siblings,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use zkapi_types::NullifierStatus;

    use crate::nullifier_store::TranscriptRecord;

    #[test]
    fn test_build_challenge_action_from_archived_transcript() {
        let store = Arc::new(NullifierStore::in_memory().unwrap());
        let watcher = ChallengeWatcher::new(store.clone());

        let nullifier = Felt252::from_u64(42);
        store
            .reserve(&nullifier, "req-1", &Felt252::from_u64(9))
            .unwrap();

        let request_inputs = RequestPublicInputs {
            statement_type: 1,
            protocol_version: 1,
            chain_id: 1,
            contract_address: Felt252::from_u64(0xdead),
            active_root: Felt252::from_u64(11),
            state_sig_epoch: 0,
            state_sig_root: Felt252::ZERO,
            request_nullifier: nullifier,
            anon_commitment_x: Felt252::from_u64(1),
            anon_commitment_y: Felt252::from_u64(2),
            expiry_ts: 100,
            solvency_bound: 10,
        };

        store
            .finalize(
                &nullifier,
                &TranscriptRecord {
                    nullifier,
                    status: NullifierStatus::Finalized,
                    client_request_id: Some("req-1".into()),
                    payload_hash: Some(Felt252::from_u64(9)),
                    charge_applied: Some(1),
                    response_code: Some(200),
                    response_payload: Some("{\"ok\":true}".into()),
                    response_hash: Some(Felt252::from_u64(9)),
                    next_commitment_x: Some(Felt252::from_u64(3)),
                    next_commitment_y: Some(Felt252::from_u64(4)),
                    next_anchor: Some(Felt252::from_u64(5)),
                    blind_delta_srv: Some(Felt252::from_u64(6)),
                    next_state_sig_epoch: Some(1),
                    next_state_sig_root: Some(Felt252::from_u64(7)),
                    next_state_sig: None,
                    policy_reason_code: None,
                    policy_evidence_hash: None,
                    proof_blob: Some(vec![1, 2, 3]),
                    request_inputs_json: Some(serde_json::to_string(&request_inputs).unwrap()),
                    created_at: 0,
                    finalized_at: Some(1),
                },
            )
            .unwrap();

        let action = watcher
            .build_challenge_action(9, &nullifier, [Felt252::ZERO; MERKLE_DEPTH])
            .unwrap();
        assert_eq!(action.note_id, 9);
        assert_eq!(action.request_inputs.request_nullifier, nullifier);
        assert_eq!(action.proof_envelope, vec![1, 2, 3]);
    }
}
