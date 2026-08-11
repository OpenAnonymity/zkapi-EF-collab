//! zkAPI v2 request processor.

use std::sync::{Arc, RwLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use zkapi_core::v2 as core;
use zkapi_proof::compact::{random_field, random_scalar, server_update, RequestVerifier};
use zkapi_types::wire::{
    ApiRequestV2, ClearanceRequest, ClearanceResponseV2, CurvePointWire, RecoveryResponseV2,
    RequestResponseV2,
};
use zkapi_types::{
    canonical_payload_hash, canonical_request_context, canonical_response_hash, Felt252,
    NullifierStatus,
};

use crate::config::ServerConfig;
use crate::dashboard::{
    charge_usd, decode_request_view, redact_secrets, DashboardEvent, DashboardHub,
};
use crate::error::ServerError;
use crate::nullifier_store::{NullifierStore, TranscriptRecord};
use crate::pricing;
use crate::provider::ApiProvider;
use crate::signer::ServerSigner;

const MAX_REQUEST_AGE_SECONDS: u64 = 300;
const MAX_FUTURE_SKEW_SECONDS: u64 = 30;

pub struct RequestProcessor {
    config: ServerConfig,
    store: Arc<NullifierStore>,
    signer: Arc<ServerSigner>,
    verifier: RequestVerifier,
    provider: Arc<dyn ApiProvider>,
    current_root: Arc<RwLock<Felt252>>,
    dashboard: Option<Arc<DashboardHub>>,
}

impl RequestProcessor {
    pub fn try_new(
        config: ServerConfig,
        store: Arc<NullifierStore>,
        signer: Arc<ServerSigner>,
        provider: Arc<dyn ApiProvider>,
        current_root: Felt252,
    ) -> anyhow::Result<Self> {
        let verifier = RequestVerifier::load(&config.proof_setup_dir)?;
        Ok(Self {
            config,
            store,
            signer,
            verifier,
            provider,
            current_root: Arc::new(RwLock::new(current_root)),
            dashboard: None,
        })
    }

    pub fn with_dashboard(mut self, dashboard: Arc<DashboardHub>) -> Self {
        self.dashboard = Some(dashboard);
        self
    }

    pub fn dashboard(&self) -> Option<&Arc<DashboardHub>> {
        self.dashboard.as_ref()
    }

    pub fn update_root(&self, new_root: Felt252) {
        if let Ok(mut root) = self.current_root.write() {
            *root = new_root;
        }
    }

    pub fn current_root(&self) -> Felt252 {
        self.current_root
            .read()
            .map(|value| *value)
            .unwrap_or(Felt252::ZERO)
    }

    pub fn state_signing_key(&self) -> CurvePointWire {
        self.signer.state_public_key()
    }

    pub fn clearance_signing_key(&self) -> CurvePointWire {
        self.signer.clearance_public_key()
    }

    pub async fn process_request(
        &self,
        request: &ApiRequestV2,
    ) -> Result<RequestResponseV2, ServerError> {
        let started = Instant::now();
        let public = &request.public_inputs;
        let payload_hash = canonical_payload_hash(request.payload.as_bytes());
        if payload_hash != request.payload_hash {
            return Err(ServerError::InvalidRequest(
                "payload_hash does not match payload bytes".to_string(),
            ));
        }
        if public.protocol_version != self.config.protocol_version
            || public.chain_id != self.config.chain_id
            || public.contract_address != self.config.contract_address
        {
            return Err(ServerError::ProtocolMismatch(
                "version, chain, or contract mismatch".to_string(),
            ));
        }
        let root = self.current_root();
        if public.active_root != root {
            return Err(ServerError::StaleRoot {
                latest_root: root.to_hex(),
            });
        }
        let state_key = self.state_signing_key();
        if public.state_signing_key_x != state_key.x || public.state_signing_key_y != state_key.y {
            return Err(ServerError::InvalidRequest(
                "state signing key does not match this deployment".to_string(),
            ));
        }
        let now = current_timestamp();
        if public.request_time.saturating_add(MAX_REQUEST_AGE_SECONDS) < now
            || public.request_time > now.saturating_add(MAX_FUTURE_SKEW_SECONDS)
        {
            return Err(ServerError::InvalidRequest(
                "request_time is outside the accepted freshness window".to_string(),
            ));
        }
        let required_solvency = if self.config.policy_enabled {
            self.config.policy_charge_cap
        } else {
            self.config.request_charge_cap
        };
        if public.solvency_bound < required_solvency {
            return Err(ServerError::InvalidRequest(format!(
                "solvency_bound {} is below required {}",
                public.solvency_bound, required_solvency
            )));
        }
        let context = canonical_request_context(&request.client_request_id, &payload_hash);
        if core::authorization_tag(&public.request_nullifier, &context) != public.authorization_tag
        {
            return Err(ServerError::InvalidProof(
                "proof authorization tag does not bind this request id and payload".to_string(),
            ));
        }
        if !self
            .verifier
            .verify(public, &request.proof)
            .map_err(|error| ServerError::InvalidProof(error.to_string()))?
        {
            return Err(ServerError::InvalidProof(
                "Groth16 verification returned false".to_string(),
            ));
        }

        match self.store.lookup_by_nullifier(&public.request_nullifier) {
            Some(existing)
                if existing.client_request_id.as_deref() == Some(&request.client_request_id)
                    && existing.payload_hash == Some(request.payload_hash)
                    && existing.status == NullifierStatus::Finalized =>
            {
                return response_from_record(&existing, &request.client_request_id)
            }
            Some(existing)
                if existing.client_request_id.as_deref() == Some(&request.client_request_id)
                    && existing.payload_hash == Some(request.payload_hash)
                    && existing.status == NullifierStatus::Reserved => {}
            Some(_) => return Err(ServerError::Replay),
            None => self.store.reserve(
                &public.request_nullifier,
                &request.client_request_id,
                &request.payload_hash,
            )?,
        }

        let upstream_started = Instant::now();
        let provider_response = self
            .provider
            .execute(
                &request.client_request_id,
                &request.payload,
                &request.payload_hash,
            )
            .await?;
        let upstream_ms = upstream_started.elapsed().as_millis() as u64;
        let policy_charged =
            self.config.policy_enabled && provider_response.policy_reason_code.is_some();
        let charge_cap = if policy_charged {
            self.config.policy_charge_cap
        } else {
            self.config.request_charge_cap
        };
        if provider_response.charge_applied > charge_cap {
            return Err(ServerError::Internal(format!(
                "provider charge {} exceeds cap {}",
                provider_response.charge_applied, charge_cap
            )));
        }

        let anonymous = CurvePointWire {
            x: public.anonymous_commitment_x,
            y: public.anonymous_commitment_y,
        };
        let blind_delta = random_scalar();
        let next_commitment =
            server_update(&anonymous, provider_response.charge_applied, &blind_delta)
                .map_err(|error| ServerError::InvalidProof(error.to_string()))?;
        let next_anchor = core::next_anchor(
            &random_field(),
            &public.request_nullifier,
            &next_commitment.x,
            &next_commitment.y,
        );
        let state_message = core::state_message(
            self.config.protocol_version,
            self.config.chain_id,
            &self.config.contract_address,
            &next_commitment.x,
            &next_commitment.y,
            &next_anchor,
        );
        let state_signature = self.signer.sign_state(&state_message);
        let response_hash = canonical_response_hash(provider_response.payload.as_bytes());
        let proof_bytes = base64::engine::general_purpose::STANDARD
            .decode(&request.proof.proof)
            .map_err(|error| ServerError::InvalidProof(error.to_string()))?;

        let transcript = TranscriptRecord {
            nullifier: public.request_nullifier,
            status: NullifierStatus::Finalized,
            client_request_id: Some(request.client_request_id.clone()),
            payload_hash: Some(request.payload_hash),
            charge_applied: Some(provider_response.charge_applied),
            response_code: Some(provider_response.status_code),
            response_payload: Some(provider_response.payload.clone()),
            response_hash: Some(response_hash),
            next_commitment_x: Some(next_commitment.x),
            next_commitment_y: Some(next_commitment.y),
            next_anchor: Some(next_anchor),
            blind_delta_srv: Some(blind_delta),
            next_state_sig_epoch: None,
            next_state_sig_root: None,
            next_state_sig: Some(state_signature),
            policy_reason_code: provider_response.policy_reason_code,
            policy_evidence_hash: provider_response.policy_evidence_hash,
            proof_blob: Some(proof_bytes.clone()),
            request_inputs_json: serde_json::to_string(public).ok(),
            created_at: now,
            finalized_at: Some(current_timestamp()),
        };
        self.store
            .finalize(&public.request_nullifier, &transcript)?;

        if let Some(hub) = &self.dashboard {
            let (request_path, request_model, request_messages) =
                decode_request_view(&request.payload);
            hub.record(DashboardEvent {
                seq: hub.next_seq(),
                ts_ms: current_timestamp_ms(),
                client_request_id: request.client_request_id.clone(),
                billing_label: provider_response.billing_label.clone(),
                upstream_model: provider_response.upstream_model.clone(),
                request_nullifier: public.request_nullifier,
                active_root: public.active_root,
                anon_commitment: anonymous,
                solvency_bound: public.solvency_bound,
                solvency_bound_usd: pricing::credits_to_usd(public.solvency_bound),
                statement_type: 1,
                state_sig_epoch_in: 0,
                proof_backend: "groth16_bn254".to_string(),
                proof_public_output_hash: public.authorization_tag,
                proof_size_bytes: proof_bytes.len(),
                request_path,
                request_model,
                request_messages,
                request_raw: redact_secrets(&request.payload),
                response_code: provider_response.status_code,
                response_text: redact_secrets(&provider_response.payload),
                response_hash,
                usage: provider_response.usage.clone(),
                charge_applied: provider_response.charge_applied,
                charge_usd: charge_usd(provider_response.charge_applied),
                next_commitment: next_commitment.clone(),
                next_anchor,
                blind_delta_srv: blind_delta,
                next_state_sig_epoch: 0,
                next_state_sig_leaf_index: 0,
                next_state_sig_root: state_key.x,
                upstream_ms,
                total_ms: started.elapsed().as_millis() as u64,
            });
        }

        Ok(RequestResponseV2 {
            status: "ok".to_string(),
            client_request_id: request.client_request_id.clone(),
            request_nullifier: public.request_nullifier,
            response_code: provider_response.status_code,
            response_payload: provider_response.payload,
            response_hash,
            charge_applied: provider_response.charge_applied,
            next_commitment,
            next_anchor,
            blind_delta_srv: blind_delta,
            next_state_signature: state_signature,
            policy_reason_code: provider_response.policy_reason_code,
            policy_evidence_hash: provider_response.policy_evidence_hash,
        })
    }

    pub fn process_clearance(
        &self,
        request: &ClearanceRequest,
    ) -> Result<ClearanceResponseV2, ServerError> {
        let already_reserved = match self
            .store
            .lookup_by_nullifier(&request.withdrawal_nullifier)
        {
            Some(record) if record.status == NullifierStatus::ClearanceReserved => true,
            Some(_) => return Err(ServerError::NullifierUsed),
            None => false,
        };
        let message = core::clearance_message(
            self.config.protocol_version,
            self.config.chain_id,
            &self.config.contract_address,
            &request.withdrawal_nullifier,
        );
        let signature = self.signer.sign_clearance(&message);
        if !already_reserved {
            self.store
                .reserve_clearance(&request.withdrawal_nullifier)?;
        }
        Ok(ClearanceResponseV2 {
            status: "ok".to_string(),
            withdrawal_nullifier: request.withdrawal_nullifier,
            signature,
        })
    }

    pub fn recover_by_client_id(
        &self,
        client_request_id: &str,
    ) -> Result<RecoveryResponseV2, ServerError> {
        Ok(self
            .store
            .lookup_by_client_id(client_request_id)
            .map(|record| recovery_from_record(&record))
            .unwrap_or_else(not_found_recovery))
    }

    pub fn recover_by_nullifier(
        &self,
        nullifier: &Felt252,
    ) -> Result<RecoveryResponseV2, ServerError> {
        Ok(self
            .store
            .lookup_by_nullifier(nullifier)
            .map(|record| recovery_from_record(&record))
            .unwrap_or_else(not_found_recovery))
    }

    pub fn config(&self) -> &ServerConfig {
        &self.config
    }

    pub fn store(&self) -> &Arc<NullifierStore> {
        &self.store
    }
}

fn response_from_record(
    record: &TranscriptRecord,
    client_request_id: &str,
) -> Result<RequestResponseV2, ServerError> {
    Ok(RequestResponseV2 {
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
        next_state_signature: record
            .next_state_sig
            .ok_or_else(|| ServerError::Internal("stored response lacks signature".to_string()))?,
        policy_reason_code: record.policy_reason_code,
        policy_evidence_hash: record.policy_evidence_hash,
    })
}

fn recovery_from_record(record: &TranscriptRecord) -> RecoveryResponseV2 {
    let status = match record.status {
        NullifierStatus::Reserved => "reserved",
        NullifierStatus::Finalized => "finalized",
        NullifierStatus::ClearanceReserved => "clearance_reserved",
    };
    RecoveryResponseV2 {
        status: "ok".to_string(),
        nullifier_status: status.to_string(),
        request_response: (record.status == NullifierStatus::Finalized)
            .then(|| {
                response_from_record(record, record.client_request_id.as_deref().unwrap_or(""))
            })
            .transpose()
            .ok()
            .flatten(),
    }
}

fn not_found_recovery() -> RecoveryResponseV2 {
    RecoveryResponseV2 {
        status: "not_found".to_string(),
        nullifier_status: "unknown".to_string(),
        request_response: None,
    }
}

fn current_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn current_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
