//! Server-side logic for the zkAPI protocol.
//!
//! This crate implements proof verification, nullifier storage, API execution,
//! XMSS signing, and HTTP routes for the zkAPI server.

pub mod config;
pub mod dashboard;
pub mod error;
pub mod metered_provider;
pub mod nullifier_store;
pub mod pricing;
#[path = "processor_v2.rs"]
pub mod processor;
pub mod provider;
pub mod routes;
#[path = "signer_v2.rs"]
pub mod signer;
pub mod watcher;
