//! Cross-crate integration tests for the zkAPI stack.
//!
//! Exercises the full request lifecycle end-to-end — deposit, genesis
//! registration, request flow with state updates, crash recovery, and both
//! withdrawal paths — against a stub serverd that returns canned,
//! validly-signed responses, with no chain or indexer dependency.
//!
//! This crate root re-exports the shared [`fixtures`] used by the tests under
//! `tests/`: deposit fixtures, the mock server, and request-artifact builders.

pub mod fixtures;
