//! Contract event types for the indexer.

use serde::{Deserialize, Serialize};
use zkapi_types::Felt252;

/// Events emitted by the ZkApiVault contract that affect the Merkle tree.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum VaultEvent {
    NoteDeposited {
        note_id: u32,
        commitment: Felt252,
        amount: u128,
        expiry_ts: u64,
        new_root: Felt252,
    },
    MutualClose {
        note_id: u32,
        nullifier: Felt252,
        final_balance: u128,
    },
    EscapeWithdrawalInitiated {
        note_id: u32,
        nullifier: Felt252,
        final_balance: u128,
        challenge_deadline: u64,
        new_root: Felt252,
    },
    EscapeWithdrawalChallenged {
        note_id: u32,
        nullifier: Felt252,
        restored_root: Felt252,
    },
    EscapeWithdrawalFinalized {
        note_id: u32,
        nullifier: Felt252,
        final_balance: u128,
    },
    ExpiredClaimed {
        note_id: u32,
        deposit_amount: u128,
        new_root: Felt252,
    },
}
