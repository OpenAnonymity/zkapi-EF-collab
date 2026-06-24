//! Main request processing logic.
//!
//! Follows the server flow from spec section 9.3:
//! 1. Validate public inputs against config
//! 2. Verify the proof envelope and replay the witness locally
//! 3. Reserve nullifier
//! 4. Execute provider call
//! 5. Compute charge, anchor, blind delta, next commitment
//! 6. Sign the next state
//! 7. Finalize transcript
//! 8. Return response
//!
//! Registration is implicit and handled here: a genesis note (carrying
//! `state_sig_epoch == 0`) is accepted on its first request without requiring
//! a prior server state signature; the server then signs and returns the first
//! real state, which every subsequent request must build on. The matching
//! client side that constructs the genesis request lives in Rasul's
//! `zkapi-client` wallet.

use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use zkapi_core::commitment::{compute_blind_delta, compute_next_anchor, compute_state_message};
use zkapi_core::poseidon::{felt_to_field, field_to_felt};
use zkapi_crypto::pedersen::PedersenCommitment;
use zkapi_proof::verify_request_proof;
use zkapi_types::wire::{
    ApiRequest, ClearanceRequest, ClearanceResponse, CurvePointWire, ProofBackendWire,
    RecoveryResponse, RequestResponse,
};
use zkapi_types::{Felt252, NullifierStatus, STATEMENT_TYPE_REQUEST};

use crate::config::ServerConfig;
use crate::error::ServerError;
use crate::nullifier_store::{NullifierStore, TranscriptRecord};
use crate::provider::ApiProvider;
use crate::signer::ServerSigner;

/// The main request processor for the zkAPI server.
pub struct RequestProcessor {
    config: ServerConfig,
    store: Arc<NullifierStore>,
    signer: Arc<ServerSigner>,
    provider: Arc<dyn ApiProvider>,
    current_root: Arc<RwLock<Felt252>>,
}

#[derive(Debug, Clone, Copy)]
struct PreparedNextState {
    blind_delta_felt: Felt252,
    next_anchor: Felt252,
    next_cx: Felt252,
    next_cy: Felt252,
}

impl RequestProcessor {
    /// Create a new request processor.
    pub fn new(
        config: ServerConfig,
        store: Arc<NullifierStore>,
        signer: Arc<ServerSigner>,
        provider: Arc<dyn ApiProvider>,
        current_root: Felt252,
    ) -> Self {
        Self {
            config,
            store,
            signer,
            provider,
            current_root: Arc::new(RwLock::new(current_root)),
        }
    }

    /// Update the current Merkle root (called when the indexer detects a new root).
    pub fn update_root(&self, new_root: Felt252) {
        if let Ok(mut root) = self.current_root.write() {
            *root = new_root;
        }
    }

    /// Get the current Merkle root.
    pub fn current_root(&self) -> Felt252 {
        self.current_root
            .read()
            .map(|r| *r)
            .unwrap_or(Felt252::ZERO)
    }

    /// Get the published state-signing root.
    pub fn state_sig_root(&self) -> Felt252 {
        self.signer.state_root()
    }

    /// Get the published clearance-signing root.
    pub fn clear_sig_root(&self) -> Felt252 {
        self.signer.clear_root()
    }

    /// Get the state-signing epoch.
    pub fn state_sig_epoch(&self) -> u32 {
        self.signer.epoch()
    }

    /// Get the clearance-signing epoch.
    pub fn clear_sig_epoch(&self) -> u32 {
        self.signer.clear_epoch()
    }

    /// Get the remaining capacity in the state-signing XMSS tree.
    pub fn state_signatures_remaining(&self) -> u32 {
        self.signer.state_remaining()
    }

    /// Get the remaining capacity in the clearance-signing XMSS tree.
    pub fn clear_signatures_remaining(&self) -> u32 {
        self.signer.clear_remaining()
    }

    /// Process an API request following spec section 9.3.
    ///
    /// Returns either a successful RequestResponse or a ServerError.
    pub async fn process_request(
        &self,
        api_request: &ApiRequest,
    ) -> Result<RequestResponse, ServerError> {
        let pi = &api_request.public_inputs;

        // Step 1: Validate protocol version
        if pi.protocol_version != self.config.protocol_version {
            return Err(ServerError::ProtocolMismatch(format!(
                "expected protocol_version={}, got {}",
                self.config.protocol_version, pi.protocol_version
            )));
        }

        // Step 2: Validate chain_id
        if pi.chain_id != self.config.chain_id {
            return Err(ServerError::ProtocolMismatch(format!(
                "expected chain_id={}, got {}",
                self.config.chain_id, pi.chain_id
            )));
        }

        // Step 3: Validate contract_address
        if pi.contract_address != self.config.contract_address {
            return Err(ServerError::ProtocolMismatch(format!(
                "contract_address mismatch: expected {}, got {}",
                self.config.contract_address, pi.contract_address
            )));
        }

        // Step 4: Check active_root matches current root
        let root = self.current_root();
        if pi.active_root != root {
            return Err(ServerError::StaleRoot {
                latest_root: root.to_hex(),
            });
        }

        // Step 5: Check expiry_ts > now
        let now = current_timestamp();
        if pi.expiry_ts <= now {
            return Err(ServerError::NoteExpired);
        }

        // Step 6: Check solvency_bound matches the active server policy.
        let required_solvency_bound = if self.config.policy_enabled {
            self.config.policy_charge_cap
        } else {
            self.config.request_charge_cap
        };
        if pi.solvency_bound < required_solvency_bound {
            return Err(ServerError::InvalidRequest(format!(
                "solvency_bound {} is less than request_charge_cap {}",
                pi.solvency_bound, required_solvency_bound
            )));
        }

        // Step 7: Validate statement_type
        if pi.statement_type != STATEMENT_TYPE_REQUEST {
            return Err(ServerError::InvalidRequest(format!(
                "expected statement_type={}, got {}",
                STATEMENT_TYPE_REQUEST, pi.statement_type
            )));
        }

        // Step 8: Verify state_sig_epoch/root consistency
        // For genesis (epoch 0), state_sig_root should be zero
        // For later states, epoch should match and root should match signer's root
        if pi.state_sig_epoch != 0 && pi.state_sig_root != self.signer.state_root() {
            return Err(ServerError::InvalidRequest(
                "state_sig_root does not match server's state signing root".to_string(),
            ));
        }

        // Step 9: Verify the opaque proof artifact against the stated public inputs.
        //
        // The wire now carries a structured `ProofArtifactWire` (backend tag,
        // canonical public-output hash, base64 proof blob) rather than an
        // inlined witness envelope. We bind the artifact to the public inputs
        // by checking the public-output hash, then replay the dev witness
        // envelope (this daemon is the local/demo verifier; real Stwo-Cairo
        // verification is the production path documented in the roadmap).
        let artifact = &api_request.proof;
        if artifact.backend != ProofBackendWire::StwoCairo {
            return Err(ServerError::InvalidProof(
                "unsupported proof backend".to_string(),
            ));
        }
        if artifact.public_output_hash != pi.public_output_hash() {
            return Err(ServerError::InvalidProof(
                "proof public_output_hash does not match request public inputs".to_string(),
            ));
        }
        let proof_bytes = base64::engine::general_purpose::STANDARD
            .decode(artifact.proof.as_bytes())
            .map_err(|e| ServerError::InvalidProof(format!("invalid base64 proof: {}", e)))?;
        verify_request_proof(&proof_bytes, pi)
            .map_err(|e| ServerError::InvalidProof(e.to_string()))?;

        // Step 10: Reserve nullifier in store
        match self.store.lookup_by_nullifier(&pi.request_nullifier) {
            Some(existing)
                if existing.client_request_id.as_deref()
                    == Some(&api_request.client_request_id)
                    && existing.payload_hash == Some(api_request.payload_hash)
                    && existing.status == NullifierStatus::Finalized =>
            {
                return build_response_from_record(&existing, &api_request.client_request_id);
            }
            Some(existing)
                if existing.client_request_id.as_deref()
                    == Some(&api_request.client_request_id)
                    && existing.payload_hash == Some(api_request.payload_hash)
                    && existing.status == NullifierStatus::Reserved => {}
            Some(_) => return Err(ServerError::Replay),
            None => self.store.reserve(
                &pi.request_nullifier,
                &api_request.client_request_id,
                &api_request.payload_hash,
            )?,
        }

        // Step 11: Execute the upstream provider call.
        let provider_response = self
            .provider
            .execute(
                &api_request.client_request_id,
                &api_request.payload,
                &api_request.payload_hash,
            )
            .await?;
        let response_code = provider_response.status_code;
        let response_payload = provider_response.payload;
        let response_hash = provider_response.response_hash;
        let charge = provider_response.charge_applied;

        // Step 12: Enforce the charge cap before signing a next state.
        //
        // The higher policy cap applies only when the upstream actually flags
        // the response (a policy_reason_code is present) on a policy-enabled
        // deployment; an ordinary response is always bounded by the normal
        // per-request cap, so enabling policy does not let the server slash
        // every request.
        let policy_charged =
            self.config.policy_enabled && provider_response.policy_reason_code.is_some();
        let max_charge = if policy_charged {
            self.config.policy_charge_cap
        } else {
            self.config.request_charge_cap
        };
        if charge > max_charge {
            return Err(ServerError::Internal(format!(
                "provider charge {} exceeds cap {}",
                charge, max_charge
            )));
        }

        // Step 13: Sign next state to get the leaf index for anchor/blind derivation
        // First we need to compute the next commitment, anchor, etc.
        // We need a server RNG value for anchor and blind derivation.
        let server_rng = generate_server_rng(&pi.request_nullifier);
        let server_rng2 = generate_server_rng2(&pi.request_nullifier);

        // Step 14: Compute the next commitment homomorphically.
        //
        // next_commitment = anon_commitment - charge * G_balance + blind_delta * H_blind
        //
        // The anon_commitment comes from the proof's public inputs (anon_commitment_x, anon_commitment_y).
        let anon_point = reconstruct_affine_point(&pi.anon_commitment_x, &pi.anon_commitment_y);

        // We need to sign first to know the leaf_index for blind/anchor computation.
        // We'll use a temporary message, then compute the real one.
        // Actually, the spec says: compute anchor and blind using the sig leaf_index.
        // We need to sign a preliminary message and the leaf_index determines anchor/blind.
        // The state message depends on next_commitment and anchor, but anchor depends on leaf_index
        // and next_commitment depends on blind_delta which depends on leaf_index.
        // So we must get the leaf_index first by signing.

        // Sign a placeholder to consume the leaf index; we build the real signature below.
        // In the XMSS scheme the leaf_index is deterministic from the signer's counter,
        // so we can pre-read it. But the API only exposes sign(). We sign the real message
        // after we compute it.

        // To break the circular dependency:
        // 1. We know the signer will use the next available leaf_index.
        // 2. Compute blind_delta using that index (from server_rng2, nullifier, index).
        // 3. Compute next_commitment from anon_commitment, charge, blind_delta.
        // 4. Compute next_anchor from server_rng, nullifier, next_commitment, index.
        // 5. Compute state_message from next_commitment, next_anchor.
        // 6. Sign the state_message (consuming the leaf index).

        // The XMSS sign() consumes the index atomically, so we sign the final message.
        // We need to predict the next leaf_index. For correctness we rely on the
        // atomic counter inside XmssKeypair. We compute everything using the current
        // "next" index, then sign -- if the index matches, great.

        // For simplicity: sign the state message in one step.
        // We compute blind_delta with a "predicted" leaf index = 0-based counter.
        // But we don't expose the counter. Instead, we compute everything, sign,
        // and verify the leaf_index matches.

        // Actually, sign() returns (sig, leaf_index). We sign, then backfill anchor/blind.
        // This means we need to compute anchor/blind after signing. But the state message
        // depends on anchor, which depends on the leaf_index from signing.
        // The solution: sign a "pre-image commitment" and use the returned leaf_index.

        // Spec section 9.3 approach: the server signs the state message which includes
        // the next_commitment and next_anchor. But next_anchor depends on the leaf_index.
        // The spec resolves this by computing anchor/blind from the leaf_index, then
        // building the message, then signing. The signer's sign() method is the only
        // way to get the leaf_index, but it also consumes a key.
        //
        // We solve this with a two-phase approach: the sign() function returns the
        // leaf_index used, so we compute everything with that index afterwards.
        // However, we need the message before we can sign.
        //
        // Resolution: We pre-compute with a temporary leaf_index=0, then correct.
        // OR we accept that the signer's sign method takes the message, and we must
        // know the message before signing.
        //
        // The practical solution: we pre-compute blind_delta and anchor using an
        // estimated leaf_index. Since we control the signer, we can peek at the next
        // index. We'll add a helper for this.
        //
        // For now: use a simple approach -- compute blind_delta with leaf_index=0 placeholder,
        // sign, get real leaf_index, then recompute if needed. In practice the server
        // has exclusive access so the predicted index is reliable.

        // Get blind_delta with the server_rng2
        // We'll compute it without leaf_index first, then include leaf_index after signing.
        // Actually: let's just sign a dummy, get the index, compute everything, then
        // construct the response. The signature is over the state message which includes
        // the final commitment and anchor. We need the right message.

        // Final approach: compute blind and anchor first using a preliminary sign to get
        // the leaf index, but since the XMSS sign consumes the leaf, we do this:
        // 1. Sign the state message. But we need anchor for the message...
        //
        // The spec's actual flow is:
        //   leaf_index is implicitly the next counter value.
        //   blind_delta = Poseidon(DOMAIN_BLIND, rng2, nullifier, leaf_index)
        //   next_commitment = update(anon, charge, blind_delta)
        //   next_anchor = Poseidon(DOMAIN_ANCHOR, rng, nullifier, cx', cy', leaf_index)
        //   m_state = Poseidon(DOMAIN_STATE, version, chain_id, addr, cx', cy', anchor')
        //   sig = XMSS_sign(m_state) -- uses leaf_index internally
        //
        // So we need to know leaf_index before signing. We'll read it from the signer.
        // Since the signer's sign() atomically increments, we need to compute everything
        // before calling sign(). We can get the next index from remaining() math,
        // but that's fragile. Let's just sign and accept the leaf_index from the result.
        //
        // To handle this correctly: compute the state message as a function of leaf_index,
        // then call sign with that message. We get leaf_index from the sign result and
        // verify it matches our prediction.
        //
        let (state_sig, prepared_next_state) = self.signer.sign_next_state(|leaf_index| {
            let blind_delta_felt =
                compute_blind_delta(&server_rng2, &pi.request_nullifier, leaf_index);
            let blind_delta_field = felt_to_field(&blind_delta_felt);

            let updated =
                PedersenCommitment::server_update(&anon_point, charge, &blind_delta_field);
            let (next_cx_field, next_cy_field) = updated.to_affine();
            let next_cx = field_to_felt(&next_cx_field);
            let next_cy = field_to_felt(&next_cy_field);

            let next_anchor = compute_next_anchor(
                &server_rng,
                &pi.request_nullifier,
                &next_cx,
                &next_cy,
                leaf_index,
            );

            let state_msg = compute_state_message(
                self.config.protocol_version,
                self.config.chain_id,
                &self.config.contract_address,
                &next_cx,
                &next_cy,
                &next_anchor,
            );

            (
                state_msg,
                PreparedNextState {
                    blind_delta_felt,
                    next_anchor,
                    next_cx,
                    next_cy,
                },
            )
        })?;

        // Step 17: Finalize transcript
        let transcript = TranscriptRecord {
            nullifier: pi.request_nullifier,
            status: NullifierStatus::Finalized,
            client_request_id: Some(api_request.client_request_id.clone()),
            payload_hash: Some(api_request.payload_hash),
            charge_applied: Some(charge),
            response_code: Some(response_code),
            response_payload: Some(response_payload.clone()),
            response_hash: Some(response_hash),
            next_commitment_x: Some(prepared_next_state.next_cx),
            next_commitment_y: Some(prepared_next_state.next_cy),
            next_anchor: Some(prepared_next_state.next_anchor),
            blind_delta_srv: Some(prepared_next_state.blind_delta_felt),
            next_state_sig_epoch: Some(state_sig.epoch),
            next_state_sig_root: Some(self.signer.state_root()),
            next_state_sig: Some(state_sig.clone()),
            policy_reason_code: provider_response.policy_reason_code,
            policy_evidence_hash: provider_response.policy_evidence_hash,
            proof_blob: Some(proof_bytes.clone()),
            request_inputs_json: serde_json::to_string(&pi).ok(),
            created_at: current_timestamp(),
            finalized_at: Some(current_timestamp()),
        };

        self.store
            .finalize(&pi.request_nullifier, &transcript)
            .map_err(|e| ServerError::Internal(format!("failed to finalize transcript: {}", e)))?;

        // Step 18: Return response
        Ok(RequestResponse {
            status: "ok".to_string(),
            client_request_id: api_request.client_request_id.clone(),
            request_nullifier: pi.request_nullifier,
            response_code,
            response_payload,
            response_hash,
            charge_applied: charge,
            next_commitment: CurvePointWire {
                x: prepared_next_state.next_cx,
                y: prepared_next_state.next_cy,
            },
            next_anchor: prepared_next_state.next_anchor,
            blind_delta_srv: prepared_next_state.blind_delta_felt,
            next_state_sig_epoch: state_sig.epoch,
            next_state_sig_root: self.signer.state_root(),
            next_state_sig: state_sig,
            policy_reason_code: provider_response.policy_reason_code,
            policy_evidence_hash: provider_response.policy_evidence_hash,
        })
    }

    /// Process a clearance request for mutual close.
    ///
    /// 1. Check nullifier not already used
    /// 2. Sign clearance message
    /// 3. Reserve clearance nullifier
    pub fn process_clearance(
        &self,
        clearance_req: &ClearanceRequest,
    ) -> Result<ClearanceResponse, ServerError> {
        let nullifier = &clearance_req.withdrawal_nullifier;

        // Step 1: Check nullifier not already used
        if self.store.lookup_by_nullifier(nullifier).is_some() {
            return Err(ServerError::NullifierUsed);
        }

        // Step 2: Compute clearance message and sign
        let clear_msg = zkapi_core::commitment::compute_clearance_message(
            self.config.protocol_version,
            self.config.chain_id,
            &self.config.contract_address,
            nullifier,
        );

        let (clear_sig, _leaf_index) = self.signer.sign_clearance(&clear_msg)?;

        // Step 3: Reserve clearance nullifier
        self.store.reserve_clearance(nullifier)?;

        Ok(ClearanceResponse {
            status: "ok".to_string(),
            withdrawal_nullifier: *nullifier,
            clear_sig_epoch: clear_sig.epoch,
            clear_sig_root: self.signer.clear_root(),
            clear_sig,
        })
    }

    /// Recovery: look up a transcript by client request ID.
    pub fn recover_by_client_id(
        &self,
        client_request_id: &str,
    ) -> Result<RecoveryResponse, ServerError> {
        match self.store.lookup_by_client_id(client_request_id) {
            Some(record) => Ok(build_recovery_response(&record)),
            None => Ok(RecoveryResponse {
                status: "not_found".to_string(),
                nullifier_status: "unknown".to_string(),
                request_response: None,
            }),
        }
    }

    /// Recovery: look up a transcript by nullifier.
    pub fn recover_by_nullifier(
        &self,
        nullifier: &Felt252,
    ) -> Result<RecoveryResponse, ServerError> {
        match self.store.lookup_by_nullifier(nullifier) {
            Some(record) => Ok(build_recovery_response(&record)),
            None => Ok(RecoveryResponse {
                status: "not_found".to_string(),
                nullifier_status: "unknown".to_string(),
                request_response: None,
            }),
        }
    }

    /// Get a reference to the config.
    pub fn config(&self) -> &ServerConfig {
        &self.config
    }

    /// Get a reference to the store.
    pub fn store(&self) -> &Arc<NullifierStore> {
        &self.store
    }
}

/// Build a RequestResponse from a stored TranscriptRecord (for idempotent retries).
fn build_response_from_record(
    record: &TranscriptRecord,
    client_request_id: &str,
) -> Result<RequestResponse, ServerError> {
    Ok(RequestResponse {
        status: "ok".to_string(),
        client_request_id: client_request_id.to_string(),
        request_nullifier: record.nullifier,
        response_code: record.response_code.unwrap_or(200),
        response_payload: record.response_payload.clone().unwrap_or_default(),
        response_hash: record.response_hash.unwrap_or(Felt252::ZERO),
        charge_applied: record.charge_applied.unwrap_or(0),
        next_commitment: CurvePointWire {
            x: record.next_commitment_x.unwrap_or(Felt252::ZERO),
            y: record.next_commitment_y.unwrap_or(Felt252::ZERO),
        },
        next_anchor: record.next_anchor.unwrap_or(Felt252::ZERO),
        blind_delta_srv: record.blind_delta_srv.unwrap_or(Felt252::ZERO),
        next_state_sig_epoch: record.next_state_sig_epoch.unwrap_or(0),
        next_state_sig_root: record.next_state_sig_root.unwrap_or(Felt252::ZERO),
        next_state_sig: record.next_state_sig.clone().unwrap_or_else(empty_xmss_sig),
        policy_reason_code: record.policy_reason_code,
        policy_evidence_hash: record.policy_evidence_hash,
    })
}

/// Build a RecoveryResponse from a TranscriptRecord.
fn build_recovery_response(record: &TranscriptRecord) -> RecoveryResponse {
    let nullifier_status = match record.status {
        NullifierStatus::Reserved => "reserved".to_string(),
        NullifierStatus::Finalized => "finalized".to_string(),
        NullifierStatus::ClearanceReserved => "clearance_reserved".to_string(),
    };

    let request_response = if record.status == NullifierStatus::Finalized {
        let client_id = record.client_request_id.clone().unwrap_or_default();
        build_response_from_record(record, &client_id).ok()
    } else {
        None
    };

    RecoveryResponse {
        status: "ok".to_string(),
        nullifier_status,
        request_response,
    }
}

/// Reconstruct an affine point from x,y Felt252 coordinates into a ProjectivePoint.
fn reconstruct_affine_point(
    x: &Felt252,
    y: &Felt252,
) -> starknet_types_core::curve::ProjectivePoint {
    let x_field = felt_to_field(x);
    let y_field = felt_to_field(y);
    starknet_types_core::curve::ProjectivePoint::from_affine(x_field, y_field)
        .expect("invalid affine point")
}

/// Generate a deterministic server RNG value from the nullifier (for anchor derivation).
///
/// In production this would use a proper server-side secret + CSPRNG.
/// For the mock implementation we derive it deterministically from the nullifier.
fn generate_server_rng(nullifier: &Felt252) -> Felt252 {
    use zkapi_types::domain::DOMAIN_ANCHOR;
    zkapi_core::poseidon::poseidon_hash(&DOMAIN_ANCHOR, nullifier, &Felt252::from_u64(1))
}

/// Generate a second deterministic server RNG value (for blind delta derivation).
fn generate_server_rng2(nullifier: &Felt252) -> Felt252 {
    use zkapi_types::domain::DOMAIN_BLIND;
    zkapi_core::poseidon::poseidon_hash(&DOMAIN_BLIND, nullifier, &Felt252::from_u64(2))
}

/// Create an empty XMSS signature placeholder.
fn empty_xmss_sig() -> zkapi_types::XmssSignature {
    zkapi_types::XmssSignature {
        epoch: 0,
        leaf_index: 0,
        wots_sig: vec![Felt252::ZERO; zkapi_types::WOTS_LEN],
        auth_path: vec![Felt252::ZERO; zkapi_types::XMSS_TREE_HEIGHT],
    }
}

/// Get the current UNIX timestamp in seconds.
fn current_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;

    use zkapi_core::poseidon::FieldElement;

    use crate::provider::EchoProvider;

    fn test_processor(store: Arc<NullifierStore>) -> RequestProcessor {
        let signer = Arc::new(ServerSigner::with_height(
            FieldElement::from(1u64),
            FieldElement::from(2u64),
            1,
            4,
        ));
        RequestProcessor::new(
            ServerConfig::default(),
            store,
            signer,
            Arc::new(EchoProvider::new(1)),
            Felt252::ZERO,
        )
    }

    #[test]
    fn test_recovery_returns_original_response_payload() {
        let store = Arc::new(NullifierStore::in_memory().unwrap());
        let nullifier = Felt252::from_u64(44);
        store
            .reserve(&nullifier, "req-1", &Felt252::from_u64(7))
            .unwrap();
        store
            .finalize(
                &nullifier,
                &TranscriptRecord {
                    nullifier,
                    status: NullifierStatus::Finalized,
                    client_request_id: Some("req-1".to_string()),
                    payload_hash: Some(Felt252::from_u64(7)),
                    charge_applied: Some(3),
                    response_code: Some(200),
                    response_payload: Some("{\"answer\":\"ok\"}".to_string()),
                    response_hash: Some(Felt252::from_u64(55)),
                    next_commitment_x: Some(Felt252::from_u64(10)),
                    next_commitment_y: Some(Felt252::from_u64(11)),
                    next_anchor: Some(Felt252::from_u64(12)),
                    blind_delta_srv: Some(Felt252::from_u64(13)),
                    next_state_sig_epoch: Some(1),
                    next_state_sig_root: Some(Felt252::from_u64(14)),
                    next_state_sig: Some(empty_xmss_sig()),
                    policy_reason_code: None,
                    policy_evidence_hash: None,
                    proof_blob: None,
                    request_inputs_json: None,
                    created_at: 0,
                    finalized_at: None,
                },
            )
            .unwrap();

        let processor = test_processor(store);
        let recovery = processor.recover_by_client_id("req-1").unwrap();
        let response = recovery.request_response.expect("missing response");

        assert_eq!(recovery.nullifier_status, "finalized");
        assert_eq!(response.response_payload, "{\"answer\":\"ok\"}");
    }
}
