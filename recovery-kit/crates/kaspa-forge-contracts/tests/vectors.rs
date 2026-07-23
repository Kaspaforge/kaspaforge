// Parity gate (spec §10.3): the committed golden vectors must be reproduced byte-for-byte by the
// current core. If silverscript codegen or any builder drifts, this fails.
use kaspa_forge_contracts::vectors;

#[test]
fn golden_vectors_are_reproduced_exactly() {
    let golden = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/vectors/v1.json"))
        .expect("vectors/v1.json must exist — run `cargo run --bin gen_vectors`");
    let golden: serde_json::Value = serde_json::from_str(&golden).expect("golden json");
    let fresh = vectors::build();
    assert_eq!(fresh, golden, "canonical vectors drifted from the committed golden file");
}

#[test]
fn transaction_ids_are_deterministic() {
    // A Kaspa txid excludes signature scripts, so it must be stable across builds even though Schnorr
    // signing may use fresh nonces.
    let a = vectors::build();
    let b = vectors::build();
    let ids = |v: &serde_json::Value| {
        v["transactions"].as_array().unwrap().iter().map(|t| t["txid"].as_str().unwrap().to_string()).collect::<Vec<_>>()
    };
    assert_eq!(ids(&a), ids(&b), "transaction ids must be deterministic");
}
