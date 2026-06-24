//! State-anchor authentication method (the reference implementation).
//!
//! This is the existing zkAPI scheme expressed behind [`CredentialScheme`]: a
//! Pedersen balance commitment, a nullifier chain (`anchor`), and an XMSS
//! signature carrying the state forward. It delegates to the `protocol` crypto
//! module's primitives (`PedersenCommitment`, `compute_nullifier`,
//! `compute_next_anchor`, `compute_blind_delta`, `compute_state_message`,
//! `XmssKeypair`) rather than reimplementing them — the daemons run exactly
//! this logic across the HTTP boundary.

use std::collections::HashSet;

use sha3::{Digest, Keccak256};
use starknet_types_core::felt::Felt;

use zkapi_core::commitment::{compute_blind_delta, compute_next_anchor, compute_state_message};
use zkapi_core::nullifier::compute_nullifier;
use zkapi_core::poseidon::{felt_to_field, field_to_felt};
use zkapi_crypto::pedersen::{add_blinding, PedersenCommitment};
use zkapi_crypto::xmss::{XmssKeypair, XmssVerifier};
use zkapi_types::{Felt252, XmssSignature, GENESIS_ANCHOR};

use crate::blind_schnorr::random_scalar;
use crate::{AuthError, AuthSchemeKind, CredentialScheme};

/// Client-held state-anchor credential.
#[derive(Clone)]
pub struct StateAnchorCredential {
    secret: Felt252,
    balance: u128,
    /// Blinding factor (curve-order scalar) opening the current commitment.
    blinding: Felt,
    anchor: Felt252,
    is_genesis: bool,
    state_sig: Option<XmssSignature>,
    state_sig_root: Felt252,
}

/// Per-request presentation: the rerandomized commitment opening plus the
/// nullifier and the carried-forward state signature.
pub struct StateAnchorPresentation {
    balance: u128,
    blinding: Felt,
    user_rerand: Felt,
    anchor: Felt252,
    nullifier: Felt252,
    is_genesis: bool,
    state_sig: Option<XmssSignature>,
    state_sig_root: Felt252,
}

/// State-anchor scheme: holds the server XMSS signer and the spent-nullifier
/// set (the in-process stand-in for serverd's signer + nullifier store).
pub struct StateAnchorScheme {
    signer: XmssKeypair,
    epoch: u32,
    protocol_version: u16,
    chain_id: u64,
    contract: Felt252,
    spent: HashSet<Felt252>,
}

impl StateAnchorScheme {
    pub fn new(
        signer: XmssKeypair,
        epoch: u32,
        protocol_version: u16,
        chain_id: u64,
        contract: Felt252,
    ) -> Self {
        Self {
            signer,
            epoch,
            protocol_version,
            chain_id,
            contract,
            spent: HashSet::new(),
        }
    }

    /// Deterministic instance for tests / local demos (small XMSS tree so
    /// keygen is fast).
    pub fn new_for_test() -> Self {
        let signer = XmssKeypair::generate_with_height(&Felt::from(0x57a7eu64), 8);
        Self::new(signer, 1, 1, 31337, Felt252::from_u64(0xca7e))
    }

    /// Commitment coordinates for `(balance, blinding)` as wire felts.
    fn commitment_coords(balance: u128, blinding: &Felt) -> (Felt252, Felt252) {
        let (x, y) = PedersenCommitment::commit(balance, blinding).to_affine();
        (field_to_felt(&x), field_to_felt(&y))
    }

    /// Deterministic per-request server randomness derived from the nullifier.
    fn server_rng(nullifier: &Felt252, tag: u8) -> Felt252 {
        let mut hasher = Keccak256::new();
        hasher.update(b"zkapi.sa.srv-rng.v1");
        hasher.update([tag]);
        hasher.update(nullifier.as_bytes());
        field_to_felt(&crate::scalar::from_bytes_reduced(&hasher.finalize()))
    }

    /// Verify the XMSS state signature over the commitment opened by
    /// `(balance, blinding)` at `anchor`. Genesis credentials carry no prior
    /// signature.
    fn verify_state_sig(
        &self,
        balance: u128,
        blinding: &Felt,
        anchor: &Felt252,
        is_genesis: bool,
        state_sig: Option<&XmssSignature>,
        state_sig_root: &Felt252,
    ) -> Result<(), AuthError> {
        if is_genesis {
            return Ok(());
        }
        let sig = state_sig.ok_or_else(|| {
            AuthError::VerificationFailed("missing non-genesis state signature".into())
        })?;
        let (cx, cy) = Self::commitment_coords(balance, blinding);
        let message = compute_state_message(
            self.protocol_version,
            self.chain_id,
            &self.contract,
            &cx,
            &cy,
            anchor,
        );
        if !XmssVerifier::verify(state_sig_root, &message, sig) {
            return Err(AuthError::VerificationFailed(
                "XMSS state signature verification failed".into(),
            ));
        }
        Ok(())
    }
}

impl CredentialScheme for StateAnchorScheme {
    type Credential = StateAnchorCredential;
    type Presentation = StateAnchorPresentation;
    type Withdrawal = StateAnchorPresentation;

    fn kind(&self) -> AuthSchemeKind {
        AuthSchemeKind::StateAnchor
    }

    fn issue(&mut self, secret: Felt, balance: u128) -> Result<Self::Credential, AuthError> {
        let mut rng = rand::thread_rng();
        Ok(StateAnchorCredential {
            secret: field_to_felt(&secret),
            balance,
            blinding: random_scalar(&mut rng),
            anchor: Felt252::from_u64(GENESIS_ANCHOR),
            is_genesis: true,
            state_sig: None,
            state_sig_root: Felt252::ZERO,
        })
    }

    fn authenticate(
        &self,
        cred: &Self::Credential,
        charge_cap: u128,
    ) -> Result<(Self::Presentation, Felt), AuthError> {
        if cred.balance < charge_cap {
            return Err(AuthError::InsufficientBalance {
                have: cred.balance,
                need: charge_cap,
            });
        }
        let mut rng = rand::thread_rng();
        let user_rerand = random_scalar(&mut rng);
        let nullifier = compute_nullifier(&cred.secret, &cred.anchor);
        let presentation = StateAnchorPresentation {
            balance: cred.balance,
            blinding: cred.blinding,
            user_rerand,
            anchor: cred.anchor,
            nullifier,
            is_genesis: cred.is_genesis,
            state_sig: cred.state_sig.clone(),
            state_sig_root: cred.state_sig_root,
        };
        Ok((presentation, felt_to_field(&nullifier)))
    }

    fn verify(&mut self, p: &Self::Presentation) -> Result<Felt, AuthError> {
        self.verify_state_sig(
            p.balance,
            &p.blinding,
            &p.anchor,
            p.is_genesis,
            p.state_sig.as_ref(),
            &p.state_sig_root,
        )?;
        if !self.spent.insert(p.nullifier) {
            return Err(AuthError::Replay);
        }
        Ok(felt_to_field(&p.nullifier))
    }

    fn apply_charge(
        &mut self,
        cred: &Self::Credential,
        p: &Self::Presentation,
        charge: u128,
    ) -> Result<Self::Credential, AuthError> {
        let next_balance =
            cred.balance
                .checked_sub(charge)
                .ok_or(AuthError::InsufficientBalance {
                    have: cred.balance,
                    need: charge,
                })?;

        let leaf_index = self.signer.next_index();
        let server_rng = Self::server_rng(&p.nullifier, 1);
        let server_rng2 = Self::server_rng(&p.nullifier, 2);

        // nextBlinding = currentBlinding + userRerand + blindDelta  (mod n)
        let blind_delta =
            felt_to_field(&compute_blind_delta(&server_rng2, &p.nullifier, leaf_index));
        let next_blinding =
            add_blinding(&add_blinding(&cred.blinding, &p.user_rerand), &blind_delta);

        let (ncx, ncy) = Self::commitment_coords(next_balance, &next_blinding);
        let next_anchor = compute_next_anchor(&server_rng, &p.nullifier, &ncx, &ncy, leaf_index);
        let message = compute_state_message(
            self.protocol_version,
            self.chain_id,
            &self.contract,
            &ncx,
            &ncy,
            &next_anchor,
        );
        let (mut state_sig, signed_index) = self
            .signer
            .sign(&message)
            .ok_or_else(|| AuthError::Crypto("XMSS signing capacity exhausted".into()))?;
        if signed_index != leaf_index {
            return Err(AuthError::Crypto(
                "XMSS leaf index moved unexpectedly".into(),
            ));
        }
        state_sig.epoch = self.epoch;

        Ok(StateAnchorCredential {
            secret: cred.secret,
            balance: next_balance,
            blinding: next_blinding,
            anchor: next_anchor,
            is_genesis: false,
            state_sig: Some(state_sig),
            state_sig_root: self.signer.root_felt(),
        })
    }

    fn build_withdrawal(&self, cred: &Self::Credential) -> Result<Self::Withdrawal, AuthError> {
        // Reveal the final commitment opening; the withdrawal nullifier is the
        // nullifier for the (never-spent) final anchor.
        Ok(StateAnchorPresentation {
            balance: cred.balance,
            blinding: cred.blinding,
            user_rerand: Felt::ZERO,
            anchor: cred.anchor,
            nullifier: compute_nullifier(&cred.secret, &cred.anchor),
            is_genesis: cred.is_genesis,
            state_sig: cred.state_sig.clone(),
            state_sig_root: cred.state_sig_root,
        })
    }

    fn verify_withdrawal(&mut self, w: &Self::Withdrawal) -> Result<(u128, Felt), AuthError> {
        let token = self.verify(w)?;
        Ok((w.balance, token))
    }

    fn balance(&self, cred: &Self::Credential) -> u128 {
        cred.balance
    }
}
