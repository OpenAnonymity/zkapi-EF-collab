use base64::Engine;
use zkapi_client::journal::PendingRequestJournal;
use zkapi_client::wallet::Wallet;
use zkapi_core::poseidon::FieldElement;
use zkapi_integration_tests::fixtures::{
    build_request_artifacts, deposit_fixture, journal_path, spawn_mock_server, state_path,
    wallet_config,
};
use zkapi_proof::verify_withdrawal_proof;
use zkapi_types::Felt252;

#[tokio::test]
async fn wallet_request_flow_updates_note_state_against_live_server() {
    let fixture = deposit_fixture();
    let server = spawn_mock_server(fixture.active_root).await;
    let state_dir = tempfile::TempDir::new().expect("wallet temp dir");
    let mut wallet =
        Wallet::new(wallet_config(&server.base_url, state_dir.path())).expect("wallet");

    wallet
        .confirm_deposit(
            fixture.secret_s,
            fixture.note_id,
            fixture.deposit_amount,
            fixture.expiry_ts,
        )
        .expect("confirm deposit");

    let payload = "{\"op\":\"weather\",\"city\":\"Gwangju\"}";
    let response = wallet
        .request_flow(
            payload,
            zkapi_types::canonical_payload_hash(payload.as_bytes()),
            fixture.active_root,
            fixture.merkle_siblings.to_vec(),
        )
        .await
        .expect("request flow");

    assert_eq!(response.status, "ok");
    assert_eq!(response.charge_applied, 1);
    assert!(wallet
        .get_pending_journal()
        .expect("journal read")
        .is_none());

    let state = wallet.state().expect("updated state");
    assert!(!state.is_genesis);
    assert_eq!(state.current_balance, fixture.deposit_amount - 1);
    assert_eq!(state.current_anchor, response.next_anchor);
}

/// Several authenticated requests in a row must each succeed.
///
/// This is the regression guard for the historical multi-request defect where
/// the second and later requests failed state-signature verification: the
/// client re-derived the balance commitment a different way than the value the
/// server actually signed, so `XmssVerifier::verify` rejected the stored state
/// signature on every non-genesis request. The first request is genesis (no
/// prior state signature); request #2 onward exercise the non-genesis path and
/// must verify the previously stored state signature against the re-derived
/// commitment.
#[tokio::test]
async fn wallet_handles_sequential_requests() {
    let fixture = deposit_fixture();
    let server = spawn_mock_server(fixture.active_root).await;
    let state_dir = tempfile::TempDir::new().expect("wallet temp dir");
    let mut wallet =
        Wallet::new(wallet_config(&server.base_url, state_dir.path())).expect("wallet");

    wallet
        .confirm_deposit(
            fixture.secret_s,
            fixture.note_id,
            fixture.deposit_amount,
            fixture.expiry_ts,
        )
        .expect("confirm deposit");

    for i in 0..5 {
        let payload = format!("{{\"op\":\"ping\",\"seq\":{i}}}");
        let response = wallet
            .request_flow(
                &payload,
                zkapi_types::canonical_payload_hash(payload.as_bytes()),
                fixture.active_root,
                fixture.merkle_siblings.to_vec(),
            )
            .await
            .unwrap_or_else(|err| panic!("request #{} failed: {err}", i + 1));

        assert_eq!(response.status, "ok");
        let state = wallet.state().expect("state after request");
        assert!(!state.is_genesis);
        // Each request charges 1 unit (the mock server's fixed charge).
        assert_eq!(state.current_balance, fixture.deposit_amount - (i + 1));
        assert_eq!(state.current_anchor, response.next_anchor);
    }
}

#[tokio::test]
async fn wallet_recover_restores_state_from_server_transcript() {
    let fixture = deposit_fixture();
    let server = spawn_mock_server(fixture.active_root).await;
    let state_dir = tempfile::TempDir::new().expect("wallet temp dir");
    let config = wallet_config(&server.base_url, state_dir.path());
    let mut wallet = Wallet::new(config).expect("wallet");

    wallet
        .confirm_deposit(
            fixture.secret_s,
            fixture.note_id,
            fixture.deposit_amount,
            fixture.expiry_ts,
        )
        .expect("confirm deposit");

    let note_state = wallet.state().expect("state").clone();
    let request = build_request_artifacts(
        &note_state,
        fixture.active_root,
        fixture.merkle_siblings,
        "{\"op\":\"recover\"}",
        Felt252::from_u64(88),
        "recoverable-request",
        FieldElement::from(5u64),
    );
    PendingRequestJournal::write(&journal_path(state_dir.path()), &request.journal)
        .expect("journal write");

    let response = reqwest::Client::new()
        .post(format!("{}/v1/requests", server.base_url))
        .json(&request.api_request)
        .send()
        .await
        .expect("submit request");
    assert!(response.status().is_success());

    let mut recovered_wallet =
        Wallet::new(wallet_config(&server.base_url, state_dir.path())).expect("reloaded wallet");
    let recovered = recovered_wallet
        .recover()
        .await
        .expect("wallet recover")
        .expect("finalized response");

    assert_eq!(recovered.client_request_id, "recoverable-request");
    assert!(recovered_wallet
        .get_pending_journal()
        .expect("journal")
        .is_none());
    assert!(state_path(state_dir.path()).exists());

    let state = recovered_wallet.state().expect("recovered state");
    assert_eq!(state.current_balance, fixture.deposit_amount - 1);
    assert_eq!(state.current_anchor, recovered.next_anchor);
}

#[tokio::test]
async fn wallet_withdrawal_flows_emit_verifiable_proofs() {
    let fixture = deposit_fixture();
    let server = spawn_mock_server(fixture.active_root).await;
    let state_dir = tempfile::TempDir::new().expect("wallet temp dir");
    let mut wallet =
        Wallet::new(wallet_config(&server.base_url, state_dir.path())).expect("wallet");

    wallet
        .confirm_deposit(
            fixture.secret_s,
            fixture.note_id,
            fixture.deposit_amount,
            fixture.expiry_ts,
        )
        .expect("confirm deposit");

    let destination = [0x22; 20];
    let (mutual_inputs, mutual_proof) = wallet
        .withdrawal_mutual_close(
            destination,
            fixture.active_root,
            fixture.merkle_siblings.to_vec(),
        )
        .await
        .expect("mutual close");
    let mutual_proof_bytes = base64::engine::general_purpose::STANDARD
        .decode(mutual_proof.proof.as_bytes())
        .expect("decode mutual proof");
    verify_withdrawal_proof(&mutual_proof_bytes, &mutual_inputs).expect("mutual-close proof");
    assert!(mutual_inputs.has_clearance);

    let (escape_inputs, escape_proof) = wallet
        .withdrawal_escape_hatch(
            destination,
            fixture.active_root,
            fixture.merkle_siblings.to_vec(),
        )
        .expect("escape hatch");
    let escape_proof_bytes = base64::engine::general_purpose::STANDARD
        .decode(escape_proof.proof.as_bytes())
        .expect("decode escape proof");
    verify_withdrawal_proof(&escape_proof_bytes, &escape_inputs).expect("escape-hatch proof");
    assert!(!escape_inputs.has_clearance);
}
