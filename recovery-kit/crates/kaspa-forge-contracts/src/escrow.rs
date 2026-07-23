// Core of "Garant" (escrow) — the canonical escrow transition builders, MOVED verbatim from the
// product WASM crate (`kaspa-safe-core`, `src/escrow_core.rs`) into this public crate. The WASM
// crate now re-exports these (`pub use kaspa_forge_contracts::escrow as escrow_core;`), so browser
// and `dealctl` share one implementation and build byte-identical transactions (spec §3.1).
//
// Source of contract truth — `contracts/escrow.sil` (include_str, a byte-for-byte copy of the
// private `spike/contracts/escrow.sil`; the export test asserts equality). Reuses the low-level
// primitives from `crate::tx` (p2pk/p2sh/sigscript/signing/genesis) — they're universal; only
// EscrowParams, compilation, and transition building are escrow-specific.
//
// Assembles the same tx transitions as escrowctl selftest/e2e (52/52 + simnet green), but without grpc.

use kaspa_consensus_core::tx::{CovenantBinding, ScriptPublicKey, Transaction, TransactionOutpoint, TransactionOutput, UtxoEntry};
use kaspa_hashes::Hash;
use silverscript_lang::ast::Expr;
use silverscript_lang::compiler::{compile_contract, CompileOptions, CompiledContract};

use crate::tx::{
    build_tx_budget, covenant_sigscript, genesis_covenant_id, input_signature, p2pk_script, p2pk_sigscript, p2pk_spk_encoded,
    p2sh, populated, InputSpec,
};

pub const ESCROW_SRC: &str = include_str!("../escrow.sil");
/// = constant FEE in escrow.sil (network transition fee).
pub const FEE: u64 = 1_000_000;
/// = constant MIN_OUT in escrow.sil (dust guard for split outputs, 1 KAS).
pub const MIN_OUT: u64 = 100_000_000;
/// Fee for the funding transaction (regular P2PK inputs).
pub const FUND_FEE: u64 = 1_000_000;
pub const MODE_ACTIVE: i64 = 0;
pub const MODE_DISPUTED: i64 = 1;
/// mutual = up to 3 checkSig + introspection of 3 outputs; 40 with margin (proven in escrowctl).
pub const ESCROW_BUDGET: u16 = 40;

/// Deal parameters = escrow.sil constructor (mode is substituted separately).
#[derive(Clone)]
pub struct EscrowParams {
    pub buyer_pk: [u8; 32],
    pub seller_pk: [u8; 32],
    pub arbiter_pk: [u8; 32],
    pub dispute_window: i64,
    pub arbiter_deadline: i64,
    pub timeout_to: i64, // 0 = buyer, 1 = seller
    pub fee_pk: [u8; 32], // the service's fee address (P2PK); spk is derived in fee_spk()
    pub fee_resolve: u64,
    pub fee_dispute: u64,
    /// Network transition fee budget (contract's feeBudget); defaults to FEE (1M) for old deals.
    pub fee_budget: u64,
}

impl EscrowParams {
    pub fn fee_spk_encoded(&self) -> [u8; 36] {
        p2pk_spk_encoded(&self.fee_pk)
    }

    pub fn contract(&self, mode: i64) -> Result<CompiledContract<'static>, String> {
        let fee_spk = self.fee_spk_encoded();
        let args: Vec<Expr<'static>> = vec![
            self.buyer_pk.to_vec().into(),
            self.seller_pk.to_vec().into(),
            self.arbiter_pk.to_vec().into(),
            self.dispute_window.into(),
            self.arbiter_deadline.into(),
            self.timeout_to.into(),
            fee_spk.to_vec().into(),
            (self.fee_resolve as i64).into(),
            (self.fee_dispute as i64).into(),
            mode.into(),
            (self.fee_budget as i64).into(),
        ];
        compile_contract(ESCROW_SRC, &args, CompileOptions::default()).map_err(|e| format!("compile escrow.sil: {e}"))
    }

    pub fn active_contract(&self) -> Result<CompiledContract<'static>, String> {
        self.contract(MODE_ACTIVE)
    }
    pub fn disputed_contract(&self) -> Result<CompiledContract<'static>, String> {
        self.contract(MODE_DISPUTED)
    }
}

/// Single-input escrow transition (the same CovenantSpend as the safe uses).
pub struct EscrowSpend {
    pub prev_outpoint: TransactionOutpoint,
    pub prev_amount: u64,
    pub prev_daa: u64,
    pub cov_id: Hash,
}

fn pay(pk: &[u8; 32], v: u64) -> TransactionOutput {
    TransactionOutput::new(v, ScriptPublicKey::new(0, p2pk_script(pk).into()))
}

fn fee_out(p: &EscrowParams, v: u64) -> TransactionOutput {
    // fee output = P2PK(fee_pk); the contract checks scriptPubKey against the version-prefixed feeSpk
    TransactionOutput::new(v, ScriptPublicKey::new(0, p2pk_script(&p.fee_pk).into()))
}

fn input_from(contract: &CompiledContract<'_>, spend: &EscrowSpend) -> InputSpec {
    InputSpec {
        outpoint: spend.prev_outpoint,
        entry: UtxoEntry::new(spend.prev_amount, p2sh(&contract.script), spend.prev_daa, false, Some(spend.cov_id)),
        sequence: 0,
    }
}

/// Funding: P2PK UTXO of the funding key -> escrow covenant ACTIVE (genesis).
pub fn build_escrow_fund_tx(
    p: &EscrowParams,
    funding_sk: &[u8; 32],
    funding_pk: &[u8; 32],
    utxos: Vec<(TransactionOutpoint, u64, u64, bool)>,
) -> Result<(Transaction, Hash), String> {
    if utxos.is_empty() {
        return Err("no UTXOs at the funding address".into());
    }
    let total: u64 = utxos.iter().map(|(_, a, _, _)| a).sum();
    let amount = total.checked_sub(FUND_FEE).ok_or("insufficient funds")?;
    let funding_spk = ScriptPublicKey::new(0, p2pk_script(funding_pk).into());
    let inputs: Vec<InputSpec> = utxos
        .into_iter()
        .map(|(op, a, d, cb)| InputSpec { outpoint: op, entry: UtxoEntry::new(a, funding_spk.clone(), d, cb, None), sequence: 0 })
        .collect();
    let active = p.active_contract()?;
    let mut escrow_out = TransactionOutput::new(amount, p2sh(&active.script));
    let cov_id = genesis_covenant_id(inputs[0].outpoint, 0, &escrow_out);
    escrow_out.covenant = Some(CovenantBinding { authorizing_input: 0, covenant_id: cov_id });

    let mut tx = build_tx_budget(&inputs, vec![escrow_out], ESCROW_BUDGET);
    let entries: Vec<UtxoEntry> = inputs.iter().map(|i| i.entry.clone()).collect();
    let sigs: Vec<Vec<u8>> = (0..inputs.len()).map(|i| p2pk_sigscript(&populated(&tx, &entries), i, funding_sk)).collect();
    for (i, s) in sigs.into_iter().enumerate() {
        tx.inputs[i].signature_script = s;
    }
    tx.finalize();
    Ok((tx, cov_id))
}

/// Single input transition + one signature (release/refund/dispute). `mode` = the input's contract.
fn build_signed(
    contract: &CompiledContract<'_>,
    spend: &EscrowSpend,
    outputs: Vec<TransactionOutput>,
    function: &str,
    signer_sk: &[u8; 32],
) -> Result<Transaction, String> {
    let inputs = [input_from(contract, spend)];
    let mut tx = build_tx_budget(&inputs, outputs, ESCROW_BUDGET);
    let entries = vec![inputs[0].entry.clone()];
    let sig = input_signature(&populated(&tx, &entries), 0, signer_sk);
    tx.inputs[0].signature_script = covenant_sigscript(contract, function, vec![sig.into()])?;
    tx.finalize();
    Ok(tx)
}

/// Unsigned transition (autoRelease/timeout); sequence sets up the CSV age claim.
fn build_unsigned(
    contract: &CompiledContract<'_>,
    spend: &EscrowSpend,
    sequence: u64,
    outputs: Vec<TransactionOutput>,
    function: &str,
) -> Result<Transaction, String> {
    let mut inputs = [input_from(contract, spend)];
    inputs[0].sequence = sequence;
    let mut tx = build_tx_budget(&inputs, outputs, ESCROW_BUDGET);
    tx.inputs[0].signature_script = covenant_sigscript(contract, function, vec![])?;
    tx.finalize();
    Ok(tx)
}

/// release (buyer): everything to the seller + fee. Works from either mode (the input contract is passed in).
pub fn build_release_tx(p: &EscrowParams, contract: &CompiledContract<'_>, buyer_sk: &[u8; 32], spend: &EscrowSpend) -> Result<Transaction, String> {
    let to_seller = spend.prev_amount.checked_sub(p.fee_resolve).and_then(|v| v.checked_sub(p.fee_budget)).ok_or("amount is less than the fees")?;
    build_signed(contract, spend, vec![pay(&p.seller_pk, to_seller), fee_out(p, p.fee_resolve)], "release", buyer_sk)
}

/// refund (seller): everything to the buyer + fee. Works from either mode.
pub fn build_refund_tx(p: &EscrowParams, contract: &CompiledContract<'_>, seller_sk: &[u8; 32], spend: &EscrowSpend) -> Result<Transaction, String> {
    let to_buyer = spend.prev_amount.checked_sub(p.fee_resolve).and_then(|v| v.checked_sub(p.fee_budget)).ok_or("amount is less than the fees")?;
    build_signed(contract, spend, vec![pay(&p.buyer_pk, to_buyer), fee_out(p, p.fee_resolve)], "refund", seller_sk)
}

/// dispute (buyer): ACTIVE -> DISPUTED, amount is preserved (minus the network FEE).
pub fn build_dispute_tx(p: &EscrowParams, buyer_sk: &[u8; 32], spend: &EscrowSpend) -> Result<Transaction, String> {
    let active = p.active_contract()?;
    let disputed = p.disputed_contract()?;
    let out = TransactionOutput::with_covenant(
        spend.prev_amount.checked_sub(p.fee_budget).ok_or("amount is less than the fee")?,
        p2sh(&disputed.script),
        Some(CovenantBinding { authorizing_input: 0, covenant_id: spend.cov_id }),
    );
    build_signed(&active, spend, vec![out], "dispute", buyer_sk)
}

/// autoRelease (unsigned): ACTIVE and age >= disputeWindow -> to seller + fee.
pub fn build_auto_release_tx(p: &EscrowParams, spend: &EscrowSpend) -> Result<Transaction, String> {
    let active = p.active_contract()?;
    let to_seller = spend.prev_amount.checked_sub(p.fee_resolve).and_then(|v| v.checked_sub(p.fee_budget)).ok_or("amount is less than the fees")?;
    build_unsigned(&active, spend, p.dispute_window as u64, vec![pay(&p.seller_pk, to_seller), fee_out(p, p.fee_resolve)], "autoRelease")
}

/// timeout (unsigned): DISPUTED and age >= arbiterDeadline -> the timeout_to party, WITHOUT a fee.
pub fn build_timeout_tx(p: &EscrowParams, spend: &EscrowSpend) -> Result<Transaction, String> {
    let disputed = p.disputed_contract()?;
    let to = spend.prev_amount.checked_sub(p.fee_budget).ok_or("amount is less than the fee")?;
    let (function, dest_pk) = if p.timeout_to == 0 { ("timeoutToBuyer", &p.buyer_pk) } else { ("timeoutToSeller", &p.seller_pk) };
    build_unsigned(&disputed, spend, p.arbiter_deadline as u64, vec![pay(dest_pk, to)], function)
}

// ── Arbitration (operator/arbiter path via rlib; NOT a wasm export, NOT a dealctl party command) ──

/// arbitrate: 100% to one party + fee. `to_buyer=true` -> buyer, otherwise seller.
pub fn build_arbitrate_to_tx(p: &EscrowParams, arb_sk: &[u8; 32], spend: &EscrowSpend, to_buyer: bool) -> Result<Transaction, String> {
    let disputed = p.disputed_contract()?;
    let to = spend.prev_amount.checked_sub(p.fee_dispute).and_then(|v| v.checked_sub(p.fee_budget)).ok_or("amount is less than the fees")?;
    let (function, dest_pk) = if to_buyer { ("arbitrateToBuyer", &p.buyer_pk) } else { ("arbitrateToSeller", &p.seller_pk) };
    build_signed(&disputed, spend, vec![pay(dest_pk, to), fee_out(p, p.fee_dispute)], function, arb_sk)
}

/// arbitrateSplit: `to_buyer` to the buyer, the rest to the seller, + fee. Both outputs must be >= MIN_OUT.
pub fn build_arbitrate_split_tx(p: &EscrowParams, arb_sk: &[u8; 32], spend: &EscrowSpend, to_buyer: u64) -> Result<Transaction, String> {
    let disputed = p.disputed_contract()?;
    let to_seller = spend
        .prev_amount
        .checked_sub(to_buyer)
        .and_then(|v| v.checked_sub(p.fee_dispute))
        .and_then(|v| v.checked_sub(p.fee_budget))
        .ok_or("buyer's share + fees exceeds the amount")?;
    if to_buyer < MIN_OUT || to_seller < MIN_OUT {
        return Err(format!("each share must be >= {} sompi (1 KAS); split verdict is too small — use binary instead", MIN_OUT));
    }
    build_signed(&disputed, spend, vec![pay(&p.buyer_pk, to_buyer), pay(&p.seller_pk, to_seller), fee_out(p, p.fee_dispute)], "arbitrateSplit", arb_sk)
}

// ── mutual (co-signing by the parties): split by mutual consent, WITHOUT an arbiter. Works from ACTIVE and DISPUTED.
//    Both parties build an IDENTICAL tx (outputs are deterministic from cfg+spend+to_buyer) and sign
//    their sighash separately; combine assembles the sigscript [buyerSig, sellerSig]. The fee output is mandatory (K1).

/// mutual outputs: [fee(feeResolve), buyer(to_buyer), seller(to_seller)]. MIN_OUT guard on both shares.
fn mutual_outputs(p: &EscrowParams, spend: &EscrowSpend, to_buyer: u64) -> Result<Vec<TransactionOutput>, String> {
    let to_seller = spend
        .prev_amount
        .checked_sub(to_buyer)
        .and_then(|v| v.checked_sub(p.fee_resolve))
        .and_then(|v| v.checked_sub(p.fee_budget))
        .ok_or("buyer's share + fees exceeds the amount")?;
    if to_buyer < MIN_OUT || to_seller < MIN_OUT {
        return Err(format!("each share must be >= {} sompi (1 KAS); small split — use release/refund instead", MIN_OUT));
    }
    Ok(vec![fee_out(p, p.fee_resolve), pay(&p.buyer_pk, to_buyer), pay(&p.seller_pk, to_seller)])
}

/// One party's signature over the mutual-tx (for co-signing). `contract` = the input contract (active/disputed).
pub fn mutual_sig(p: &EscrowParams, contract: &CompiledContract<'_>, spend: &EscrowSpend, to_buyer: u64, signer_sk: &[u8; 32]) -> Result<Vec<u8>, String> {
    let inputs = [input_from(contract, spend)];
    let tx = build_tx_budget(&inputs, mutual_outputs(p, spend, to_buyer)?, ESCROW_BUDGET);
    let entries = vec![inputs[0].entry.clone()];
    Ok(input_signature(&populated(&tx, &entries), 0, signer_sk))
}

/// Build a submit-ready mutual-tx from two signatures (contract order: buyerSig, sellerSig).
pub fn build_mutual_tx(p: &EscrowParams, contract: &CompiledContract<'_>, spend: &EscrowSpend, to_buyer: u64, buyer_sig: Vec<u8>, seller_sig: Vec<u8>) -> Result<Transaction, String> {
    let inputs = [input_from(contract, spend)];
    let mut tx = build_tx_budget(&inputs, mutual_outputs(p, spend, to_buyer)?, ESCROW_BUDGET);
    tx.inputs[0].signature_script = covenant_sigscript(contract, "mutual", vec![buyer_sig.into(), seller_sig.into()])?;
    tx.finalize();
    Ok(tx)
}

#[cfg(test)]
mod tests {
    // Native VM run: prove that escrow tx built by the shared core are accepted by the same VM check
    // as escrowctl (52/52). This guarantees the port is equivalent.
    use super::*;
    use kaspa_consensus_core::hashing::sighash::SigHashReusedValuesUnsync;
    use kaspa_consensus_core::tx::{PopulatedTransaction, TransactionId, VerifiableTransaction};
    use kaspa_txscript::caches::Cache;
    use kaspa_txscript::covenants::CovenantsContext;
    use kaspa_txscript::{EngineCtx, TxScriptEngine};
    use kaspa_txscript_errors::TxScriptError;

    fn exec(tx: &Transaction, entries: Vec<UtxoEntry>) -> Result<(), TxScriptError> {
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
            EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx),
            crate::tx::engine_flags(),
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

    fn spend_on(contract: &CompiledContract<'_>, amount: u64) -> (EscrowSpend, UtxoEntry) {
        let cov_id = Hash::from_bytes(*b"EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE");
        let entry = UtxoEntry::new(amount, p2sh(&contract.script), 0, false, Some(cov_id));
        (EscrowSpend { prev_outpoint: TransactionOutpoint::new(TransactionId::from_bytes([0xE5; 32]), 0), prev_amount: amount, prev_daa: 0, cov_id }, entry)
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
        let (spend, entry) = spend_on(&p.active_contract().unwrap(), AMT);
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
    fn mutual_split_valid_in_dispute_vm() {
        let (p, bsk, ssk, _) = params();
        // dispute is open → DISPUTED; mutual split by mutual consent must pass the VM in DISPUTED
        let disputed = p.disputed_contract().unwrap();
        let (spend, entry) = spend_on(&disputed, AMT - FEE);
        let to_buyer = 4_000_000_000;
        // parties sign the same tx SEPARATELY
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
        // the arbiter signs instead of the seller — the VM must reject it (checkSig(sellerSig, seller) fails)
        let bsig = mutual_sig(&p, &disputed, &spend, to_buyer, &bsk).unwrap();
        let asig = mutual_sig(&p, &disputed, &spend, to_buyer, &ask).unwrap();
        let tx = build_mutual_tx(&p, &disputed, &spend, to_buyer, bsig, asig).unwrap();
        assert!(exec(&tx, vec![entry]).is_err(), "mutual with the wrong party's signature must be rejected");
    }

    #[test]
    fn arbitrate_wrong_signer_rejected_in_vm() {
        let (p, bsk, _, _) = params();
        let disputed = p.disputed_contract().unwrap();
        let (spend, entry) = spend_on(&disputed, AMT);
        // the buyer tries to play the arbiter — the VM must reject it
        let tx = build_arbitrate_to_tx(&p, &bsk, &spend, true).unwrap();
        assert!(exec(&tx, vec![entry]).is_err(), "arbitrate by a non-arbiter must be rejected");
    }

    #[test]
    fn split_below_min_out_rejected_by_builder() {
        let (p, _, _, ask) = params();
        let disputed = p.disputed_contract().unwrap();
        let (spend, _) = spend_on(&disputed, AMT);
        // the seller's share ends up < MIN_OUT — the builder must reject it BEFORE the VM
        assert!(build_arbitrate_split_tx(&p, &ask, &spend, AMT - FEE - p.fee_dispute).is_err());
    }
}
