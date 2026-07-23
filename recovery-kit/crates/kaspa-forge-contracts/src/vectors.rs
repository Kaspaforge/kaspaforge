//! Deterministic canonical test vectors (spec §10). These pin, for a fixed set of keys, outpoints
//! and amounts, the exact on-chain effect of every escrow transition: the compiled ACTIVE/DISPUTED
//! addresses (all networks), and each transaction's id together with its outputs (recipient
//! scriptPubKey, value, covenant binding). The committed `vectors/v1.json` is the golden file; the
//! `vectors` integration test rebuilds these and asserts byte-for-byte equality, which is the parity
//! gate (spec §10.3): because the browser WASM, this core and dealctl all build on THIS module, one
//! reproduced vector set proves all three agree.
//!
//! Transaction ids are used as the deterministic anchor: a Kaspa transaction id commits to the
//! transaction WITHOUT its signature scripts, so it is stable regardless of Schnorr nonce choice,
//! while still committing to every input outpoint, output value and scriptPubKey.

use kaspa_consensus_core::tx::{Transaction, TransactionId, TransactionOutpoint, TransactionOutput};
use kaspa_hashes::Hash;
use serde_json::{json, Value};

use crate::escrow::{
    build_arbitrate_split_tx, build_arbitrate_to_tx, build_auto_release_tx, build_dispute_tx, build_escrow_fund_tx,
    build_mutual_tx, build_refund_tx, build_release_tx, build_timeout_tx, mutual_sig, EscrowParams, EscrowSpend,
};
use crate::registry::{canonical_reference_params, sha256_hex, ESCROW_V1};
use crate::tx::{p2sh, spk_address};

fn key(b: u8) -> [u8; 32] {
    [b; 32]
}

/// Fixed covenant UTXO for the transition vectors.
fn spend(mode: i64, amount: u64, p: &EscrowParams) -> EscrowSpend {
    let contract = if mode == 0 { p.active_contract().unwrap() } else { p.disputed_contract().unwrap() };
    // The p2sh address is implied by the params; we only need a stable outpoint + cov id here.
    let _ = &contract;
    EscrowSpend {
        prev_outpoint: TransactionOutpoint::new(TransactionId::from_bytes([0xE5; 32]), 0),
        prev_amount: amount,
        prev_daa: 0,
        cov_id: Hash::from_bytes([0xC0; 32]),
    }
}

fn out_json(o: &TransactionOutput) -> Value {
    json!({
        "value": o.value,
        "spk_version": o.script_public_key.version(),
        "spk_sha256": sha256_hex(o.script_public_key.script()),
        "covenant_id": o.covenant.as_ref().map(|c| c.covenant_id.to_string()),
    })
}

fn tx_json(path: &str, mode: i64, tx: &Transaction) -> Value {
    json!({
        "path": path,
        "mode": mode,
        "inputs": tx.inputs.iter().map(|i| i.previous_outpoint.to_string()).collect::<Vec<_>>(),
        "txid": tx.id().to_string(),
        "outputs": tx.outputs.iter().map(out_json).collect::<Vec<_>>(),
    })
}

fn address_vector(p: &EscrowParams) -> Value {
    let active_script = p.active_contract().unwrap().script;
    let disputed_script = p.disputed_contract().unwrap().script;
    let addr = |script: &[u8], net: &str| spk_address(&p2sh(script), net).unwrap();
    json!({
        "params": {
            "buyer_pk": hex::encode(p.buyer_pk),
            "seller_pk": hex::encode(p.seller_pk),
            "arbiter_pk": hex::encode(p.arbiter_pk),
            "dispute_window": p.dispute_window,
            "arbiter_deadline": p.arbiter_deadline,
            "timeout_to": p.timeout_to,
            "fee_pk": hex::encode(p.fee_pk),
            "fee_resolve": p.fee_resolve,
            "fee_dispute": p.fee_dispute,
            "fee_budget": p.fee_budget,
        },
        "active": {
            "script_sha256": sha256_hex(&active_script),
            "mainnet": addr(&active_script, "mainnet"),
            "testnet": addr(&active_script, "testnet"),
            "simnet": addr(&active_script, "simnet"),
        },
        "disputed": {
            "script_sha256": sha256_hex(&disputed_script),
            "mainnet": addr(&disputed_script, "mainnet"),
            "testnet": addr(&disputed_script, "testnet"),
            "simnet": addr(&disputed_script, "simnet"),
        },
    })
}

/// Build the full canonical vector set.
pub fn build() -> Value {
    let p = canonical_reference_params();
    let bsk = key(1);
    let ssk = key(2);
    let ask = key(3);
    let fund_sk = key(7);
    let fund_pk = crate::tx::sk_to_xonly(&fund_sk).unwrap();

    const AMT: u64 = 10_000_000_000;

    // Transaction vectors (deterministic ids).
    let mut txs: Vec<Value> = Vec::new();

    // fund: one fixed funding UTXO -> ACTIVE genesis.
    let fund_utxos = vec![(TransactionOutpoint::new(TransactionId::from_bytes([0xF0; 32]), 0), AMT, 0u64, false)];
    let (fund_tx, _cov) = build_escrow_fund_tx(&p, &fund_sk, &fund_pk, fund_utxos).unwrap();
    txs.push(tx_json("fund", 0, &fund_tx));

    // release / refund from both modes.
    let active = p.active_contract().unwrap();
    let disputed = p.disputed_contract().unwrap();
    txs.push(tx_json("release-active", 0, &build_release_tx(&p, &active, &bsk, &spend(0, AMT, &p)).unwrap()));
    txs.push(tx_json("release-disputed", 1, &build_release_tx(&p, &disputed, &bsk, &spend(1, AMT, &p)).unwrap()));
    txs.push(tx_json("refund-active", 0, &build_refund_tx(&p, &active, &ssk, &spend(0, AMT, &p)).unwrap()));
    txs.push(tx_json("refund-disputed", 1, &build_refund_tx(&p, &disputed, &ssk, &spend(1, AMT, &p)).unwrap()));

    // dispute: ACTIVE -> DISPUTED.
    txs.push(tx_json("dispute", 0, &build_dispute_tx(&p, &bsk, &spend(0, AMT, &p)).unwrap()));

    // keyless paths.
    txs.push(tx_json("auto-release", 0, &build_auto_release_tx(&p, &spend(0, AMT, &p)).unwrap()));
    txs.push(tx_json("timeout", 1, &build_timeout_tx(&p, &spend(1, AMT, &p)).unwrap()));

    // arbitration (operator paths, included as core vectors).
    txs.push(tx_json("arbitrate-to-buyer", 1, &build_arbitrate_to_tx(&p, &ask, &spend(1, AMT, &p), true).unwrap()));
    txs.push(tx_json("arbitrate-to-seller", 1, &build_arbitrate_to_tx(&p, &ask, &spend(1, AMT, &p), false).unwrap()));
    txs.push(tx_json("arbitrate-split", 1, &build_arbitrate_split_tx(&p, &ask, &spend(1, AMT, &p), 6_000_000_000).unwrap()));

    // mutual: both parties co-sign the same tx.
    let msp = spend(1, AMT, &p);
    let to_buyer = 4_000_000_000u64;
    let bsig = mutual_sig(&p, &disputed, &msp, to_buyer, &bsk).unwrap();
    let ssig = mutual_sig(&p, &disputed, &msp, to_buyer, &ssk).unwrap();
    txs.push(tx_json("mutual", 1, &build_mutual_tx(&p, &disputed, &msp, to_buyer, bsig, ssig).unwrap()));

    json!({
        "schema": "kaspa-forge-vectors",
        "schema_version": 1,
        "contract": {
            "family": ESCROW_V1.family,
            "version": ESCROW_V1.version,
            "source_sha256": ESCROW_V1.source_sha256,
            "silverscript_revisions": ESCROW_V1.silverscript_revisions,
            "rusty_kaspa_tag": ESCROW_V1.rusty_kaspa_tag,
            "canonical_active_sha256": ESCROW_V1.canonical_active_sha256,
            "canonical_disputed_sha256": ESCROW_V1.canonical_disputed_sha256,
        },
        // Escrow and Deposit ride the SAME escrow.sil with the SAME addresses; the only difference is
        // the public role mapping (holder=buyer, depositor=seller). The vector proves the inversion
        // is a naming layer, not a second contract.
        "addresses": {
            "escrow": address_vector(&p),
            "deposit": {
                "note": "identical contract/addresses to escrow; role mapping holder=buyer, depositor=seller",
                "role_mapping": { "holder": "buyer", "depositor": "seller" },
            },
        },
        "transactions": txs,
    })
}

/// Pretty JSON, stable key order via serde_json's preserved insertion order in the maps above.
pub fn build_pretty() -> String {
    serde_json::to_string_pretty(&build()).expect("vectors serialize")
}
