//! Server-side logic for the zkAPI protocol.
//!
//! This crate implements proof verification, nullifier storage, API execution,
//! XMSS signing, and HTTP routes for the zkAPI server.

pub mod config;
pub mod dashboard;
pub mod error;
pub mod metered_provider;
pub mod nullifier_store;
pub mod openrouter;
pub mod pricing;
pub mod processor;
pub mod provider;
pub mod routes;
pub mod signer;
pub mod watcher;
