//! SQLite-backed nullifier and transcript store.
//!
//! Stores nullifier reservations and finalized transcripts. Each nullifier
//! progresses through: Reserved -> Finalized (or ClearanceReserved for withdrawals).

use rusqlite::{params, Connection, OptionalExtension};
use sha3::{Digest, Keccak256};
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use zkapi_types::wire::ApiRequestV2;
use zkapi_types::{Felt252, NullifierStatus, SchnorrSignature};

use crate::error::ServerError;

/// A transcript record stored in the database.
#[derive(Debug, Clone)]
pub struct TranscriptRecord {
    pub nullifier: Felt252,
    pub status: NullifierStatus,
    pub reservation_kind: String,
    pub client_request_id: Option<String>,
    pub payload_hash: Option<Felt252>,
    pub charge_applied: Option<u128>,
    pub response_code: Option<u16>,
    pub response_payload: Option<String>,
    pub response_hash: Option<Felt252>,
    pub next_commitment_x: Option<Felt252>,
    pub next_commitment_y: Option<Felt252>,
    pub next_anchor: Option<Felt252>,
    pub blind_delta_srv: Option<Felt252>,
    pub next_state_sig_epoch: Option<u32>,
    pub next_state_sig_root: Option<Felt252>,
    pub next_state_sig: Option<SchnorrSignature>,
    pub policy_reason_code: Option<u32>,
    pub policy_evidence_hash: Option<Felt252>,
    pub proof_blob: Option<Vec<u8>>,
    pub request_inputs_json: Option<String>,
    /// Domain-separated digest of the complete canonical v2 API request.
    /// Reserved retries must match this before proof verification is skipped.
    pub api_request_binding: Option<String>,
    pub created_at: u64,
    pub finalized_at: Option<u64>,
}

/// Durable metadata for one prompt-private OpenRouter lease. The plaintext
/// runtime key is deliberately never stored.
#[derive(Debug, Clone)]
pub struct OpenRouterLeaseRecord {
    pub client_request_id: String,
    pub request_nullifier: Felt252,
    pub api_request: ApiRequestV2,
    pub key_hash: Option<String>,
    pub key_source: String,
    pub status: String,
    pub issued_at: u64,
    pub expires_at: u64,
    pub settle_after: u64,
    pub spending_limit_usd: f64,
    pub usage_usd: Option<f64>,
    pub charge_applied: Option<u128>,
    pub last_error: Option<String>,
}

/// SQLite-backed nullifier store.
pub struct NullifierStore {
    conn: Mutex<Connection>,
}

/// Bind the complete semantically decoded v2 wire request. Serde emits struct
/// fields in declaration order, so equivalent JSON input has one canonical
/// representation while every downstream request field affects the digest.
pub(crate) fn api_request_binding(request: &ApiRequestV2) -> Result<String, ServerError> {
    let request = serde_json::to_vec(request).map_err(|error| {
        ServerError::Internal(format!("failed to serialize v2 request binding: {error}"))
    })?;
    let mut digest = Keccak256::new();
    digest.update(b"zkapi:v2:api-request-binding\0");
    digest.update(request);
    Ok(hex::encode(digest.finalize()))
}

impl NullifierStore {
    /// Open or create a nullifier store at the given path.
    pub fn new<P: AsRef<Path>>(path: P) -> Result<Self, ServerError> {
        let conn = Connection::open(path)
            .map_err(|e| ServerError::Database(format!("failed to open db: {}", e)))?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS nullifiers (
                nullifier TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                reservation_kind TEXT NOT NULL DEFAULT 'proxy',
                client_request_id TEXT,
                payload_hash TEXT,
                charge_applied INTEGER,
                response_code INTEGER,
                response_payload TEXT,
                response_hash TEXT,
                next_commitment_x TEXT,
                next_commitment_y TEXT,
                next_anchor TEXT,
                blind_delta_srv TEXT,
                next_state_sig_epoch INTEGER,
                next_state_sig_root TEXT,
                next_state_sig_json TEXT,
                policy_reason_code INTEGER,
                policy_evidence_hash TEXT,
                proof_blob BLOB,
                request_inputs_json TEXT,
                api_request_binding TEXT,
                created_at INTEGER NOT NULL,
                finalized_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS openrouter_leases (
                client_request_id TEXT PRIMARY KEY,
                request_nullifier TEXT NOT NULL UNIQUE,
                api_request_json TEXT NOT NULL,
                key_hash TEXT UNIQUE,
                key_source TEXT NOT NULL DEFAULT 'openrouter',
                status TEXT NOT NULL,
                issued_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                settle_after INTEGER NOT NULL,
                spending_limit_usd REAL NOT NULL,
                usage_usd REAL,
                charge_applied INTEGER,
                last_error TEXT,
                updated_at INTEGER NOT NULL
            );",
        )
        .map_err(|e| ServerError::Database(format!("failed to create table: {}", e)))?;

        let _ = conn.execute(
            "ALTER TABLE nullifiers ADD COLUMN next_state_sig_root TEXT",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE nullifiers ADD COLUMN response_payload TEXT",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE nullifiers ADD COLUMN reservation_kind TEXT NOT NULL DEFAULT 'proxy'",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE nullifiers ADD COLUMN api_request_binding TEXT",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE openrouter_leases ADD COLUMN key_source TEXT NOT NULL DEFAULT 'openrouter'",
            [],
        );
        backfill_openrouter_request_bindings(&conn)?;

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Create an in-memory store (for testing).
    pub fn in_memory() -> Result<Self, ServerError> {
        Self::new(":memory:")
    }

    /// Reserve a nullifier. Returns Ok(()) if the nullifier was successfully reserved.
    /// Returns Err(Replay) if the nullifier already exists.
    pub fn reserve(
        &self,
        nullifier: &Felt252,
        client_request_id: &str,
        payload_hash: &Felt252,
    ) -> Result<(), ServerError> {
        self.reserve_with_kind(nullifier, client_request_id, payload_hash, "proxy", None)
    }

    /// Reserve a v2 proxy request and bind every semantically decoded wire
    /// field. This permits only an exact retry to skip proof verification.
    pub fn reserve_v2(&self, request: &ApiRequestV2) -> Result<(), ServerError> {
        self.reserve_bound_v2(request, "proxy")
    }

    pub fn reserve_openrouter_lease(&self, request: &ApiRequestV2) -> Result<(), ServerError> {
        self.reserve_bound_v2(request, "openrouter_lease")
    }

    fn reserve_bound_v2(
        &self,
        request: &ApiRequestV2,
        reservation_kind: &str,
    ) -> Result<(), ServerError> {
        let binding = api_request_binding(request)?;
        self.reserve_with_kind(
            &request.public_inputs.request_nullifier,
            &request.client_request_id,
            &request.payload_hash,
            reservation_kind,
            Some(&binding),
        )
    }

    fn reserve_with_kind(
        &self,
        nullifier: &Felt252,
        client_request_id: &str,
        payload_hash: &Felt252,
        reservation_kind: &str,
        api_request_binding: Option<&str>,
    ) -> Result<(), ServerError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| ServerError::Database(format!("lock poisoned: {}", e)))?;
        let now = current_timestamp();
        let null_hex = nullifier.to_hex();

        conn.execute(
            "INSERT INTO nullifiers (
                nullifier, status, reservation_kind, client_request_id, payload_hash,
                api_request_binding, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                null_hex,
                status_to_str(NullifierStatus::Reserved),
                reservation_kind,
                client_request_id,
                payload_hash.to_hex(),
                api_request_binding,
                now as i64,
            ],
        )
        .map_err(|e| {
            if let rusqlite::Error::SqliteFailure(ref err, _) = e {
                if err.code == rusqlite::ErrorCode::ConstraintViolation {
                    return ServerError::Replay;
                }
            }
            ServerError::Database(format!("insert failed: {}", e))
        })?;

        Ok(())
    }

    /// Finalize a previously reserved nullifier with the full transcript.
    pub fn finalize(
        &self,
        nullifier: &Felt252,
        transcript: &TranscriptRecord,
    ) -> Result<(), ServerError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| ServerError::Database(format!("lock poisoned: {}", e)))?;
        let now = current_timestamp();
        let null_hex = nullifier.to_hex();

        let sig_json = transcript
            .next_state_sig
            .as_ref()
            .map(|sig| serde_json::to_string(sig).unwrap_or_default());

        let rows = conn
            .execute(
                "UPDATE nullifiers SET
                    status = ?1,
                    charge_applied = ?2,
                    response_code = ?3,
                    response_payload = ?4,
                    response_hash = ?5,
                    next_commitment_x = ?6,
                    next_commitment_y = ?7,
                    next_anchor = ?8,
                    blind_delta_srv = ?9,
                    next_state_sig_epoch = ?10,
                    next_state_sig_root = ?11,
                    next_state_sig_json = ?12,
                    policy_reason_code = ?13,
                    policy_evidence_hash = ?14,
                    proof_blob = ?15,
                    request_inputs_json = ?16,
                    finalized_at = ?17
                 WHERE nullifier = ?18 AND status = ?19",
                params![
                    status_to_str(NullifierStatus::Finalized),
                    transcript.charge_applied.map(|c| c as i64),
                    transcript.response_code.map(|c| c as i32),
                    transcript.response_payload.as_deref(),
                    transcript.response_hash.map(|h| h.to_hex()),
                    transcript.next_commitment_x.map(|c| c.to_hex()),
                    transcript.next_commitment_y.map(|c| c.to_hex()),
                    transcript.next_anchor.map(|a| a.to_hex()),
                    transcript.blind_delta_srv.map(|b| b.to_hex()),
                    transcript.next_state_sig_epoch.map(|e| e as i32),
                    transcript.next_state_sig_root.map(|r| r.to_hex()),
                    sig_json,
                    transcript.policy_reason_code.map(|c| c as i32),
                    transcript.policy_evidence_hash.map(|h| h.to_hex()),
                    transcript.proof_blob.as_deref(),
                    transcript.request_inputs_json.as_deref(),
                    now as i64,
                    null_hex,
                    status_to_str(NullifierStatus::Reserved),
                ],
            )
            .map_err(|e| ServerError::Database(format!("finalize failed: {}", e)))?;

        if rows == 0 {
            return Err(ServerError::Internal(
                "nullifier not in Reserved state or does not exist".to_string(),
            ));
        }

        Ok(())
    }

    /// Look up a transcript record by nullifier.
    pub fn lookup_by_nullifier(&self, nullifier: &Felt252) -> Option<TranscriptRecord> {
        let conn = self.conn.lock().ok()?;
        let null_hex = nullifier.to_hex();

        conn.query_row(
            "SELECT * FROM nullifiers WHERE nullifier = ?1",
            params![null_hex],
            row_to_record,
        )
        .optional()
        .ok()
        .flatten()
    }

    /// Look up a transcript record by client request ID.
    pub fn lookup_by_client_id(&self, client_request_id: &str) -> Option<TranscriptRecord> {
        let conn = self.conn.lock().ok()?;

        conn.query_row(
            "SELECT * FROM nullifiers WHERE client_request_id = ?1",
            params![client_request_id],
            row_to_record,
        )
        .optional()
        .ok()
        .flatten()
    }

    /// Reserve a nullifier for clearance (withdrawal signing).
    pub fn reserve_clearance(&self, nullifier: &Felt252) -> Result<(), ServerError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| ServerError::Database(format!("lock poisoned: {}", e)))?;
        let now = current_timestamp();
        let null_hex = nullifier.to_hex();

        conn.execute(
            "INSERT INTO nullifiers (nullifier, status, created_at)
             VALUES (?1, ?2, ?3)",
            params![
                null_hex,
                status_to_str(NullifierStatus::ClearanceReserved),
                now as i64,
            ],
        )
        .map_err(|e| {
            if let rusqlite::Error::SqliteFailure(ref err, _) = e {
                if err.code == rusqlite::ErrorCode::ConstraintViolation {
                    return ServerError::NullifierUsed;
                }
            }
            ServerError::Database(format!("clearance reserve failed: {}", e))
        })?;

        Ok(())
    }

    /// Get all reserved (not yet finalized) entries, for crash recovery.
    pub fn get_reserved_entries(&self) -> Vec<TranscriptRecord> {
        let conn = match self.conn.lock() {
            Ok(c) => c,
            Err(_) => return Vec::new(),
        };

        let mut stmt = match conn.prepare("SELECT * FROM nullifiers WHERE status = ?1") {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };

        let rows = match stmt.query_map(
            params![status_to_str(NullifierStatus::Reserved)],
            row_to_record,
        ) {
            Ok(r) => r,
            Err(_) => return Vec::new(),
        };

        rows.filter_map(|r| r.ok()).collect()
    }

    /// Get all nullifiers (for challenge watcher).
    pub fn get_all_nullifiers(&self) -> Vec<TranscriptRecord> {
        let conn = match self.conn.lock() {
            Ok(c) => c,
            Err(_) => return Vec::new(),
        };

        let mut stmt = match conn.prepare("SELECT * FROM nullifiers") {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };

        let rows = match stmt.query_map([], row_to_record) {
            Ok(r) => r,
            Err(_) => return Vec::new(),
        };

        rows.filter_map(|r| r.ok()).collect()
    }

    /// Persist a lease before contacting OpenRouter, closing the normal crash
    /// window between nullifier reservation and external key provisioning.
    pub fn create_openrouter_lease(
        &self,
        request: &ApiRequestV2,
        key_source: &str,
        issued_at: u64,
        expires_at: u64,
        settle_after: u64,
        spending_limit_usd: f64,
    ) -> Result<(), ServerError> {
        let request_json = serde_json::to_string(request).map_err(|error| {
            ServerError::Database(format!("lease serialization failed: {error}"))
        })?;
        let conn = self
            .conn
            .lock()
            .map_err(|error| ServerError::Database(format!("lock poisoned: {error}")))?;
        conn.execute(
            "INSERT INTO openrouter_leases (
                client_request_id, request_nullifier, api_request_json, key_source, status,
                issued_at, expires_at, settle_after, spending_limit_usd, updated_at
             ) VALUES (?1, ?2, ?3, ?4, 'provisioning', ?5, ?6, ?7, ?8, ?9)",
            params![
                request.client_request_id,
                request.public_inputs.request_nullifier.to_hex(),
                request_json,
                key_source,
                issued_at as i64,
                expires_at as i64,
                settle_after as i64,
                spending_limit_usd,
                current_timestamp() as i64,
            ],
        )
        .map_err(|error| ServerError::Database(format!("lease insert failed: {error}")))?;
        Ok(())
    }

    pub fn update_openrouter_lease_timing(
        &self,
        client_request_id: &str,
        expires_at: u64,
        settle_after: u64,
    ) -> Result<(), ServerError> {
        let conn = self
            .conn
            .lock()
            .map_err(|error| ServerError::Database(format!("lock poisoned: {error}")))?;
        let rows = conn
            .execute(
                "UPDATE openrouter_leases
                 SET expires_at = ?1, settle_after = ?2, updated_at = ?3
                 WHERE client_request_id = ?4 AND status = 'provisioning'",
                params![
                    expires_at as i64,
                    settle_after as i64,
                    current_timestamp() as i64,
                    client_request_id,
                ],
            )
            .map_err(|error| {
                ServerError::Database(format!("lease timing update failed: {error}"))
            })?;
        if rows != 1 {
            return Err(ServerError::Internal(
                "lease was not in provisioning state".to_string(),
            ));
        }
        Ok(())
    }

    pub fn activate_openrouter_lease(
        &self,
        client_request_id: &str,
        key_hash: &str,
    ) -> Result<(), ServerError> {
        let conn = self
            .conn
            .lock()
            .map_err(|error| ServerError::Database(format!("lock poisoned: {error}")))?;
        let rows = conn
            .execute(
                "UPDATE openrouter_leases
                 SET status = 'active', key_hash = ?1, updated_at = ?2
                 WHERE client_request_id = ?3 AND status = 'provisioning'",
                params![key_hash, current_timestamp() as i64, client_request_id],
            )
            .map_err(|error| ServerError::Database(format!("lease activation failed: {error}")))?;
        if rows != 1 {
            return Err(ServerError::Internal(
                "lease was not in provisioning state".to_string(),
            ));
        }
        Ok(())
    }

    pub fn remove_failed_openrouter_lease(
        &self,
        client_request_id: &str,
    ) -> Result<(), ServerError> {
        let conn = self
            .conn
            .lock()
            .map_err(|error| ServerError::Database(format!("lock poisoned: {error}")))?;
        conn.execute(
            "DELETE FROM openrouter_leases
             WHERE client_request_id = ?1 AND status = 'provisioning' AND key_hash IS NULL",
            params![client_request_id],
        )
        .map_err(|error| ServerError::Database(format!("lease cleanup failed: {error}")))?;
        Ok(())
    }

    pub fn lookup_openrouter_lease(
        &self,
        client_request_id: &str,
    ) -> Option<OpenRouterLeaseRecord> {
        let conn = self.conn.lock().ok()?;
        conn.query_row(
            "SELECT * FROM openrouter_leases WHERE client_request_id = ?1",
            params![client_request_id],
            row_to_openrouter_lease,
        )
        .optional()
        .ok()
        .flatten()
    }

    pub fn due_openrouter_leases(&self, now: u64) -> Vec<OpenRouterLeaseRecord> {
        let conn = match self.conn.lock() {
            Ok(conn) => conn,
            Err(_) => return Vec::new(),
        };
        let mut statement = match conn.prepare(
            "SELECT * FROM openrouter_leases
             WHERE status = 'active' AND settle_after <= ?1
             ORDER BY settle_after ASC",
        ) {
            Ok(statement) => statement,
            Err(_) => return Vec::new(),
        };
        let rows = match statement.query_map(params![now as i64], row_to_openrouter_lease) {
            Ok(rows) => rows,
            Err(_) => return Vec::new(),
        };
        rows.filter_map(Result::ok).collect()
    }

    pub fn record_openrouter_lease_error(
        &self,
        client_request_id: &str,
        error: &str,
    ) -> Result<(), ServerError> {
        let conn = self
            .conn
            .lock()
            .map_err(|cause| ServerError::Database(format!("lock poisoned: {cause}")))?;
        conn.execute(
            "UPDATE openrouter_leases SET last_error = ?1, updated_at = ?2
             WHERE client_request_id = ?3 AND status = 'active'",
            params![error, current_timestamp() as i64, client_request_id],
        )
        .map_err(|cause| ServerError::Database(format!("lease error update failed: {cause}")))?;
        Ok(())
    }

    pub fn finalize_openrouter_lease(
        &self,
        client_request_id: &str,
        usage_usd: f64,
        charge_applied: u128,
    ) -> Result<(), ServerError> {
        let conn = self
            .conn
            .lock()
            .map_err(|error| ServerError::Database(format!("lock poisoned: {error}")))?;
        conn.execute(
            "UPDATE openrouter_leases SET
                status = 'finalized', usage_usd = ?1, charge_applied = ?2,
                last_error = NULL, updated_at = ?3
             WHERE client_request_id = ?4",
            params![
                usage_usd,
                charge_applied as i64,
                current_timestamp() as i64,
                client_request_id,
            ],
        )
        .map_err(|error| ServerError::Database(format!("lease finalize failed: {error}")))?;
        Ok(())
    }
}

/// Older lease rows already contain the complete original request. Use that
/// durable copy to migrate their nullifier reservation safely; proxy
/// reservations have no equivalent source and intentionally remain unbound so
/// retries fail closed.
fn backfill_openrouter_request_bindings(conn: &Connection) -> Result<(), ServerError> {
    let rows = {
        let mut statement = conn
            .prepare(
                "SELECT client_request_id, request_nullifier, api_request_json
                 FROM openrouter_leases",
            )
            .map_err(|error| {
                ServerError::Database(format!("lease binding migration query failed: {error}"))
            })?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|error| {
                ServerError::Database(format!("lease binding migration read failed: {error}"))
            })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| {
            ServerError::Database(format!("lease binding migration row failed: {error}"))
        })?
    };

    for (client_request_id, request_nullifier, request_json) in rows {
        let Ok(request) = serde_json::from_str::<ApiRequestV2>(&request_json) else {
            // A malformed durable lease cannot be resumed safely. Leave the
            // reservation unbound so validate_and_reserve rejects it.
            continue;
        };
        if request.client_request_id != client_request_id
            || request.public_inputs.request_nullifier.to_hex() != request_nullifier
        {
            continue;
        }
        let binding = api_request_binding(&request)?;
        conn.execute(
            "UPDATE nullifiers SET api_request_binding = ?1
             WHERE nullifier = ?2
               AND client_request_id = ?3
               AND payload_hash = ?4
               AND reservation_kind = 'openrouter_lease'
               AND api_request_binding IS NULL",
            params![
                binding,
                request_nullifier,
                client_request_id,
                request.payload_hash.to_hex(),
            ],
        )
        .map_err(|error| {
            ServerError::Database(format!("lease binding migration update failed: {error}"))
        })?;
    }
    Ok(())
}

/// Convert a NullifierStatus to its string representation for storage.
fn status_to_str(status: NullifierStatus) -> &'static str {
    match status {
        NullifierStatus::Reserved => "Reserved",
        NullifierStatus::Finalized => "Finalized",
        NullifierStatus::ClearanceReserved => "ClearanceReserved",
    }
}

/// Parse a status string from the database.
fn str_to_status(s: &str) -> NullifierStatus {
    match s {
        "Reserved" => NullifierStatus::Reserved,
        "Finalized" => NullifierStatus::Finalized,
        "ClearanceReserved" => NullifierStatus::ClearanceReserved,
        _ => NullifierStatus::Reserved, // fallback
    }
}

/// Parse an optional hex string into a Felt252.
fn parse_opt_felt(s: Option<String>) -> Option<Felt252> {
    s.and_then(|h| Felt252::from_hex(&h).ok())
}

/// Convert a database row into a TranscriptRecord.
fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<TranscriptRecord> {
    let nullifier_hex: String = row.get("nullifier")?;
    let status_str: String = row.get("status")?;
    let reservation_kind: String = row.get("reservation_kind")?;
    let client_request_id: Option<String> = row.get("client_request_id")?;
    let payload_hash: Option<String> = row.get("payload_hash")?;
    let charge_applied: Option<i64> = row.get("charge_applied")?;
    let response_code: Option<i32> = row.get("response_code")?;
    let response_payload: Option<String> = row.get("response_payload")?;
    let response_hash: Option<String> = row.get("response_hash")?;
    let next_commitment_x: Option<String> = row.get("next_commitment_x")?;
    let next_commitment_y: Option<String> = row.get("next_commitment_y")?;
    let next_anchor: Option<String> = row.get("next_anchor")?;
    let blind_delta_srv: Option<String> = row.get("blind_delta_srv")?;
    let next_state_sig_epoch: Option<i32> = row.get("next_state_sig_epoch")?;
    let next_state_sig_root: Option<String> = row.get("next_state_sig_root")?;
    let next_state_sig_json: Option<String> = row.get("next_state_sig_json")?;
    let policy_reason_code: Option<i32> = row.get("policy_reason_code")?;
    let policy_evidence_hash: Option<String> = row.get("policy_evidence_hash")?;
    let proof_blob: Option<Vec<u8>> = row.get("proof_blob")?;
    let request_inputs_json: Option<String> = row.get("request_inputs_json")?;
    let api_request_binding: Option<String> = row.get("api_request_binding")?;
    let created_at: i64 = row.get("created_at")?;
    let finalized_at: Option<i64> = row.get("finalized_at")?;

    let next_state_sig =
        next_state_sig_json.and_then(|json| serde_json::from_str::<SchnorrSignature>(&json).ok());

    Ok(TranscriptRecord {
        nullifier: Felt252::from_hex(&nullifier_hex).unwrap_or(Felt252::ZERO),
        status: str_to_status(&status_str),
        reservation_kind,
        client_request_id,
        payload_hash: parse_opt_felt(payload_hash),
        charge_applied: charge_applied.map(|c| c as u128),
        response_code: response_code.map(|c| c as u16),
        response_payload,
        response_hash: parse_opt_felt(response_hash),
        next_commitment_x: parse_opt_felt(next_commitment_x),
        next_commitment_y: parse_opt_felt(next_commitment_y),
        next_anchor: parse_opt_felt(next_anchor),
        blind_delta_srv: parse_opt_felt(blind_delta_srv),
        next_state_sig_epoch: next_state_sig_epoch.map(|e| e as u32),
        next_state_sig_root: parse_opt_felt(next_state_sig_root),
        next_state_sig,
        policy_reason_code: policy_reason_code.map(|c| c as u32),
        policy_evidence_hash: parse_opt_felt(policy_evidence_hash),
        proof_blob,
        request_inputs_json,
        api_request_binding,
        created_at: created_at as u64,
        finalized_at: finalized_at.map(|t| t as u64),
    })
}

fn row_to_openrouter_lease(row: &rusqlite::Row<'_>) -> rusqlite::Result<OpenRouterLeaseRecord> {
    let request_json: String = row.get("api_request_json")?;
    let api_request = serde_json::from_str(&request_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            request_json.len(),
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })?;
    let nullifier: String = row.get("request_nullifier")?;
    Ok(OpenRouterLeaseRecord {
        client_request_id: row.get("client_request_id")?,
        request_nullifier: Felt252::from_hex(&nullifier).unwrap_or(Felt252::ZERO),
        api_request,
        key_hash: row.get("key_hash")?,
        key_source: row.get("key_source")?,
        status: row.get("status")?,
        issued_at: row.get::<_, i64>("issued_at")? as u64,
        expires_at: row.get::<_, i64>("expires_at")? as u64,
        settle_after: row.get::<_, i64>("settle_after")? as u64,
        spending_limit_usd: row.get("spending_limit_usd")?,
        usage_usd: row.get("usage_usd")?,
        charge_applied: row
            .get::<_, Option<i64>>("charge_applied")?
            .map(|value| value as u128),
        last_error: row.get("last_error")?,
    })
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

    #[test]
    fn test_reserve_and_lookup() {
        let store = NullifierStore::in_memory().unwrap();
        let nullifier = Felt252::from_u64(42);
        let client_id = "test-req-1";
        let payload_hash = Felt252::from_u64(100);

        store.reserve(&nullifier, client_id, &payload_hash).unwrap();

        let record = store.lookup_by_nullifier(&nullifier).unwrap();
        assert_eq!(record.status, NullifierStatus::Reserved);
        assert_eq!(record.client_request_id.as_deref(), Some(client_id));
    }

    #[test]
    fn test_reserve_duplicate_fails() {
        let store = NullifierStore::in_memory().unwrap();
        let nullifier = Felt252::from_u64(42);

        store
            .reserve(&nullifier, "req-1", &Felt252::from_u64(1))
            .unwrap();
        let result = store.reserve(&nullifier, "req-2", &Felt252::from_u64(2));
        assert!(result.is_err());
    }

    #[test]
    fn test_lookup_by_client_id() {
        let store = NullifierStore::in_memory().unwrap();
        let nullifier = Felt252::from_u64(42);
        let client_id = "unique-client-id";

        store
            .reserve(&nullifier, client_id, &Felt252::from_u64(1))
            .unwrap();

        let record = store.lookup_by_client_id(client_id).unwrap();
        assert_eq!(record.nullifier, nullifier);
    }

    #[test]
    fn test_finalize() {
        let store = NullifierStore::in_memory().unwrap();
        let nullifier = Felt252::from_u64(42);

        store
            .reserve(&nullifier, "req-1", &Felt252::from_u64(1))
            .unwrap();

        let transcript = TranscriptRecord {
            nullifier,
            status: NullifierStatus::Finalized,
            reservation_kind: "proxy".to_string(),
            client_request_id: Some("req-1".to_string()),
            payload_hash: Some(Felt252::from_u64(1)),
            charge_applied: Some(100),
            response_code: Some(200),
            response_payload: Some("{\"ok\":true}".to_string()),
            response_hash: Some(Felt252::from_u64(999)),
            next_commitment_x: Some(Felt252::from_u64(10)),
            next_commitment_y: Some(Felt252::from_u64(20)),
            next_anchor: Some(Felt252::from_u64(30)),
            blind_delta_srv: Some(Felt252::from_u64(40)),
            next_state_sig_epoch: Some(1),
            next_state_sig_root: Some(Felt252::from_u64(50)),
            next_state_sig: None,
            policy_reason_code: None,
            policy_evidence_hash: None,
            proof_blob: None,
            request_inputs_json: None,
            api_request_binding: None,
            created_at: 0,
            finalized_at: None,
        };

        store.finalize(&nullifier, &transcript).unwrap();

        let record = store.lookup_by_nullifier(&nullifier).unwrap();
        assert_eq!(record.status, NullifierStatus::Finalized);
        assert_eq!(record.charge_applied, Some(100));
        assert_eq!(record.response_payload.as_deref(), Some("{\"ok\":true}"));
    }

    #[test]
    fn test_reserve_clearance() {
        let store = NullifierStore::in_memory().unwrap();
        let nullifier = Felt252::from_u64(42);

        store.reserve_clearance(&nullifier).unwrap();

        let record = store.lookup_by_nullifier(&nullifier).unwrap();
        assert_eq!(record.status, NullifierStatus::ClearanceReserved);
    }

    #[test]
    fn test_get_reserved_entries() {
        let store = NullifierStore::in_memory().unwrap();

        store
            .reserve(&Felt252::from_u64(1), "r1", &Felt252::from_u64(10))
            .unwrap();
        store
            .reserve(&Felt252::from_u64(2), "r2", &Felt252::from_u64(20))
            .unwrap();

        let reserved = store.get_reserved_entries();
        assert_eq!(reserved.len(), 2);
    }

    #[test]
    fn openrouter_lease_never_persists_plaintext_key() {
        use zkapi_types::wire::{ApiRequestV2, Groth16ProofWire, ProofBackendWire};
        use zkapi_types::RequestPublicInputsV2;

        let store = NullifierStore::in_memory().unwrap();
        let nullifier = Felt252::from_u64(77);
        let request = ApiRequestV2 {
            client_request_id: "lease-1".to_string(),
            payload: "{\"mode\":\"openrouter_ephemeral_lease\",\"version\":1}".to_string(),
            payload_hash: Felt252::from_u64(88),
            public_inputs: RequestPublicInputsV2 {
                protocol_version: 2,
                chain_id: 1,
                contract_address: Felt252::from_u64(2),
                active_root: Felt252::from_u64(3),
                state_signing_key_x: Felt252::from_u64(4),
                state_signing_key_y: Felt252::from_u64(5),
                request_time: 6,
                solvency_bound: 1_000,
                request_nullifier: nullifier,
                authorization_tag: Felt252::from_u64(7),
                anonymous_commitment_x: Felt252::from_u64(8),
                anonymous_commitment_y: Felt252::from_u64(9),
            },
            proof: Groth16ProofWire {
                backend: ProofBackendWire::Groth16Bn254,
                proof: "public-proof".to_string(),
            },
        };
        store.reserve_openrouter_lease(&request).unwrap();
        let reservation = store.lookup_by_nullifier(&nullifier).unwrap();
        assert_eq!(
            reservation.api_request_binding.as_deref(),
            Some(api_request_binding(&request).unwrap().as_str())
        );
        store
            .create_openrouter_lease(&request, "openrouter", 10, 20, 21, 0.001)
            .unwrap();
        {
            let conn = store.conn.lock().unwrap();
            conn.execute(
                "UPDATE nullifiers SET api_request_binding = NULL WHERE nullifier = ?1",
                params![nullifier.to_hex()],
            )
            .unwrap();
            backfill_openrouter_request_bindings(&conn).unwrap();
        }
        assert_eq!(
            store
                .lookup_by_nullifier(&nullifier)
                .unwrap()
                .api_request_binding,
            Some(api_request_binding(&request).unwrap())
        );
        store
            .activate_openrouter_lease("lease-1", "safe-key-hash")
            .unwrap();

        let lease = store.lookup_openrouter_lease("lease-1").unwrap();
        assert_eq!(lease.key_hash.as_deref(), Some("safe-key-hash"));
        assert!(!serde_json::to_string(&lease.api_request)
            .unwrap()
            .contains("sk-or-"));
        assert_eq!(store.due_openrouter_leases(20).len(), 0);
        assert_eq!(store.due_openrouter_leases(21).len(), 1);
    }
}
