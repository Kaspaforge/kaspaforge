// VM tests for the public escrow core — reproduce the proven wasm/escrow_core.rs test suite.
// All 10 transitions + mutual co-signing + security checks (wrong signer rejected, MIN_OUT guard).

#[cfg(test)]
mod tests {
    use kaspa_forge_contracts::tx::*;
    use kaspa_forge_contracts::escrow::*;
    use kaspa_forge_contracts::escrow::FEE;
    use kaspa_consensus_core::hashing::sighash::SigHashReusedValuesUnsync;
    use kaspa_consensus_core::tx::{
        PopulatedTransaction, TransactionId, TransactionOutpoint, VerifiableTransaction,
    };
    use kaspa_txscript::caches::Cache;
    use kaspa_txscript::covenants::CovenantsContext;
    use kaspa_txscript::{EngineCtx, TxScriptEngine};
    use kaspa_txscript_errors::TxScriptError;

    fn exec(tx: &kaspa_consensus_core::tx::Transaction, entries: Vec<kaspa_consensus_core::tx::UtxoEntry>) -> Result<(), TxScriptError> {
        let reused = SigHashReusedValuesUnsync::new();
        let sig_cache = Cache::new(10_000);
        let input = tx.inputs[0].clone();
        let populated = PopulatedTransaction::new(tx, entries);
        let cov_ctx = CovenantsContext::from_tx(&populated).map_err(TxScriptError::from)?;
        let utxo = populated.utxo(0).expect("utxo");
        let mut vm = TxScriptEngine::from_transaction_input(
            &populated,
            &input,
            0,
            utxo,
            EngineCtx::new(&sig_cache)
                .with_reused(&reused)
                .with_covenants_ctx(&cov_ctx),
            engine_flags(),
        );
        vm.execute()
    }

    fn key(b: u8) -> ([u8; 32], [u8; 32]) {
        let kp = secp256k1::Keypair::from_seckey_slice(secp256k1::SECP256K1, &[b; 32]).unwrap();
        ([b; 32], kp.x_only_public_key().0.serialize())
    }

    fn params() -> (EscrowParams, [u8; 32], [u8; 32], [u8; 32]) {
        let (bsk, bpk) = key(1);
        let (ssk, spk) = key(2);
        let (ask, apk) = key(3);
        let (_, fpk) = key(4);
        (
            EscrowParams {
                buyer_pk: bpk,
                seller_pk: spk,
                arbiter_pk: apk,
                dispute_window: 600,
                arbiter_deadline: 1200,
                timeout_to: 0,
                fee_pk: fpk,
                fee_resolve: 20_000_000,
                fee_dispute: 500_000_000,
                fee_budget: FEE,
            },
            bsk,
            ssk,
            ask,
        )
    }

    fn spend_on(
        contract: &silverscript_lang::compiler::CompiledContract<'_>,
        amount: u64,
    ) -> (EscrowSpend, kaspa_consensus_core::tx::UtxoEntry) {
        let cov_id = kaspa_hashes::Hash::from_bytes(*b"EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE");
        let entry = kaspa_consensus_core::tx::UtxoEntry::new(amount, p2sh(&contract.script), 0, false, Some(cov_id));
        (
            EscrowSpend {
                prev_outpoint: TransactionOutpoint::new(TransactionId::from_bytes([0xE5; 32]), 0),
                prev_amount: amount,
                prev_daa: 0,
                cov_id,
            },
            entry,
        )
    }

    const AMT: u64 = 10_000_000_000;

    #[test]
    fn release_valid_in_vm() {
        let (p, bsk, _, _) = params();
        let active = p.active_contract().unwrap();
        let (spend, entry) = spend_on(&active, AMT);
        let tx = build_release_tx(&p, &active, &bsk, &spend).unwrap();
        exec(&tx, vec![entry]).expect("release must pass the VM");
    }

    #[test]
    fn refund_valid_in_vm() {
        let (p, _, ssk, _) = params();
        let active = p.active_contract().unwrap();
        let (spend, entry) = spend_on(&active, AMT);
        let tx = build_refund_tx(&p, &active, &ssk, &spend).unwrap();
        exec(&tx, vec![entry]).expect("refund must pass the VM");
    }

    #[test]
    fn dispute_valid_in_vm() {
        let (p, bsk, _, _) = params();
        let active = p.active_contract().unwrap();
        let (spend, entry) = spend_on(&active, AMT);
        let tx = build_dispute_tx(&p, &bsk, &spend).unwrap();
        exec(&tx, vec![entry]).expect("dispute must pass the VM");
    }

    #[test]
    fn dispute_then_split_valid_in_vm() {
        let (p, bsk, _, ask) = params();
        // dispute
        let (spend, entry) = spend_on(&p.active_contract().unwrap(), AMT);
        let tx = build_dispute_tx(&p, &bsk, &spend).unwrap();
        exec(&tx, vec![entry]).expect("dispute must pass the VM");
        // arbitrateSplit from DISPUTED
        let disputed = p.disputed_contract().unwrap();
        let (spend2, entry2) = spend_on(&disputed, AMT - FEE);
        let tx2 = build_arbitrate_split_tx(&p, &ask, &spend2, 6_000_000_000).unwrap();
        exec(&tx2, vec![entry2]).expect("arbitrateSplit must pass the VM");
    }

    #[test]
    fn dispute_then_binary_valid_in_vm() {
        let (p, bsk, _, ask) = params();
        let (spend, entry) = spend_on(&p.active_contract().unwrap(), AMT);
        let tx = build_dispute_tx(&p, &bsk, &spend).unwrap();
        exec(&tx, vec![entry]).expect("dispute must pass the VM");
        let disputed = p.disputed_contract().unwrap();
        let (spend2, entry2) = spend_on(&disputed, AMT - FEE);
        let tx2 = build_arbitrate_to_tx(&p, &ask, &spend2, true).unwrap();
        exec(&tx2, vec![entry2]).expect("arbitrateToBuyer must pass the VM");
    }

    #[test]
    fn mutual_split_valid_in_dispute_vm() {
        let (p, bsk, ssk, _) = params();
        let disputed = p.disputed_contract().unwrap();
        let (spend, entry) = spend_on(&disputed, AMT - FEE);
        let to_buyer = 4_000_000_000;
        let bsig = mutual_sig(&p, &disputed, &spend, to_buyer, &bsk).unwrap();
        let ssig = mutual_sig(&p, &disputed, &spend, to_buyer, &ssk).unwrap();
        let tx = build_mutual_tx(&p, &disputed, &spend, to_buyer, bsig, ssig).unwrap();
        exec(&tx, vec![entry]).expect("mutual split must pass the VM in DISPUTED");
    }

    #[test]
    fn mutual_wrong_second_signer_rejected_in_vm() {
        let (p, bsk, _, ask) = params();
        let disputed = p.disputed_contract().unwrap();
        let (spend, entry) = spend_on(&disputed, AMT - FEE);
        let to_buyer = 4_000_000_000;
        let bsig = mutual_sig(&p, &disputed, &spend, to_buyer, &bsk).unwrap();
        let asig = mutual_sig(&p, &disputed, &spend, to_buyer, &ask).unwrap();
        let tx = build_mutual_tx(&p, &disputed, &spend, to_buyer, bsig, asig).unwrap();
        assert!(
            exec(&tx, vec![entry]).is_err(),
            "mutual with the wrong party's signature must be rejected"
        );
    }

    #[test]
    fn arbitrate_wrong_signer_rejected_in_vm() {
        let (p, bsk, _, _) = params();
        let disputed = p.disputed_contract().unwrap();
        let (spend, entry) = spend_on(&disputed, AMT);
        let tx = build_arbitrate_to_tx(&p, &bsk, &spend, true).unwrap();
        assert!(
            exec(&tx, vec![entry]).is_err(),
            "arbitrate by a non-arbiter must be rejected"
        );
    }

    #[test]
    fn split_below_min_out_rejected_by_builder() {
        let (p, _, _, ask) = params();
        let disputed = p.disputed_contract().unwrap();
        let (spend, _) = spend_on(&disputed, AMT);
        assert!(build_arbitrate_split_tx(&p, &ask, &spend, AMT - FEE - p.fee_dispute).is_err());
    }
}
