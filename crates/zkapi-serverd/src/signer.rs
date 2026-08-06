//! Server signing module that manages XMSS keypairs.
//!
//! The server maintains two XMSS trees:
//! - state keypair: signs state transitions (next commitment + anchor)
//! - clear keypair: signs clearance messages for mutual close

use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection, OptionalExtension};
use zkapi_core::poseidon::FieldElement;
use zkapi_crypto::xmss::XmssKeypair;
use zkapi_types::{Felt252, XmssSignature};

use crate::error::ServerError;

/// Server-side signer holding both state and clearance XMSS keypairs.
pub struct ServerSigner {
    state_keypair: XmssKeypair,
    clear_keypair: XmssKeypair,
    state_epoch: u32,
    clear_epoch: u32,
    durable_state: Option<Arc<SignerStateStore>>,
    state_op_lock: Mutex<()>,
    clear_op_lock: Mutex<()>,
}

impl ServerSigner {
    /// Create a new in-memory server signer from seeds and an epoch number.
    pub fn new(state_seed: FieldElement, clear_seed: FieldElement, epoch: u32) -> Self {
        Self::with_height(state_seed, clear_seed, epoch, zkapi_types::XMSS_TREE_HEIGHT)
    }

    /// Create an in-memory signer with a custom tree height (primarily for tests).
    pub fn with_height(
        state_seed: FieldElement,
        clear_seed: FieldElement,
        epoch: u32,
        height: usize,
    ) -> Self {
        let state_keypair = XmssKeypair::generate_with_height(&state_seed, height);
        let clear_keypair = XmssKeypair::generate_with_height(&clear_seed, height);
        Self {
            state_keypair,
            clear_keypair,
            state_epoch: epoch,
            clear_epoch: epoch,
            durable_state: None,
            state_op_lock: Mutex::new(()),
            clear_op_lock: Mutex::new(()),
        }
    }

    /// Create a signer whose one-time XMSS leaf reservations persist in SQLite.
    ///
    /// Each counter is committed before signing. A crash can therefore burn a
    /// leaf, but it cannot cause that leaf to be reused after restart.
    pub fn with_height_durable<P: AsRef<Path>>(
        state_seed: FieldElement,
        clear_seed: FieldElement,
        epoch: u32,
        height: usize,
        db_path: P,
    ) -> Result<Self, ServerError> {
        let state_keypair = XmssKeypair::generate_with_height(&state_seed, height);
        let clear_keypair = XmssKeypair::generate_with_height(&clear_seed, height);
        let durable_state = SignerStateStore::new(
            db_path,
            epoch,
            state_keypair.root_felt(),
            epoch,
            clear_keypair.root_felt(),
        )?;
        Ok(Self {
            state_keypair,
            clear_keypair,
            state_epoch: epoch,
            clear_epoch: epoch,
            durable_state: Some(Arc::new(durable_state)),
            state_op_lock: Mutex::new(()),
            clear_op_lock: Mutex::new(()),
        })
    }

    /// Sign a state message using the state XMSS keypair.
    pub fn sign_state(&self, message: &Felt252) -> Result<(XmssSignature, u32), ServerError> {
        let _lock = self
            .state_op_lock
            .lock()
            .map_err(|_| ServerError::Internal("state signer lock poisoned".to_string()))?;
        let (mut sig, leaf_index) = if let Some(store) = &self.durable_state {
            let leaf_index = store.reserve_leaf(
                SignerTree::State,
                self.state_epoch,
                &self.state_root(),
                self.state_keypair.capacity(),
            )?;
            let sig = self
                .state_keypair
                .sign_reserved(leaf_index, message)
                .ok_or(ServerError::CapacityExhausted)?;
            (sig, leaf_index)
        } else {
            self.state_keypair
                .sign(message)
                .ok_or(ServerError::CapacityExhausted)?
        };
        sig.epoch = self.state_epoch;
        Ok((sig, leaf_index))
    }

    /// Reserve the next state leaf and build/sign the corresponding message
    /// while holding the state signer lock.
    pub fn sign_next_state<T, F>(&self, build_message: F) -> Result<(XmssSignature, T), ServerError>
    where
        F: FnOnce(u32) -> (Felt252, T),
    {
        let _lock = self
            .state_op_lock
            .lock()
            .map_err(|_| ServerError::Internal("state signer lock poisoned".to_string()))?;
        let (mut sig, context) = if let Some(store) = &self.durable_state {
            let leaf_index = store.reserve_leaf(
                SignerTree::State,
                self.state_epoch,
                &self.state_root(),
                self.state_keypair.capacity(),
            )?;
            let (message, context) = build_message(leaf_index);
            let sig = self
                .state_keypair
                .sign_reserved(leaf_index, &message)
                .ok_or(ServerError::CapacityExhausted)?;
            (sig, context)
        } else {
            let predicted_leaf_index = self.state_keypair.next_index();
            let (message, context) = build_message(predicted_leaf_index);
            let (sig, actual_leaf_index) = self
                .state_keypair
                .sign(&message)
                .ok_or(ServerError::CapacityExhausted)?;
            if actual_leaf_index != predicted_leaf_index {
                return Err(ServerError::Internal(format!(
                    "state signer leaf index changed during signing: predicted={predicted_leaf_index}, actual={actual_leaf_index}"
                )));
            }
            (sig, context)
        };
        sig.epoch = self.state_epoch;
        Ok((sig, context))
    }

    /// Sign a clearance message using the clearance XMSS keypair.
    pub fn sign_clearance(&self, message: &Felt252) -> Result<(XmssSignature, u32), ServerError> {
        let _lock = self
            .clear_op_lock
            .lock()
            .map_err(|_| ServerError::Internal("clear signer lock poisoned".to_string()))?;
        let (mut sig, leaf_index) = if let Some(store) = &self.durable_state {
            let leaf_index = store.reserve_leaf(
                SignerTree::Clear,
                self.clear_epoch,
                &self.clear_root(),
                self.clear_keypair.capacity(),
            )?;
            let sig = self
                .clear_keypair
                .sign_reserved(leaf_index, message)
                .ok_or(ServerError::CapacityExhausted)?;
            (sig, leaf_index)
        } else {
            self.clear_keypair
                .sign(message)
                .ok_or(ServerError::CapacityExhausted)?
        };
        sig.epoch = self.clear_epoch;
        Ok((sig, leaf_index))
    }

    pub fn state_root(&self) -> Felt252 {
        self.state_keypair.root_felt()
    }

    pub fn clear_root(&self) -> Felt252 {
        self.clear_keypair.root_felt()
    }

    pub fn epoch(&self) -> u32 {
        self.state_epoch
    }

    pub fn clear_epoch(&self) -> u32 {
        self.clear_epoch
    }

    pub fn state_remaining(&self) -> u32 {
        if let Some(store) = &self.durable_state {
            return store
                .next_leaf(SignerTree::State)
                .ok()
                .and_then(|next| self.state_keypair.capacity().checked_sub(next))
                .unwrap_or(0);
        }
        self.state_keypair.remaining()
    }

    pub fn clear_remaining(&self) -> u32 {
        if let Some(store) = &self.durable_state {
            return store
                .next_leaf(SignerTree::Clear)
                .ok()
                .and_then(|next| self.clear_keypair.capacity().checked_sub(next))
                .unwrap_or(0);
        }
        self.clear_keypair.remaining()
    }
}

#[derive(Clone, Copy)]
enum SignerTree {
    State,
    Clear,
}

impl SignerTree {
    fn as_str(self) -> &'static str {
        match self {
            Self::State => "state",
            Self::Clear => "clear",
        }
    }
}

/// Durable signer leaf reservation state.
struct SignerStateStore {
    conn: Mutex<Connection>,
}

impl SignerStateStore {
    fn new<P: AsRef<Path>>(
        path: P,
        state_epoch: u32,
        state_root: Felt252,
        clear_epoch: u32,
        clear_root: Felt252,
    ) -> Result<Self, ServerError> {
        let conn = Connection::open(path)
            .map_err(|e| ServerError::Database(format!("failed to open signer db: {e}")))?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS signer_state (
                tree_kind TEXT PRIMARY KEY,
                epoch INTEGER NOT NULL,
                root TEXT NOT NULL,
                next_leaf INTEGER NOT NULL
            );",
        )
        .map_err(|e| ServerError::Database(format!("failed to create signer_state: {e}")))?;
        let store = Self {
            conn: Mutex::new(conn),
        };
        store.ensure_tree(SignerTree::State, state_epoch, &state_root)?;
        store.ensure_tree(SignerTree::Clear, clear_epoch, &clear_root)?;
        Ok(store)
    }

    fn ensure_tree(&self, tree: SignerTree, epoch: u32, root: &Felt252) -> Result<(), ServerError> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| ServerError::Database("signer_state lock poisoned".to_string()))?;
        let row: Option<(i64, String)> = conn
            .query_row(
                "SELECT epoch, root FROM signer_state WHERE tree_kind = ?1",
                params![tree.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|e| ServerError::Database(format!("signer_state lookup failed: {e}")))?;
        match row {
            Some((stored_epoch, stored_root))
                if stored_epoch == epoch as i64 && stored_root == root.to_hex() =>
            {
                Ok(())
            }
            Some((stored_epoch, stored_root))
                if (epoch as i64) > stored_epoch && stored_root != root.to_hex() =>
            {
                conn.execute(
                    "UPDATE signer_state SET epoch = ?1, root = ?2, next_leaf = 0
                     WHERE tree_kind = ?3",
                    params![epoch as i64, root.to_hex(), tree.as_str()],
                )
                .map_err(|e| ServerError::Database(format!("signer_state rotation failed: {e}")))?;
                Ok(())
            }
            Some((stored_epoch, stored_root)) => Err(ServerError::Database(format!(
                "signer_state {} mismatch: db has epoch={} root={}, config has epoch={} root={}",
                tree.as_str(),
                stored_epoch,
                stored_root,
                epoch,
                root
            ))),
            None => {
                conn.execute(
                    "INSERT INTO signer_state (tree_kind, epoch, root, next_leaf)
                     VALUES (?1, ?2, ?3, 0)",
                    params![tree.as_str(), epoch as i64, root.to_hex()],
                )
                .map_err(|e| ServerError::Database(format!("signer_state insert failed: {e}")))?;
                Ok(())
            }
        }
    }

    fn next_leaf(&self, tree: SignerTree) -> Result<u32, ServerError> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| ServerError::Database("signer_state lock poisoned".to_string()))?;
        let next: i64 = conn
            .query_row(
                "SELECT next_leaf FROM signer_state WHERE tree_kind = ?1",
                params![tree.as_str()],
                |row| row.get(0),
            )
            .map_err(|e| ServerError::Database(format!("signer_state lookup failed: {e}")))?;
        u32::try_from(next)
            .map_err(|_| ServerError::Database("signer_state next_leaf out of range".to_string()))
    }

    fn reserve_leaf(
        &self,
        tree: SignerTree,
        epoch: u32,
        root: &Felt252,
        capacity: u32,
    ) -> Result<u32, ServerError> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| ServerError::Database("signer_state lock poisoned".to_string()))?;
        let tx = conn
            .transaction()
            .map_err(|e| ServerError::Database(format!("signer_state tx failed: {e}")))?;
        let row: (i64, String, i64) = tx
            .query_row(
                "SELECT epoch, root, next_leaf FROM signer_state WHERE tree_kind = ?1",
                params![tree.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|e| {
                ServerError::Database(format!("signer_state reserve lookup failed: {e}"))
            })?;
        if row.0 != epoch as i64 || row.1 != root.to_hex() {
            return Err(ServerError::Database(format!(
                "signer_state {} changed during signing",
                tree.as_str()
            )));
        }
        let next = u32::try_from(row.2).map_err(|_| {
            ServerError::Database("signer_state next_leaf out of range".to_string())
        })?;
        if next >= capacity {
            return Err(ServerError::CapacityExhausted);
        }
        tx.execute(
            "UPDATE signer_state SET next_leaf = ?1 WHERE tree_kind = ?2",
            params![(next + 1) as i64, tree.as_str()],
        )
        .map_err(|e| ServerError::Database(format!("signer_state reserve update failed: {e}")))?;
        tx.commit()
            .map_err(|e| ServerError::Database(format!("signer_state tx commit failed: {e}")))?;
        Ok(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_db(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("zkapi_ef_signer_{name}_{nonce}.db"))
    }

    #[test]
    fn test_sign_next_state_uses_predicted_leaf_index() {
        let signer =
            ServerSigner::with_height(FieldElement::from(3u64), FieldElement::from(5u64), 9, 4);

        let (sig, observed_leaf_index) = signer
            .sign_next_state(|leaf_index| (Felt252::from_u64(leaf_index as u64 + 11), leaf_index))
            .unwrap();

        assert_eq!(observed_leaf_index, 0);
        assert_eq!(sig.leaf_index, 0);
        assert_eq!(sig.epoch, 9);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn test_sign_next_state_is_safe_under_concurrency() {
        let signer = Arc::new(ServerSigner::with_height(
            FieldElement::from(7u64),
            FieldElement::from(11u64),
            3,
            5,
        ));

        let mut tasks = Vec::new();
        for _ in 0..8 {
            let signer = signer.clone();
            tasks.push(tokio::spawn(async move {
                let (sig, observed_leaf_index) = signer
                    .sign_next_state(|leaf_index| {
                        (Felt252::from_u64(leaf_index as u64 + 1000), leaf_index)
                    })
                    .unwrap();
                (sig.leaf_index, observed_leaf_index)
            }));
        }

        let mut indices = Vec::new();
        for task in tasks {
            let (sig_leaf_index, observed_leaf_index) = task.await.unwrap();
            assert_eq!(sig_leaf_index, observed_leaf_index);
            indices.push(sig_leaf_index);
        }

        indices.sort_unstable();
        assert_eq!(indices, (0u32..8u32).collect::<Vec<_>>());
    }

    #[test]
    fn durable_signer_restart_does_not_reuse_leaf() {
        let db = temp_db("restart");
        let state_seed = FieldElement::from(123u64);
        let clear_seed = FieldElement::from(456u64);
        let first = ServerSigner::with_height_durable(state_seed, clear_seed, 3, 4, &db).unwrap();
        let (sig0, leaf0) = first
            .sign_next_state(|leaf| (Felt252::from_u64(20_000 + leaf as u64), leaf))
            .unwrap();
        assert_eq!(leaf0, 0);
        assert_eq!(sig0.leaf_index, 0);
        drop(first);

        let restarted =
            ServerSigner::with_height_durable(state_seed, clear_seed, 3, 4, &db).unwrap();
        let (sig1, leaf1) = restarted
            .sign_next_state(|leaf| (Felt252::from_u64(20_000 + leaf as u64), leaf))
            .unwrap();
        assert_eq!(leaf1, 1);
        assert_eq!(sig1.leaf_index, 1);
        let _ = fs::remove_file(db);
    }

    #[test]
    fn durable_signer_allows_only_forward_epoch_rotation() {
        let db = temp_db("rotation");
        let first = ServerSigner::with_height_durable(
            FieldElement::from(123u64),
            FieldElement::from(456u64),
            3,
            4,
            &db,
        )
        .unwrap();
        let _ = first.sign_state(&Felt252::from_u64(1)).unwrap();
        drop(first);

        let rotated = ServerSigner::with_height_durable(
            FieldElement::from(789u64),
            FieldElement::from(987u64),
            4,
            4,
            &db,
        )
        .unwrap();
        let (_, leaf) = rotated.sign_state(&Felt252::from_u64(2)).unwrap();
        assert_eq!(leaf, 0);
        drop(rotated);

        let rollback = ServerSigner::with_height_durable(
            FieldElement::from(123u64),
            FieldElement::from(456u64),
            3,
            4,
            &db,
        );
        assert!(rollback.is_err());

        let reused_tree = ServerSigner::with_height_durable(
            FieldElement::from(789u64),
            FieldElement::from(987u64),
            5,
            4,
            &db,
        );
        assert!(reused_tree.is_err());
        let _ = fs::remove_file(db);
    }
}
