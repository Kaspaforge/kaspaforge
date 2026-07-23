//! Offline integration tests: the published recovery fixtures + attack vectors, and the fail-closed
//! envelope / mutual-package verification. No node required.

use kaspa_consensus_core::tx::{TransactionId, TransactionOutpoint};
use kaspa_hashes::Hash;

use dealctl::envelope::{MutualSig, SignedTx, MUTUAL_SIG_SCHEMA, SCHEMA_VERSION};
use dealctl::txbuild::{self, Action};
use kaspa_forge_contracts::escrow::EscrowSpend;
use kaspa_forge_contracts::recovery::{Product, RecoveryRecord, Role, Verified, VerifiedFunding};
use kaspa_forge_contracts::registry;

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../recovery/fixtures");

fn load(name: &str) -> RecoveryRecord {
    let path = format!("{FIXTURES}/{name}");
    RecoveryRecord::from_json(&std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("read {path}"))).unwrap()
}

#[test]
fn valid_fixture_verifies_and_attacks_are_rejected() {
    assert!(load("deal-recovery.valid.json").verify().is_ok(), "valid fixture must verify");
    for attack in [
        "deal-recovery.attack-wrong-party-key.json",
        "deal-recovery.attack-wrong-role.json",
        "deal-recovery.attack-tampered-active-address.json",
        "deal-recovery.attack-fee-budget-too-high.json",
        "deal-recovery.attack-unknown-source.json",
        "deal-recovery.attack-uppercase-hex.json",
    ] {
        assert!(load(attack).verify().is_err(), "{attack} must be rejected (fail-closed)");
    }
}

// ── envelope verification (fail-closed) ──

fn verified() -> Verified {
    let p = registry::canonical_reference_params();
    Verified {
        product: Product::Escrow,
        role: Role::Buyer,
        network: "mainnet".into(),
        deal_id: 1,
        params: p,
        party_sk: [1u8; 32],
        party_pk: registry::canonical_reference_params().buyer_pk,
        funding: Some(VerifiedFunding {
            sk: [7u8; 32],
            pk: kaspa_forge_contracts::tx::sk_to_xonly(&[7u8; 32]).unwrap(),
            address: String::new(),
        }),
        active_addr: String::new(),
        disputed_addr: String::new(),
        version: &registry::ESCROW_V1,
    }
}

fn spend(amount: u64) -> EscrowSpend {
    EscrowSpend {
        prev_outpoint: TransactionOutpoint::new(TransactionId::from_bytes([0xE5; 32]), 0),
        prev_amount: amount,
        prev_daa: 0,
        cov_id: Hash::from_bytes([0xC0; 32]),
    }
}

fn valid_release_envelope() -> SignedTx {
    let v = verified();
    let built = txbuild::build_covenant(&v, Action::Release, 0, &spend(10_000_000_000)).unwrap();
    SignedTx::from_built(&built, &v.network, v.product, v.deal_id)
}

/// A two-input funding transaction, so we can craft single-input / duplicate-input violations.
fn two_input_fund_envelope() -> SignedTx {
    let v = verified();
    let utxos = vec![
        (TransactionOutpoint::new(TransactionId::from_bytes([0x11; 32]), 0), 6_000_000_000, 0, false),
        (TransactionOutpoint::new(TransactionId::from_bytes([0x22; 32]), 0), 6_000_000_000, 0, false),
    ];
    let built = txbuild::build_fund(&v, &utxos).unwrap();
    SignedTx::from_built(&built, &v.network, v.product, v.deal_id)
}

#[test]
fn valid_envelope_round_trips_and_verifies() {
    let env = valid_release_envelope();
    let json = env.to_json().unwrap();
    let back = SignedTx::from_json(&json).unwrap();
    assert!(back.verify_for_submit().is_ok(), "a well-formed envelope must re-verify");
}

#[test]
fn envelope_txid_mismatch_rejected() {
    let mut env = valid_release_envelope();
    env.txid = "00".repeat(32);
    assert!(env.verify_for_submit().is_err());
}

#[test]
fn envelope_tampered_output_value_rejected() {
    let mut env = valid_release_envelope();
    env.outputs[0].sompi += 1; // stated payout no longer matches the transaction
    assert!(env.verify_for_submit().is_err());
}

#[test]
fn envelope_non_conserving_value_rejected() {
    let mut env = valid_release_envelope();
    env.input_total += 1_000_000; // outputs + fee no longer equal the input
    assert!(env.verify_for_submit().is_err());
}

#[test]
fn envelope_two_input_covenant_path_rejected() {
    // A covenant path must spend exactly one UTXO. Relabel a two-input funding tx as "release".
    let mut env = two_input_fund_envelope();
    env.path = "release".into();
    assert!(env.verify_for_submit().is_err(), "single-input invariant must be enforced at submit");
}

#[test]
fn envelope_duplicate_stated_inputs_rejected() {
    let mut env = two_input_fund_envelope();
    let first = env.inputs[0].clone();
    env.inputs = vec![first.clone(), first]; // duplicate — the multiset no longer matches the tx
    assert!(env.verify_for_submit().is_err());
}

#[test]
fn envelope_unknown_path_rejected() {
    let mut env = valid_release_envelope();
    env.path = "steal".into();
    assert!(env.verify_for_submit().is_err());
}

#[test]
fn envelope_relabelled_path_rejected() {
    // A valid release (two P2PK outputs) relabelled as a dispute (which must have exactly one
    // covenant output) must be rejected structurally, with no recovery record.
    let mut env = valid_release_envelope();
    env.path = "dispute".into();
    assert!(env.verify_for_submit().is_err(), "a release must not submit as a dispute");
}

#[test]
fn envelope_wrong_mode_for_path_rejected() {
    // timeout requires DISPUTED (mode 1); a mode-0 envelope labelled timeout must be rejected.
    let mut env = valid_release_envelope();
    env.path = "timeout".into();
    env.mode = 0;
    assert!(env.verify_for_submit().is_err());
}

// ── mutual signature package agreement (fail-closed) ──

fn mutual_pkg(role: Role, to_buyer: u64, unsigned_txid: &str) -> MutualSig {
    MutualSig {
        schema: MUTUAL_SIG_SCHEMA.into(),
        schema_version: SCHEMA_VERSION,
        network: "mainnet".into(),
        product: Product::Escrow,
        deal_id: 1,
        mode: 1,
        outpoint: "aa".repeat(32) + ":0",
        covenant_id: "c0".repeat(32),
        to_buyer,
        to_seller: 100,
        unsigned_txid: unsigned_txid.into(),
        signer_role: role,
        signature: "ab".into(),
    }
}

#[test]
fn mutual_same_role_rejected() {
    let a = mutual_pkg(Role::Buyer, 500, "aa");
    let b = mutual_pkg(Role::Buyer, 500, "aa");
    assert!(a.agrees_with(&b).is_err(), "two signatures from the same role must not combine");
}

#[test]
fn mutual_different_transaction_rejected() {
    let a = mutual_pkg(Role::Buyer, 500, "aa");
    let b = mutual_pkg(Role::Seller, 600, "aa"); // different to_buyer
    assert!(a.agrees_with(&b).is_err(), "signatures over different splits must not combine");
    let c = mutual_pkg(Role::Seller, 500, "bb"); // different commitment
    assert!(a.agrees_with(&c).is_err(), "signatures over different commitments must not combine");
}

#[test]
fn mutual_matching_roles_and_tx_agree() {
    let a = mutual_pkg(Role::Buyer, 500, "aa");
    let b = mutual_pkg(Role::Seller, 500, "aa");
    assert!(a.agrees_with(&b).is_ok());
}

// ── untrusted-node arithmetic hardening ──

#[test]
fn overflowing_utxo_sum_is_rejected_not_panicking() {
    let utxos = vec![
        (TransactionOutpoint::new(TransactionId::from_bytes([1; 32]), 0), u64::MAX, 0, false),
        (TransactionOutpoint::new(TransactionId::from_bytes([2; 32]), 0), 1, 0, false),
    ];
    assert!(txbuild::checked_utxo_total(&utxos).is_err(), "overflow must fail cleanly, not panic");
}

#[test]
fn malformed_outpoint_is_an_error_not_a_panic() {
    assert!(dealctl::node::parse_outpoint("not-an-outpoint").is_err());
    assert!(dealctl::node::parse_outpoint("aa:bb:cc").is_err());
}

// ── binary-level tests: exit codes + the documented air-gap command run verbatim ──

use std::process::Command;

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_dealctl"))
}
fn tmp(name: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join(name)
}

#[test]
fn binary_verify_exit_codes() {
    // valid fixture → 0; every attack → 1; unknown command → 2.
    let ok = bin().args(["verify", "--recovery", &format!("{FIXTURES}/deal-recovery.valid.json")]).status().unwrap();
    assert_eq!(ok.code(), Some(0));
    let bad = bin().args(["verify", "--recovery", &format!("{FIXTURES}/deal-recovery.attack-wrong-party-key.json")]).status().unwrap();
    assert_eq!(bad.code(), Some(1));
    let usage = bin().args(["frobnicate"]).status().unwrap();
    assert_eq!(usage.code(), Some(2));
    let sub = bin().args(["escrow", "nonsense"]).status().unwrap();
    assert_eq!(sub.code(), Some(2));
}

#[test]
fn binary_air_gap_command_from_the_guide_signs_offline() {
    // Exactly the documented offline step: sign from a --line package pointed at a DEAD node. It must
    // NOT connect and must produce a signed file (re-review #2: the guide command works verbatim).
    let deal_id = 42u64;
    let out = tmp("readme_release.tx.json");
    let lines = tmp("readme_lines.json");
    let _ = std::fs::remove_file(&out);
    let txid = "aa".repeat(32);
    let cov = "c0".repeat(32);
    std::fs::write(&lines, format!(
        r#"{{"schema":"kaspa-forge-line-package","schema_version":1,"network":"mainnet","product":"escrow","deal_id":{deal_id},"lines":[{{"mode":0,"outpoint":"{txid}:0","amount":10000000000,"covenant_id":"{cov}","daa":0}}]}}"#
    )).unwrap();

    let status = bin()
        .args([
            "escrow", "release",
            "--recovery", &format!("{FIXTURES}/deal-recovery.valid.json"),
            "--line", lines.to_str().unwrap(),
            "--output", out.to_str().unwrap(),
            "--node", "grpc://127.0.0.1:1", // dead — must be ignored on the offline path
        ])
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(0), "offline signing must succeed with a dead node");
    assert!(out.exists(), "the air-gapped command must produce a signed transaction file");

    // And the produced envelope must re-verify structurally (no node needed).
    let env = SignedTx::from_json(&std::fs::read_to_string(&out).unwrap()).unwrap();
    assert!(env.verify_for_submit().is_ok());
}

// ── local output verifier: tampered payouts are rejected (spec §10.4) ──

#[test]
fn tampered_payout_recipient_and_amount_rejected() {
    use kaspa_consensus_core::tx::ScriptPublicKey;
    use kaspa_forge_contracts::tx::{p2pk_script, spk_address};
    let v = verified();
    // A valid release, then recompute its expected outputs; a tampered transaction must fail them.
    let built = txbuild::build_covenant(&v, Action::Release, 0, &spend(10_000_000_000)).unwrap();
    let (expects, _fee) = txbuild::expected_covenant_outputs(&v, Action::Release, &spend(10_000_000_000)).unwrap();

    // third-party output: redirect the seller payout to an attacker key.
    let mut third = built.tx.clone();
    third.outputs[0].script_public_key = ScriptPublicKey::new(0, p2pk_script(&[0xAA; 32]).into());
    assert!(txbuild::verify_outputs(&third, &expects).is_err(), "third-party recipient must be rejected");

    // underpaid party.
    let mut under = built.tx.clone();
    under.outputs[0].value -= 1_000;
    assert!(txbuild::verify_outputs(&under, &expects).is_err(), "underpaid party must be rejected");

    // missing / zeroed service fee.
    let mut nofee = built.tx.clone();
    nofee.outputs[1].value = 0;
    assert!(txbuild::verify_outputs(&nofee, &expects).is_err(), "missing/dust fee must be rejected");

    // sanity: the untouched transaction still matches.
    assert!(txbuild::verify_outputs(&built.tx, &expects).is_ok());
    let _ = spk_address; // (address helper referenced for parity with the node preview)
}

#[test]
fn timeout_destination_follows_timeout_to() {
    // timeout_to=0 pays the buyer; a params with timeout_to=1 pays the seller — the builder must honor it.
    let mut v0 = verified();
    v0.params.timeout_to = 0;
    let b0 = txbuild::build_covenant(&v0, Action::Timeout, 1, &spend(10_000_000_000)).unwrap();
    assert_eq!(b0.outs[0].label, "buyer (timeout)");

    let mut v1 = verified();
    v1.params.timeout_to = 1;
    let b1 = txbuild::build_covenant(&v1, Action::Timeout, 1, &spend(10_000_000_000)).unwrap();
    assert_eq!(b1.outs[0].label, "seller (timeout)");
}

#[test]
fn additional_attack_fixtures_are_rejected() {
    for attack in [
        "deal-recovery.attack-incomplete-missing-sk.json", // rejected at PARSE (missing field)
        "deal-recovery.attack-modified-buyer-key.json",
        "deal-recovery.attack-modified-seller-key.json",
        "deal-recovery.attack-modified-arbiter-key.json",
        "deal-recovery.attack-modified-fee-key.json",
        "deal-recovery.attack-wrong-network.json",
    ] {
        let json = std::fs::read_to_string(format!("{FIXTURES}/{attack}")).unwrap();
        // rejected either at parse or at verify — both are fail-closed.
        let rejected = RecoveryRecord::from_json(&json).and_then(|r| r.verify().map(|_| ())).is_err();
        assert!(rejected, "{attack} must be rejected (parse or verify)");
    }
}

#[test]
fn binary_rejects_swapped_line_package() {
    // A line package prepared for a DIFFERENT network/product/deal must never be signed against this
    // recovery record (air-gap trust boundary — 4th review).
    let bad = tmp("swapped_lines.json");
    let out = tmp("swapped_release.tx.json");
    let _ = std::fs::remove_file(&out);
    let txid = "aa".repeat(32);
    let cov = "c0".repeat(32);
    std::fs::write(&bad, format!(
        r#"{{"schema":"kaspa-forge-line-package","schema_version":1,"network":"testnet","product":"deposit","deal_id":999,"lines":[{{"mode":0,"outpoint":"{txid}:0","amount":10000000000,"covenant_id":"{cov}","daa":0}}]}}"#
    )).unwrap();
    let code = bin()
        .args([
            "escrow", "release",
            "--recovery", &format!("{FIXTURES}/deal-recovery.valid.json"),
            "--line", bad.to_str().unwrap(),
            "--output", out.to_str().unwrap(),
        ])
        .status().unwrap().code();
    assert_eq!(code, Some(1), "a mismatched package must be rejected");
    assert!(!out.exists(), "no transaction is produced from a mismatched package");
}

#[test]
fn binary_watch_file_carries_no_secrets() {
    // `watch` produces a PUBLIC view for the online machine — no private key inside.
    let out = tmp("watch.json");
    let _ = std::fs::remove_file(&out);
    let code = bin()
        .args(["watch", "--recovery", &format!("{FIXTURES}/deal-recovery.valid.json"), "--output", out.to_str().unwrap()])
        .status().unwrap().code();
    assert_eq!(code, Some(0));
    let text = std::fs::read_to_string(&out).unwrap();
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert!(v.get("party_sk").is_none(), "watch file must not contain party_sk");
    assert!(v.get("funding").is_none() && v.get("sk").is_none(), "watch file must not contain any secret key");
    assert!(v.get("active").is_some() && v.get("disputed").is_some(), "watch file carries the public addresses");
}
