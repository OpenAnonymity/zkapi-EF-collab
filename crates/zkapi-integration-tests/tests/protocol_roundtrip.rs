use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use base64::Engine;
use tower::util::ServiceExt;
use zkapi_core::leaf::compute_registration_commitment;
use zkapi_core::merkle::verify_membership;
use zkapi_core::poseidon::FieldElement;
use zkapi_integration_tests::fixtures::{
    build_request_artifacts, deposit_fixture, mock_router, TEST_CHAIN_ID, TEST_CONTRACT_ADDRESS,
    TEST_PROTOCOL_VERSION,
};
use zkapi_proof::{verify_request_proof, verify_withdrawal_proof};
use zkapi_types::wire::{ClearanceResponse, ErrorResponse, RecoveryResponse};
use zkapi_types::Felt252;

#[tokio::test]
async fn router_rejects_stale_roots_with_conflict_and_latest_root() {
    let fixture = deposit_fixture();
    let router = mock_router(fixture.active_root);
    let mut stale_request = build_request_artifacts(
        &zkapi_client::note_state::NoteState::new_from_deposit(
            TEST_PROTOCOL_VERSION,
            TEST_CHAIN_ID,
            TEST_CONTRACT_ADDRESS,
            fixture.note_id,
            fixture.secret_s,
            fixture.deposit_amount,
            fixture.expiry_ts,
            "0x1".to_string(),
            Felt252::from_u64(1),
            Felt252::from_u64(2),
        ),
        fixture.active_root,
        fixture.merkle_siblings,
        "{\"op\":\"quote\"}",
        Felt252::from_u64(11),
        "stale-root",
        FieldElement::from(7u64),
    );
    stale_request.api_request.public_inputs.active_root = Felt252::from_u64(99);

    let response = router
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/requests")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&stale_request.api_request).expect("request json"),
                ))
                .expect("request"),
        )
        .await
        .expect("router response");

    assert_eq!(response.status(), StatusCode::CONFLICT);
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("error body");
    let error: ErrorResponse = serde_json::from_slice(&body).expect("error response");
    assert_eq!(error.error_code, "STALE_ROOT");
    assert_eq!(error.latest_root, Some(fixture.active_root));
}

#[tokio::test]
async fn router_finalizes_requests_and_exposes_recovery_endpoints() {
    let fixture = deposit_fixture();
    let router = mock_router(fixture.active_root);
    let note_state = zkapi_client::note_state::NoteState::new_from_deposit(
        TEST_PROTOCOL_VERSION,
        TEST_CHAIN_ID,
        TEST_CONTRACT_ADDRESS,
        fixture.note_id,
        fixture.secret_s,
        fixture.deposit_amount,
        fixture.expiry_ts,
        "0x1".to_string(),
        Felt252::from_u64(1),
        Felt252::from_u64(2),
    );
    let request = build_request_artifacts(
        &note_state,
        fixture.active_root,
        fixture.merkle_siblings,
        "{\"op\":\"echo\"}",
        Felt252::from_u64(22),
        "req-finalized",
        FieldElement::from(9u64),
    );

    let submit = router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/requests")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&request.api_request).expect("submit json"),
                ))
                .expect("submit request"),
        )
        .await
        .expect("submit response");
    assert_eq!(submit.status(), StatusCode::OK);

    let recovery = router
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v1/requests/req-finalized")
                .body(Body::empty())
                .expect("recovery request"),
        )
        .await
        .expect("recovery response");
    assert_eq!(recovery.status(), StatusCode::OK);
    let recovery_body = to_bytes(recovery.into_body(), usize::MAX)
        .await
        .expect("recovery body");
    let recovery: RecoveryResponse =
        serde_json::from_slice(&recovery_body).expect("recovery payload");
    assert_eq!(recovery.nullifier_status, "finalized");
    let recovered = recovery.request_response.expect("finalized response");
    assert_eq!(
        recovered.request_nullifier,
        request.public_inputs.request_nullifier
    );
    assert_eq!(recovered.charge_applied, 1);

    let by_nullifier = router
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!(
                    "/v1/nullifiers/{}",
                    request.public_inputs.request_nullifier.to_hex()
                ))
                .body(Body::empty())
                .expect("nullifier recovery request"),
        )
        .await
        .expect("nullifier recovery response");
    assert_eq!(by_nullifier.status(), StatusCode::OK);
}

#[tokio::test]
async fn clearance_endpoint_enables_verifiable_mutual_close_proofs() {
    let fixture = deposit_fixture();
    let router = mock_router(fixture.active_root);
    let note_state = zkapi_client::note_state::NoteState::new_from_deposit(
        TEST_PROTOCOL_VERSION,
        TEST_CHAIN_ID,
        TEST_CONTRACT_ADDRESS,
        fixture.note_id,
        fixture.secret_s,
        fixture.deposit_amount,
        fixture.expiry_ts,
        "0x1".to_string(),
        Felt252::from_u64(1),
        Felt252::from_u64(2),
    );
    let withdrawal_nullifier =
        zkapi_core::nullifier::compute_nullifier(&note_state.secret_s, &note_state.current_anchor);

    let clearance_response = router
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/withdraw/clearance")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&zkapi_types::wire::ClearanceRequest {
                        withdrawal_nullifier,
                    })
                    .expect("clearance json"),
                ))
                .expect("clearance request"),
        )
        .await
        .expect("clearance response");
    assert_eq!(clearance_response.status(), StatusCode::OK);

    let body = to_bytes(clearance_response.into_body(), usize::MAX)
        .await
        .expect("clearance body");
    let clearance: ClearanceResponse = serde_json::from_slice(&body).expect("clearance payload");

    let destination = [0x11; 20];
    let builder = zkapi_proof::WithdrawalProofBuilder::new(
        note_state.secret_s,
        note_state.note_id,
        note_state.deposit_amount,
        note_state.expiry_ts,
        fixture.merkle_siblings,
        note_state.current_balance,
        FieldElement::from(1u64),
        note_state.current_anchor,
        note_state.is_genesis,
        0,
        Felt252::ZERO,
        true,
        clearance.clear_sig_epoch,
        clearance.clear_sig_root,
        destination,
        fixture.active_root,
        note_state.protocol_version,
        note_state.chain_id,
        note_state.contract_address,
    );
    let public_inputs = builder.build_public_inputs();
    let proof = builder
        .generate_proof(None, Some(&clearance.clear_sig))
        .expect("withdrawal proof");

    verify_withdrawal_proof(&proof, &public_inputs).expect("valid mutual-close proof");
    assert!(public_inputs.has_clearance);
}

#[test]
fn request_artifacts_round_trip_through_merkle_and_proof_verification() {
    let fixture = deposit_fixture();
    let note_state = zkapi_client::note_state::NoteState::new_from_deposit(
        TEST_PROTOCOL_VERSION,
        TEST_CHAIN_ID,
        TEST_CONTRACT_ADDRESS,
        fixture.note_id,
        fixture.secret_s,
        fixture.deposit_amount,
        fixture.expiry_ts,
        "0x1".to_string(),
        Felt252::from_u64(1),
        Felt252::from_u64(2),
    );
    let request = build_request_artifacts(
        &note_state,
        fixture.active_root,
        fixture.merkle_siblings,
        "{\"op\":\"proof-roundtrip\"}",
        Felt252::from_u64(33),
        "proof-roundtrip",
        FieldElement::from(3u64),
    );
    let proof_bytes = base64::engine::general_purpose::STANDARD
        .decode(request.api_request.proof_envelope.as_bytes())
        .expect("proof bytes");
    let leaf = compute_note_leaf_for_fixture();

    assert!(verify_membership(
        &fixture.active_root,
        fixture.note_id,
        &leaf,
        &fixture.merkle_siblings
    ));
    verify_request_proof(&proof_bytes, &request.public_inputs).expect("request proof");
}

fn compute_note_leaf_for_fixture() -> Felt252 {
    let fixture = deposit_fixture();
    let commitment = compute_registration_commitment(&fixture.secret_s);
    zkapi_core::leaf::compute_note_leaf(
        fixture.note_id,
        &commitment,
        fixture.deposit_amount,
        fixture.expiry_ts,
    )
}
