//! Indexer HTTP service exposing tree data.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};

use zkapi_types::{Felt252, MERKLE_DEPTH};

use crate::events::VaultEvent;
use crate::tree_mirror::{TreeMirror, TreeMirrorSnapshot};

/// The indexer service wraps a TreeMirror and provides read access.
pub struct IndexerService {
    mirror: Arc<RwLock<TreeMirror>>,
    ready: AtomicBool,
}

impl IndexerService {
    pub fn new(mirror: Arc<RwLock<TreeMirror>>) -> Self {
        Self {
            mirror,
            ready: AtomicBool::new(true),
        }
    }

    /// Construct an indexer that must finish its initial replay before serving
    /// tree data.
    pub fn new_syncing(mirror: Arc<RwLock<TreeMirror>>) -> Self {
        Self {
            mirror,
            ready: AtomicBool::new(false),
        }
    }

    pub fn is_ready(&self) -> bool {
        self.ready.load(Ordering::Acquire)
    }

    pub fn mark_ready(&self) {
        self.ready.store(true, Ordering::Release);
    }

    pub fn snapshot(&self) -> TreeMirrorSnapshot {
        self.mirror.read().unwrap().snapshot()
    }

    pub fn restore(&self, snapshot: TreeMirrorSnapshot) -> Result<(), String> {
        *self.mirror.write().unwrap() = TreeMirror::from_snapshot(snapshot)?;
        Ok(())
    }

    /// GET /v1/tree/root
    pub fn get_root(&self) -> Felt252 {
        self.mirror.read().unwrap().root()
    }

    /// GET /v1/tree/next-note-id
    pub fn get_next_note_id(&self) -> u32 {
        self.mirror.read().unwrap().next_note_id()
    }

    /// GET /v1/tree/notes/{note_id}/path
    pub fn get_note_path(&self, note_id: u32) -> [Felt252; MERKLE_DEPTH] {
        self.mirror.read().unwrap().get_path(note_id)
    }

    /// GET /v1/tree/notes/{note_id}/zero-path
    pub fn get_zero_path(&self, note_id: u32) -> [Felt252; MERKLE_DEPTH] {
        self.mirror.read().unwrap().get_zero_path(note_id)
    }

    /// Get the leaf value at a given index.
    pub fn get_leaf(&self, note_id: u32) -> Felt252 {
        self.mirror.read().unwrap().get_leaf(note_id)
    }

    /// Whole-tree snapshot: root, next free index, and every current leaf.
    pub fn get_snapshot(&self) -> TreeSnapshotResponse {
        let mirror = self.mirror.read().unwrap();
        TreeSnapshotResponse {
            root: mirror.root(),
            next_note_id: mirror.next_note_id(),
            leaves: mirror.current_leaves(),
        }
    }

    /// Apply a decoded contract event to the mirrored tree.
    pub fn process_event(&self, event: &VaultEvent) {
        self.mirror.write().unwrap().process_event(event);
    }
}

/// Response type for tree endpoints.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TreeRootResponse {
    pub root: Felt252,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TreePathResponse {
    pub note_id: u32,
    pub leaf: Felt252,
    pub siblings: Vec<Felt252>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct NextNoteIdResponse {
    pub next_note_id: u32,
}

/// Whole-tree snapshot: clients rebuild the tree and derive any sibling path
/// locally, so the untrusted indexer never learns which note a client queries.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TreeSnapshotResponse {
    pub root: Felt252,
    pub next_note_id: u32,
    pub leaves: Vec<Felt252>,
}
