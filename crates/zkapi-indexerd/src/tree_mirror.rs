//! Local Merkle tree mirror maintained from contract events.

use zkapi_core::leaf::compute_note_leaf;
use zkapi_core::merkle::MerkleTree;
use zkapi_types::{Felt252, MERKLE_DEPTH};

use crate::events::VaultEvent;

/// A mirror of the on-chain Merkle tree, maintained by consuming events.
pub struct TreeMirror {
    tree: MerkleTree,
    next_note_id: u32,
    /// Original leaf values for each note (needed for challenge restores).
    original_leaves: std::collections::HashMap<u32, Felt252>,
}

impl TreeMirror {
    pub fn new() -> Self {
        Self {
            tree: MerkleTree::new(),
            next_note_id: 0,
            original_leaves: std::collections::HashMap::new(),
        }
    }

    /// Get the current root.
    pub fn root(&self) -> Felt252 {
        self.tree.root()
    }

    /// Get the next available note ID.
    pub fn next_note_id(&self) -> u32 {
        self.next_note_id
    }

    /// Get the sibling path for a note's current leaf.
    pub fn get_path(&self, note_id: u32) -> [Felt252; MERKLE_DEPTH] {
        self.tree.get_siblings(note_id)
    }

    /// Get the sibling path for a zero leaf at the given index.
    /// This is the same as get_path since the tree stores the current state.
    pub fn get_zero_path(&self, note_id: u32) -> [Felt252; MERKLE_DEPTH] {
        self.tree.get_siblings(note_id)
    }

    /// Get the leaf value at a given index.
    pub fn get_leaf(&self, note_id: u32) -> Felt252 {
        self.tree.get_leaf(note_id)
    }

    /// Process a contract event and update the tree.
    pub fn process_event(&mut self, event: &VaultEvent) {
        match event {
            VaultEvent::NoteDeposited {
                note_id,
                commitment,
                amount,
                expiry_ts,
                ..
            } => {
                let leaf = compute_note_leaf(*note_id, commitment, *amount, *expiry_ts);
                self.tree.set_leaf(*note_id, leaf);
                self.original_leaves.insert(*note_id, leaf);
                self.next_note_id = self.next_note_id.max(note_id.saturating_add(1));
            }
            VaultEvent::MutualClose { note_id, .. } => {
                self.tree.set_leaf(*note_id, Felt252::ZERO);
            }
            VaultEvent::EscapeWithdrawalInitiated { note_id, .. } => {
                // Leaf is zeroed immediately on initiation
                self.tree.set_leaf(*note_id, Felt252::ZERO);
            }
            VaultEvent::EscapeWithdrawalChallenged { note_id, .. } => {
                // Restore the original leaf
                if let Some(original) = self.original_leaves.get(note_id) {
                    self.tree.set_leaf(*note_id, *original);
                }
            }
            VaultEvent::EscapeWithdrawalFinalized { note_id: _, .. } => {
                // Leaf was already zeroed during initiation, nothing more to do
            }
            VaultEvent::ExpiredClaimed { note_id, .. } => {
                self.tree.set_leaf(*note_id, Felt252::ZERO);
            }
        }
    }
}

impl Default for TreeMirror {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_deposit_and_close() {
        let mut mirror = TreeMirror::new();
        let commitment = Felt252::from_u64(12345);

        // Deposit
        mirror.process_event(&VaultEvent::NoteDeposited {
            note_id: 0,
            commitment,
            amount: 1000,
            expiry_ts: 1700000000,
            new_root: Felt252::ZERO, // We don't use this
        });

        let root_after_deposit = mirror.root();
        assert_ne!(root_after_deposit, MerkleTree::new().root());

        // Close
        mirror.process_event(&VaultEvent::MutualClose {
            note_id: 0,
            nullifier: Felt252::from_u64(999),
            final_balance: 900,
        });

        // Should be back to empty
        assert_eq!(mirror.root(), MerkleTree::new().root());
    }

    #[test]
    fn test_escape_and_challenge() {
        let mut mirror = TreeMirror::new();
        let commitment = Felt252::from_u64(12345);

        // Deposit
        mirror.process_event(&VaultEvent::NoteDeposited {
            note_id: 0,
            commitment,
            amount: 1000,
            expiry_ts: 1700000000,
            new_root: Felt252::ZERO,
        });
        let root_after_deposit = mirror.root();

        // Escape withdrawal initiation (zeroes leaf)
        mirror.process_event(&VaultEvent::EscapeWithdrawalInitiated {
            note_id: 0,
            nullifier: Felt252::from_u64(999),
            final_balance: 900,
            challenge_deadline: 1700086400,
            new_root: Felt252::ZERO,
        });
        assert_ne!(mirror.root(), root_after_deposit);

        // Challenge (restores leaf)
        mirror.process_event(&VaultEvent::EscapeWithdrawalChallenged {
            note_id: 0,
            nullifier: Felt252::from_u64(999),
            restored_root: Felt252::ZERO,
        });
        assert_eq!(mirror.root(), root_after_deposit);
    }

    #[test]
    fn test_multiple_deposits() {
        let mut mirror = TreeMirror::new();

        for i in 0..5 {
            mirror.process_event(&VaultEvent::NoteDeposited {
                note_id: i,
                commitment: Felt252::from_u64(i as u64 + 100),
                amount: 1000,
                expiry_ts: 1700000000,
                new_root: Felt252::ZERO,
            });
        }

        // All leaves should be accessible
        for i in 0..5 {
            let leaf = mirror.get_leaf(i);
            assert!(!leaf.is_zero());
        }
    }
}
