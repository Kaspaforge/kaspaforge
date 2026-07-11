// Multi-UTXO probe for the vault (review finding, 2026-07-10; mirrors escrowctl/multi_utxo.rs).
// Reviewer's example verbatim: two UNVAULTING UTXOs of the same script (5000 KAS + 100 KAS) are
// spent by a single complete transaction with a shared output 0 = dest; the big-FEE output
// satisfies both the big and the small input — 100 KAS leaks into the network fee. Checked in the node's VM (same as consensus).

use kaspa_consensus_core::subnets::SUBNETWORK_ID_NATIVE;
use kaspa_consensus_core::tx::{
    CovenantBinding, PopulatedTransaction, ScriptPublicKey, Transaction, TransactionInput, TransactionOutpoint,
    TransactionOutput, UtxoEntry,
};
use kaspa_hashes::Hash;
use secp256k1::{Keypair, Secp256k1, SecretKey};

use crate::vault::*;

fn build_two_input_tx(
    outpoints: [(TransactionOutpoint, u64); 2],
    outputs: Vec<TransactionOutput>,
) -> Transaction {
    let inputs = outpoints
        .iter()
        .map(|(op, seq)| TransactionInput::new_with_compute_budget(*op, vec![], *seq, COMPUTE_BUDGET))
        .collect();
    Transaction::new(1, inputs, outputs, 0, SUBNETWORK_ID_NATIVE, 0, vec![])
}

pub fn run() -> u32 {
    let secp = Secp256k1::new();
    let key = |b: u8| {
        let kp = Keypair::from_secret_key(&secp, &SecretKey::from_slice(&[b; 32]).unwrap());
        let (x, _) = kp.x_only_public_key();
        ([b; 32], x.serialize())
    };
    let (_hot_sk, hot_pk) = key(1);
    let (_alarm_sk, alarm_pk) = key(2);
    let (_, heir_pk) = key(3);
    let (_, dest_pk) = key(7);

    let delay: i64 = 864_000; // ~24h at 10 bps
    let inherit_delay: i64 = 8_640_000;
    let dest_spk = p2pk_spk_encoded(&dest_pk);
    // UNVAULTING script (mode=1, dest pinned) — the script both UTXOs sit under
    let unvault = compile_vault(&hot_pk, &alarm_pk, delay, &heir_pk, inherit_delay, 1, MODE_UNVAULTING, &dest_spk, FEE as i64);
    let vault_p2sh = p2sh(&unvault.script);

    let big: u64 = 500_000_000_000; // 5000 KAS
    let small: u64 = 10_000_000_000; // 100 KAS
    let dest_out = |v: u64| TransactionOutput::new(v, ScriptPublicKey::new(0, p2pk_script(&dest_pk).into()));
    let op = |b: u8| TransactionOutpoint::new(Hash::from_bytes([b; 32]).into(), 0);

    let mut anomalies = 0u32;
    let verdict = |res: &Result<(), kaspa_txscript_errors::TxScriptError>| -> &'static str {
        if res.is_ok() { "ACCEPT" } else { "REJECT" }
    };
    let mut accepted = |name: &str, res: Result<(), kaspa_txscript_errors::TxScriptError>| -> bool {
        println!("  {name} -> {}{}", verdict(&res),
            res.as_ref().err().map(|e| format!(" ({e})")).unwrap_or_default());
        res.is_ok()
    };

    // complete: this.age >= delay; outputs[0]==dest; outputs[0].value >= inputs[i].value - FEE.
    // output0 = big - FEE satisfies both the big and the small input → 100 KAS goes to fee if both are accepted.
    println!("— Vault: 2 UNVAULTING UTXOs of one script, complete to a shared output (reviewer example 5000/100) —");
    {
        let entries = vec![
            UtxoEntry::new(big, vault_p2sh.clone(), 0, false, Some(Hash::from_bytes([0xA1; 32]))),
            UtxoEntry::new(small, vault_p2sh.clone(), 0, false, Some(Hash::from_bytes([0xA2; 32]))),
        ];
        let outputs = vec![dest_out(big - FEE)];
        let mut tx = build_two_input_tx([(op(0xB1), delay as u64), (op(0xB2), delay as u64)], outputs);
        // complete requires no signature
        tx.inputs[0].signature_script = covenant_sigscript(&unvault, "complete", vec![]);
        tx.inputs[1].signature_script = covenant_sigscript(&unvault, "complete", vec![]);
        let a = accepted("input 0 (big=5000 KAS)", execute_input(&tx, entries.clone(), 0));
        let b = accepted("input 1 (small=100 KAS)", execute_input(&tx, entries.clone(), 1));
        if a && b {
            println!("  ⇒ SIPHON POSSIBLE: both inputs accepted, {} KAS of the small input leaks into the network fee",
                (small - FEE) / 100_000_000);
            anomalies += 1;
        } else {
            println!("  ⇒ protection active: multi-input spend rejected");
        }
    }

    // Control: a single-input complete passes
    println!("— Control: single UNVAULTING-UTXO complete —");
    {
        let entries = vec![UtxoEntry::new(big, vault_p2sh.clone(), 0, false, Some(Hash::from_bytes([0xA1; 32])))];
        let mut tx = build_two_input_tx([(op(0xB1), delay as u64), (op(0xB1), delay as u64)], vec![dest_out(big - FEE)]);
        tx.inputs.truncate(1);
        tx.inputs[0].signature_script = covenant_sigscript(&unvault, "complete", vec![]);
        let ok = accepted("single-input complete", execute_input(&tx, entries.clone(), 0));
        if !ok { println!("  ⇒ ‼️ the normal single-input path is broken!"); anomalies += 1; }
    }

    // ── Sweep-feasibility: spend a PLAIN top-up (covenant_id=None) off the VAULT address via checkin ──
    // A stray payment sits under the VAULT script (mode 0); mode 0 has no terminal path (complete
    // requires mode 1). checkin (mode0->mode0, validateOutputState, hot signature) folds the
    // plain input into a fresh vault covenant-UTXO — build_vault_sweep_tx is built on this.
    println!("— Sweep feasibility: PLAIN top-up on the VAULT address (mode 0) via checkin —");
    {
        let secp = Secp256k1::new();
        let hot_sk = [1u8; 32];
        let _ = Keypair::from_secret_key(&secp, &SecretKey::from_slice(&hot_sk).unwrap());
        let vault_c = compile_vault(&hot_pk, &alarm_pk, delay, &heir_pk, inherit_delay, 1, MODE_VAULT, &ZERO_DEST, FEE as i64);
        let vault0_p2sh = p2sh(&vault_c.script);
        let plain = UtxoEntry::new(small, vault0_p2sh.clone(), 0, false, None); // covenant_id=None
        let folded = TransactionOutput::new(small - FEE, p2sh(&vault_c.script).into());
        let cov_id = genesis_covenant_id(op(0xC1), 0, &folded);
        let out = TransactionOutput::with_covenant(small - FEE, vault0_p2sh.clone(),
            Some(CovenantBinding { authorizing_input: 0, covenant_id: cov_id }));
        let mut tx = build_two_input_tx([(op(0xC1), 0), (op(0xC1), 0)], vec![out]);
        tx.inputs.truncate(1);
        let entries = vec![plain];
        let sig = input_signature(&PopulatedTransaction::new(&tx, entries.clone()), 0, &hot_sk);
        tx.inputs[0].signature_script = covenant_sigscript(&vault_c, "checkin", vec![sig.into()]);
        let ok = accepted("checkin on a PLAIN input (fold into the vault)", execute_input(&tx, entries, 0));
        if !ok { println!("  ⇒ ‼️ sweep via checkin is broken!"); anomalies += 1; }
        else { println!("  ⇒ sweep works: a stray payment folds into the vault covenant UTXO"); }
    }

    // ── Griefing-cap: a vault with feeBudget > MAX_FEE_BUDGET must REJECT any transition ──
    // (audit 2026-07-11: the contract enforces the budget cap itself, regardless of off-chain bindings)
    println!("— Griefing cap: complete on a vault with feeBudget=20M (> MAX 10M) —");
    {
        let hi: i64 = 20_000_000; // above MAX_FEE_BUDGET (10M)
        let unvault_hi = compile_vault(&hot_pk, &alarm_pk, delay, &heir_pk, inherit_delay, 1, MODE_UNVAULTING, &dest_spk, hi);
        let p2sh_hi = p2sh(&unvault_hi.script);
        let entries = vec![UtxoEntry::new(big, p2sh_hi, delay as u64, false, Some(Hash::from_bytes([0xF1; 32])))];
        let mut tx = build_two_input_tx([(op(0xF1), delay as u64), (op(0xF1), delay as u64)], vec![dest_out(big - hi as u64)]);
        tx.inputs.truncate(1);
        tx.inputs[0].signature_script = covenant_sigscript(&unvault_hi, "complete", vec![]);
        let accepted_hi = accepted("complete with feeBudget=20M (expect REJECT)", execute_input(&tx, entries, 0));
        if accepted_hi { println!("  ⇒ ‼️ griefing bound broken: a vault with an inflated feeBudget can be spent!"); anomalies += 1; }
        else { println!("  ⇒ protection active: the contract rejected the transition with feeBudget > MAX"); }
    }

    println!("vault multi-utxo probe: open holes = {anomalies}");
    anomalies
}

#[cfg(test)]
mod tests {
    // Regression: the single-input invariant closes the multi-UTXO siphon. anomalies>0 = the hole is back.
    #[test]
    fn no_multi_utxo_holes() {
        assert_eq!(super::run(), 0, "multi-UTXO siphon is possible again — check require(tx.inputs.length==1)");
    }
}
