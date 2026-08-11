//! Stateless proof-friendly Schnorr signing for zkAPI v2.

use zkapi_proof::compact::CompactSigner;
use zkapi_types::wire::CurvePointWire;
use zkapi_types::{Felt252, SchnorrSignature};

pub struct ServerSigner {
    state: CompactSigner,
    clearance: CompactSigner,
}

impl ServerSigner {
    pub fn new(state_seed: &Felt252, clearance_seed: &Felt252) -> Self {
        Self {
            state: CompactSigner::from_seed(state_seed),
            clearance: CompactSigner::from_seed(clearance_seed),
        }
    }

    pub fn state_public_key(&self) -> CurvePointWire {
        self.state.public_key()
    }

    pub fn clearance_public_key(&self) -> CurvePointWire {
        self.clearance.public_key()
    }

    pub fn sign_state(&self, message: &Felt252) -> SchnorrSignature {
        self.state.sign(message)
    }

    pub fn sign_clearance(&self, message: &Felt252) -> SchnorrSignature {
        self.clearance.sign(message)
    }
}
