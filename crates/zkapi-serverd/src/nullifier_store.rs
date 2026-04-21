//! SQLite-backed nullifier and transcript store.
//!
//! Stores nullifier reservations and finalized transcripts. Each nullifier
//! progresses through: Reserved -> Finalized (or ClearanceReserved for withdrawals).

use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use zkapi_types::{Felt252, NullifierStatus, XmssSignature};

use crate::error::ServerError;

/// A transcript record stored in the database.
#[derive(Debug, Clone)]
pub struct TranscriptRecord {
    pub nullifier: Felt252,
    pub status: NullifierStatus,
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
    pub next_state_sig: Option<XmssSignature>,
    pub policy_reason_code: Option<u32>,
    pub policy_evidence_hash: Option<Felt252>,
    pub proof_blob: Option<Vec<u8>>,
    pub request_inputs_json: Option<String>,
    pub created_at: u64,
    pub finalized_at: Option<u64>,
}

/// SQLite-backed nullifier store.
pub struct NullifierStore {
    conn: Mutex<Connection>,
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
                created_at INTEGER NOT NULL,
                finalized_at INTEGER
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
        let conn = self
            .conn
            .lock()
            .map_err(|e| ServerError::Database(format!("lock poisoned: {}", e)))?;
        let now = current_timestamp();
        let null_hex = nullifier.to_hex();

        conn.execute(
            "INSERT INTO nullifiers (nullifier, status, client_request_id, payload_hash, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                null_hex,
                status_to_str(NullifierStatus::Reserved),
                client_request_id,
                payload_hash.to_hex(),
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
    let created_at: i64 = row.get("created_at")?;
    let finalized_at: Option<i64> = row.get("finalized_at")?;

    let next_state_sig =
        next_state_sig_json.and_then(|json| serde_json::from_str::<XmssSignature>(&json).ok());

    Ok(TranscriptRecord {
        nullifier: Felt252::from_hex(&nullifier_hex).unwrap_or(Felt252::ZERO),
        status: str_to_status(&status_str),
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
        created_at: created_at as u64,
        finalized_at: finalized_at.map(|t| t as u64),
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
}
