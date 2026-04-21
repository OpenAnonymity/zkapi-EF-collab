//! Server signing module that manages XMSS keypairs.
//!
//! The server maintains two XMSS trees:
//! - state keypair: signs state transitions (next commitment + anchor)
//! - clear keypair: signs clearance messages for mutual close

use std::sync::Mutex;

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
    state_op_lock: Mutex<()>,
    clear_op_lock: Mutex<()>,
}

impl ServerSigner {
    /// Create a new server signer from seeds and an epoch number.
    ///
    /// `state_seed` is used to derive the state-signing XMSS tree.
    /// `clear_seed` is used to derive the clearance-signing XMSS tree.
    /// `epoch` is the initial epoch number assigned to both trees.
    pub fn new(state_seed: FieldElement, clear_seed: FieldElement, epoch: u32) -> Self {
        Self::with_height(state_seed, clear_seed, epoch, zkapi_types::XMSS_TREE_HEIGHT)
    }

    /// Create a signer with a custom tree height (for testing).
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
            state_op_lock: Mutex::new(()),
            clear_op_lock: Mutex::new(()),
        }
    }

    /// Sign a state message using the state XMSS keypair.
    ///
    /// Returns the signature with the correct epoch set, plus the leaf index used.
    pub fn sign_state(&self, message: &Felt252) -> Result<(XmssSignature, u32), ServerError> {
        let _lock = self
            .state_op_lock
            .lock()
            .map_err(|_| ServerError::Internal("state signer lock poisoned".to_string()))?;
        let (mut sig, leaf_index) = self
            .state_keypair
            .sign(message)
            .ok_or(ServerError::CapacityExhausted)?;
        sig.epoch = self.state_epoch;
        Ok((sig, leaf_index))
    }

    /// Compute a state message from the next leaf index and sign it under one lock.
    pub fn sign_next_state<T, F>(&self, build_message: F) -> Result<(XmssSignature, T), ServerError>
    where
        F: FnOnce(u32) -> (Felt252, T),
    {
        let _lock = self
            .state_op_lock
            .lock()
            .map_err(|_| ServerError::Internal("state signer lock poisoned".to_string()))?;
        let predicted_leaf_index = self.state_keypair.next_index();
        let (message, context) = build_message(predicted_leaf_index);
        let (mut sig, actual_leaf_index) = self
            .state_keypair
            .sign(&message)
            .ok_or(ServerError::CapacityExhausted)?;
        if actual_leaf_index != predicted_leaf_index {
            return Err(ServerError::Internal(format!(
                "state signer leaf index changed during signing: predicted={}, actual={}",
                predicted_leaf_index, actual_leaf_index
            )));
        }
        sig.epoch = self.state_epoch;
        Ok((sig, context))
    }

    /// Sign a clearance message using the clearance XMSS keypair.
    ///
    /// Returns the signature with the correct epoch set, plus the leaf index used.
    pub fn sign_clearance(&self, message: &Felt252) -> Result<(XmssSignature, u32), ServerError> {
        let _lock = self
            .clear_op_lock
            .lock()
            .map_err(|_| ServerError::Internal("clear signer lock poisoned".to_string()))?;
        let (mut sig, leaf_index) = self
            .clear_keypair
            .sign(message)
            .ok_or(ServerError::CapacityExhausted)?;
        sig.epoch = self.clear_epoch;
        Ok((sig, leaf_index))
    }

    /// Get the state XMSS tree root as a Felt252.
    pub fn state_root(&self) -> Felt252 {
        self.state_keypair.root_felt()
    }

    /// Get the clearance XMSS tree root as a Felt252.
    pub fn clear_root(&self) -> Felt252 {
        self.clear_keypair.root_felt()
    }

    /// Get the current state epoch.
    pub fn epoch(&self) -> u32 {
        self.state_epoch
    }

    /// Get the current clear epoch.
    pub fn clear_epoch(&self) -> u32 {
        self.clear_epoch
    }

    /// Check remaining state signatures.
    pub fn state_remaining(&self) -> u32 {
        self.state_keypair.remaining()
    }

    /// Check remaining clearance signatures.
    pub fn clear_remaining(&self) -> u32 {
        self.clear_keypair.remaining()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

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
}
