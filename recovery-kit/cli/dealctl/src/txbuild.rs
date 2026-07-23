//! Pure transaction planning, building, and local structural verification (spec §7.6, §8, §3.5).
//!
//! Every money command goes through here: it builds the transaction with the shared covenant core,
//! then re-verifies the built transaction against expectations recomputed from the TRUSTED recovery
//! parameters — not from the node and not from any file. The verifier is the fail-closed gate that
//! guarantees the transaction pays only the buyer/seller/fee/covenant the path allows, conserves
//! value exactly, and spends exactly the one covenant input (single-input invariant, spec §3.4).

use kaspa_consensus_core::tx::{ScriptPublicKey, Transaction, TransactionOutpoint};
use kaspa_hashes::Hash;

use kaspa_forge_contracts::escrow::{self, EscrowParams, EscrowSpend, FUND_FEE};
use kaspa_forge_contracts::recovery::{Product, Role, Verified};
use kaspa_forge_contracts::tx::{p2pk_script, p2sh, spk_address};

/// A party-authorized money action (arbitration is NOT here — it is an operator path, not party recovery).
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Release,
    Refund,
    Dispute,
    AutoRelease,
    Timeout,
}

impl Action {
    pub fn name(&self) -> &'static str {
        match self {
            Action::Release => "release",
            Action::Refund => "refund",
            Action::Dispute => "dispute",
            Action::AutoRelease => "auto-release",
            Action::Timeout => "timeout",
        }
    }
    /// The contract role whose key must sign; None = keyless path.
    pub fn required_role(&self) -> Option<Role> {
        match self {
            Action::Release | Action::Dispute => Some(Role::Buyer),
            Action::Refund => Some(Role::Seller),
            Action::AutoRelease | Action::Timeout => None,
        }
    }
    /// The mode the covenant UTXO must be in for this path.
    pub fn required_mode(&self) -> Option<u8> {
        match self {
            Action::Dispute | Action::AutoRelease => Some(0), // ACTIVE
            Action::Timeout => Some(1),                       // DISPUTED
            Action::Release | Action::Refund => None,          // either mode
        }
    }
    /// Minimum UTXO age (DAA) required before this keyless path matures.
    pub fn maturity_daa(&self, p: &EscrowParams) -> Option<u64> {
        match self {
            Action::AutoRelease => Some(p.dispute_window as u64),
            Action::Timeout => Some(p.arbiter_deadline as u64),
            _ => None,
        }
    }
    pub fn from_name(name: &str) -> Option<Action> {
        match name {
            "release" => Some(Action::Release),
            "refund" => Some(Action::Refund),
            "dispute" => Some(Action::Dispute),
            "auto-release" => Some(Action::AutoRelease),
            "timeout" => Some(Action::Timeout),
            _ => None,
        }
    }
}

/// One expected output: the exact scriptPubKey, value, and covenant binding the built tx must carry.
pub struct Expect {
    pub label: String,
    pub spk: ScriptPublicKey,
    pub sompi: u64,
    pub covenant: Option<Hash>,
}

/// Human/serialized description of one output.
#[derive(Clone)]
pub struct OutPlan {
    pub label: String,
    pub address: String,
    pub sompi: u64,
    pub covenant: Option<String>, // hex covenant id, if this output continues/mints a covenant
}

/// Everything a preview, the envelope, and the verifier need about a built transaction.
pub struct Built {
    pub tx: Transaction,
    pub path: String,
    pub mode: u8,
    pub input_outpoints: Vec<TransactionOutpoint>,
    /// For covenant paths, the covenant id of the spent UTXO (needed to re-verify a dispute
    /// continuation output at submit time). None for plain funding paths.
    pub covenant_id: Option<Hash>,
    pub input_total: u64,
    /// The service fee (feeResolve/feeDispute) charged by this path, if any.
    pub service_fee: Option<u64>,
    /// The network fee budget deducted from covenant value (or FUND_FEE for a funding tx).
    pub fee_budget: u64,
    pub outs: Vec<OutPlan>,
}

fn p2pk_spk(pk: &[u8; 32]) -> ScriptPublicKey {
    ScriptPublicKey::new(0, p2pk_script(pk).into())
}

fn to_outplans(expects: &[Expect], network: &str) -> Result<Vec<OutPlan>, String> {
    expects
        .iter()
        .map(|e| {
            Ok(OutPlan {
                label: e.label.clone(),
                address: spk_address(&e.spk, network)?,
                sompi: e.sompi,
                covenant: e.covenant.map(|h| h.to_string()),
            })
        })
        .collect()
}

/// Recompute the exact expected outputs of a covenant money path from trusted parameters.
pub fn expected_covenant_outputs(
    verified: &Verified,
    action: Action,
    spend: &EscrowSpend,
) -> Result<(Vec<Expect>, Option<u64>), String> {
    let p = &verified.params;
    let prev = spend.prev_amount;
    let sub = |a: u64, b: u64| a.checked_sub(b).ok_or_else(|| "amount is less than the fees".to_string());
    match action {
        Action::Release => {
            let to_seller = sub(sub(prev, p.fee_resolve)?, p.fee_budget)?;
            Ok((
                vec![
                    Expect { label: "seller".into(), spk: p2pk_spk(&p.seller_pk), sompi: to_seller, covenant: None },
                    Expect { label: "service fee".into(), spk: p2pk_spk(&p.fee_pk), sompi: p.fee_resolve, covenant: None },
                ],
                Some(p.fee_resolve),
            ))
        }
        Action::AutoRelease => {
            let to_seller = sub(sub(prev, p.fee_resolve)?, p.fee_budget)?;
            Ok((
                vec![
                    Expect { label: "seller".into(), spk: p2pk_spk(&p.seller_pk), sompi: to_seller, covenant: None },
                    Expect { label: "service fee".into(), spk: p2pk_spk(&p.fee_pk), sompi: p.fee_resolve, covenant: None },
                ],
                Some(p.fee_resolve),
            ))
        }
        Action::Refund => {
            let to_buyer = sub(sub(prev, p.fee_resolve)?, p.fee_budget)?;
            Ok((
                vec![
                    Expect { label: "buyer".into(), spk: p2pk_spk(&p.buyer_pk), sompi: to_buyer, covenant: None },
                    Expect { label: "service fee".into(), spk: p2pk_spk(&p.fee_pk), sompi: p.fee_resolve, covenant: None },
                ],
                Some(p.fee_resolve),
            ))
        }
        Action::Dispute => {
            // ACTIVE -> DISPUTED: the whole value (minus feeBudget) continues at the DISPUTED address,
            // keeping the same covenant id.
            let disputed = p.disputed_contract()?;
            let out = sub(prev, p.fee_budget)?;
            Ok((
                vec![Expect { label: "disputed covenant".into(), spk: p2sh(&disputed.script), sompi: out, covenant: Some(spend.cov_id) }],
                None,
            ))
        }
        Action::Timeout => {
            let out = sub(prev, p.fee_budget)?;
            let dest = if p.timeout_to == 0 { &p.buyer_pk } else { &p.seller_pk };
            let label = if p.timeout_to == 0 { "buyer (timeout)" } else { "seller (timeout)" };
            Ok((vec![Expect { label: label.into(), spk: p2pk_spk(dest), sompi: out, covenant: None }], None))
        }
    }
}

fn call_builder(verified: &Verified, action: Action, spend: &EscrowSpend, mode: u8) -> Result<Transaction, String> {
    let p = &verified.params;
    let contract = if mode == 0 { p.active_contract()? } else { p.disputed_contract()? };
    match action {
        Action::Release => escrow::build_release_tx(p, &contract, &verified.party_sk, spend),
        Action::Refund => escrow::build_refund_tx(p, &contract, &verified.party_sk, spend),
        Action::Dispute => escrow::build_dispute_tx(p, &verified.party_sk, spend),
        Action::AutoRelease => escrow::build_auto_release_tx(p, spend),
        Action::Timeout => escrow::build_timeout_tx(p, spend),
    }
}

/// Build and locally verify a covenant money transaction for one UTXO line.
pub fn build_covenant(verified: &Verified, action: Action, mode: u8, spend: &EscrowSpend) -> Result<Built, String> {
    // Role / mode gating BEFORE building — refuse to use the wrong-role key even though the contract
    // itself would also reject it (spec §7.3), and refuse the wrong mode for the path.
    if let Some(required) = action.required_role() {
        if verified.role != required {
            return Err(format!(
                "{} needs the {} key, but this recovery record is the {} party",
                action.name(),
                required_label(verified, required),
                role_label(verified, verified.role)
            ));
        }
    }
    if let Some(required_mode) = action.required_mode() {
        if mode != required_mode {
            return Err(format!(
                "{} requires a UTXO in {} mode, but this line is {}",
                action.name(),
                mode_name(required_mode),
                mode_name(mode)
            ));
        }
    }

    let (expects, service_fee) = expected_covenant_outputs(verified, action, spend)?;
    let tx = call_builder(verified, action, spend, mode)?;
    verify_outputs(&tx, &expects)?;
    verify_single_input(&tx, spend.prev_outpoint)?;
    verify_conservation(spend.prev_amount, &expects, verified.params.fee_budget)?;

    Ok(Built {
        tx,
        path: action.name().into(),
        mode,
        input_outpoints: vec![spend.prev_outpoint],
        covenant_id: Some(spend.cov_id),
        input_total: spend.prev_amount,
        service_fee,
        fee_budget: verified.params.fee_budget,
        outs: to_outplans(&expects, &verified.network)?,
    })
}

/// Build and locally verify a funding transaction: funding-key P2PK UTXOs -> ACTIVE covenant genesis.
pub fn build_fund(verified: &Verified, utxos: &[(TransactionOutpoint, u64, u64, bool)]) -> Result<Built, String> {
    let f = verified.funding.as_ref().ok_or("this recovery record has no funding key — nothing to fund")?;
    if utxos.is_empty() {
        return Err("no UTXOs at the funding address".into());
    }
    // Checked accumulation of untrusted node amounts BEFORE handing them to the builder — a poisoned
    // response must fail cleanly, never panic under overflow checks.
    let input_total = checked_utxo_total(utxos)?;
    let (tx, cov_id) = escrow::build_escrow_fund_tx(&verified.params, &f.sk, &f.pk, utxos.to_vec())?;
    let active = verified.params.active_contract()?;
    let out_amount = input_total.checked_sub(FUND_FEE).ok_or("insufficient funds")?;
    let expects = vec![Expect {
        label: "active covenant (genesis)".into(),
        spk: p2sh(&active.script),
        sompi: out_amount,
        covenant: Some(cov_id),
    }];
    verify_outputs(&tx, &expects)?;
    verify_conservation(input_total, &expects, FUND_FEE)?;
    let input_outpoints: Vec<TransactionOutpoint> = utxos.iter().map(|(op, _, _, _)| *op).collect();
    Ok(Built {
        tx,
        path: "fund".into(),
        mode: 0,
        input_outpoints,
        covenant_id: None,
        input_total,
        service_fee: None,
        fee_budget: FUND_FEE,
        outs: to_outplans(&expects, &verified.network)?,
    })
}

/// Sweep the not-yet-locked funding-key balance back to a plain P2PK address (spec §7.2). This is an
/// ordinary P2PK spend — no covenant is involved — so it is built here directly from the primitives.
pub fn build_funding_sweep(
    verified: &Verified,
    to_address: &str,
    utxos: &[(TransactionOutpoint, u64, u64, bool)],
) -> Result<Built, String> {
    use kaspa_addresses::Address;
    use kaspa_consensus_core::tx::{TransactionOutput, UtxoEntry};
    use kaspa_forge_contracts::tx::{build_tx_budget, p2pk_sigscript, populated, InputSpec, COMPUTE_BUDGET};

    let f = verified.funding.as_ref().ok_or("this recovery record has no funding key — nothing to sweep")?;
    if utxos.is_empty() {
        return Err("no plain UTXOs at the funding address".into());
    }
    let dest: Address = to_address.try_into().map_err(|e| format!("bad --to address {to_address}: {e:?}"))?;
    let dest_spk = kaspa_txscript::pay_to_address_script(&dest);
    let total = checked_utxo_total(utxos)?;
    let fee = fund_fee(utxos.len());
    let out_amount = total.checked_sub(fee).ok_or("funding balance is less than the fee")?;

    let funding_spk = ScriptPublicKey::new(0, p2pk_script(&f.pk).into());
    let inputs: Vec<InputSpec> = utxos
        .iter()
        .map(|(op, a, d, cb)| InputSpec {
            outpoint: *op,
            entry: UtxoEntry::new(*a, funding_spk.clone(), *d, *cb, None),
            sequence: 0,
        })
        .collect();
    let mut tx = build_tx_budget(&inputs, vec![TransactionOutput::new(out_amount, dest_spk.clone())], COMPUTE_BUDGET);
    let entries: Vec<UtxoEntry> = inputs.iter().map(|i| i.entry.clone()).collect();
    let sigs: Vec<Vec<u8>> = (0..inputs.len()).map(|i| p2pk_sigscript(&populated(&tx, &entries), i, &f.sk)).collect();
    for (i, sgn) in sigs.into_iter().enumerate() {
        tx.inputs[i].signature_script = sgn;
    }
    tx.finalize();

    let expects = vec![Expect { label: "your wallet".into(), spk: dest_spk, sompi: out_amount, covenant: None }];
    verify_outputs(&tx, &expects)?;
    verify_conservation(total, &expects, fee)?;
    Ok(Built {
        tx,
        path: "sweep-funding".into(),
        mode: 0,
        input_outpoints: utxos.iter().map(|(op, _, _, _)| *op).collect(),
        covenant_id: None,
        input_total: total,
        service_fee: None,
        fee_budget: fee,
        outs: to_outplans(&expects, &verified.network)?,
    })
}

/// Mempool-safe fee for an n-input plain P2PK sweep (mirrors the product's fund_fee scaling).
fn fund_fee(n_inputs: usize) -> u64 {
    (n_inputs as u64 * 350_000).max(1_000_000)
}

/// Upper bound on UTXOs accepted in one funding/sweep, to reject absurd poisoned node responses.
pub const MAX_FUNDING_UTXOS: usize = 100_000;

/// Total value of untrusted UTXO tuples, refusing an implausible count and any overflowing sum.
pub fn checked_utxo_total(utxos: &[(TransactionOutpoint, u64, u64, bool)]) -> Result<u64, String> {
    if utxos.len() > MAX_FUNDING_UTXOS {
        return Err(format!("{} funding UTXOs (> {MAX_FUNDING_UTXOS}) — refusing", utxos.len()));
    }
    utxos
        .iter()
        .try_fold(0u64, |acc, (_, v, _, _)| acc.checked_add(*v))
        .ok_or_else(|| "funding UTXO amount sum overflows u64".into())
}

/// The unsigned outputs of a mutual settlement, used both to co-sign and to combine (spec §7.5).
pub fn mutual_expected(verified: &Verified, spend: &EscrowSpend, to_buyer: u64) -> Result<(Vec<Expect>, u64), String> {
    let p = &verified.params;
    let to_seller = p
        .prev_minus(spend.prev_amount, to_buyer)
        .and_then(|v| v.checked_sub(p.fee_resolve))
        .and_then(|v| v.checked_sub(p.fee_budget))
        .ok_or("buyer's share + fees exceeds the amount")?;
    let expects = vec![
        Expect { label: "service fee".into(), spk: p2pk_spk(&p.fee_pk), sompi: p.fee_resolve, covenant: None },
        Expect { label: "buyer".into(), spk: p2pk_spk(&p.buyer_pk), sompi: to_buyer, covenant: None },
        Expect { label: "seller".into(), spk: p2pk_spk(&p.seller_pk), sompi: to_seller, covenant: None },
    ];
    Ok((expects, to_seller))
}

/// Build the exact UNSIGNED mutual transaction both parties sign — its id is the commitment tying
/// the two signature packages together (spec §7.5).
pub fn mutual_unsigned_tx(verified: &Verified, spend: &EscrowSpend, mode: u8, to_buyer: u64) -> Result<Transaction, String> {
    use kaspa_consensus_core::tx::{TransactionOutput, UtxoEntry};
    use kaspa_forge_contracts::escrow::ESCROW_BUDGET;
    use kaspa_forge_contracts::tx::{build_tx_budget, InputSpec};

    let contract = if mode == 0 { verified.params.active_contract()? } else { verified.params.disputed_contract()? };
    let (expects, _to_seller) = mutual_expected(verified, spend, to_buyer)?;
    let inputs = [InputSpec {
        outpoint: spend.prev_outpoint,
        entry: UtxoEntry::new(spend.prev_amount, p2sh(&contract.script), spend.prev_daa, false, Some(spend.cov_id)),
        sequence: 0,
    }];
    let outputs: Vec<TransactionOutput> = expects.iter().map(|e| TransactionOutput::new(e.sompi, e.spk.clone())).collect();
    let mut tx = build_tx_budget(&inputs, outputs, ESCROW_BUDGET);
    tx.finalize();
    Ok(tx)
}

/// Combine two mutual signatures into a submit-ready transaction and locally verify it.
pub fn build_mutual(
    verified: &Verified,
    spend: &EscrowSpend,
    mode: u8,
    to_buyer: u64,
    buyer_sig: Vec<u8>,
    seller_sig: Vec<u8>,
) -> Result<Built, String> {
    let contract = if mode == 0 { verified.params.active_contract()? } else { verified.params.disputed_contract()? };
    let tx = escrow::build_mutual_tx(&verified.params, &contract, spend, to_buyer, buyer_sig, seller_sig)?;
    let (expects, _to_seller) = mutual_expected(verified, spend, to_buyer)?;
    verify_outputs(&tx, &expects)?;
    verify_single_input(&tx, spend.prev_outpoint)?;
    verify_conservation(spend.prev_amount, &expects, verified.params.fee_budget)?;
    Ok(Built {
        tx,
        path: "mutual".into(),
        mode,
        input_outpoints: vec![spend.prev_outpoint],
        covenant_id: Some(spend.cov_id),
        input_total: spend.prev_amount,
        service_fee: Some(verified.params.fee_resolve),
        fee_budget: verified.params.fee_budget,
        outs: to_outplans(&expects, &verified.network)?,
    })
}

// ── local structural verifiers (fail-closed) ──

fn verify_single_input(tx: &Transaction, expected: TransactionOutpoint) -> Result<(), String> {
    if tx.inputs.len() != 1 {
        return Err(format!("single-input invariant violated: {} inputs", tx.inputs.len()));
    }
    if tx.inputs[0].previous_outpoint != expected {
        return Err("built transaction does not spend the selected covenant UTXO".into());
    }
    Ok(())
}

pub fn verify_outputs(tx: &Transaction, expects: &[Expect]) -> Result<(), String> {
    if tx.outputs.len() != expects.len() {
        return Err(format!("output count {} != expected {}", tx.outputs.len(), expects.len()));
    }
    for (i, e) in expects.iter().enumerate() {
        let o = &tx.outputs[i];
        if o.script_public_key != e.spk {
            return Err(format!("output {i} ({}) goes to an unexpected scriptPubKey", e.label));
        }
        if o.value != e.sompi {
            return Err(format!("output {i} ({}) value {} != expected {}", i, o.value, e.sompi));
        }
        if o.value == 0 {
            return Err(format!("output {i} ({}) is a dust/zero output", e.label));
        }
        let got = o.covenant.as_ref().map(|c| c.covenant_id);
        if got != e.covenant {
            return Err(format!("output {i} ({}) covenant binding mismatch", e.label));
        }
    }
    Ok(())
}

fn verify_conservation(input_total: u64, expects: &[Expect], fee_budget: u64) -> Result<(), String> {
    let out_total: u64 = expects.iter().try_fold(0u64, |acc, e| acc.checked_add(e.sompi)).ok_or("output sum overflow")?;
    let with_fee = out_total.checked_add(fee_budget).ok_or("value+fee overflow")?;
    if with_fee != input_total {
        return Err(format!("value not conserved: outputs {out_total} + fee {fee_budget} != input {input_total}"));
    }
    Ok(())
}

// ── labels ──

fn mode_name(mode: u8) -> &'static str {
    if mode == 0 { "ACTIVE" } else { "DISPUTED" }
}

fn role_label(v: &Verified, role: Role) -> &'static str {
    role.product_label(v.product)
}
fn required_label(v: &Verified, role: Role) -> &'static str {
    role.product_label(v.product)
}

/// A tiny helper so EscrowParams can express `prev - to_buyer` with overflow safety without leaking
/// arithmetic into callers.
trait PrevMinus {
    fn prev_minus(&self, prev: u64, x: u64) -> Option<u64>;
}
impl PrevMinus for EscrowParams {
    fn prev_minus(&self, prev: u64, x: u64) -> Option<u64> {
        prev.checked_sub(x)
    }
}

/// Ensure a product/action combination is coherent (Deposit aliases must carry product=deposit).
pub fn check_product(verified: &Verified, expected: Product) -> Result<(), String> {
    if verified.product != expected {
        return Err(format!(
            "this recovery record is a {:?} record; use the matching command family",
            verified.product
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use kaspa_consensus_core::tx::{TransactionId, UtxoEntry};
    use kaspa_forge_contracts::recovery::VerifiedFunding;
    use kaspa_forge_contracts::registry;

    fn verified(role: Role) -> Verified {
        let p = registry::canonical_reference_params();
        let sk = if role == Role::Buyer { [1u8; 32] } else { [2u8; 32] };
        let pk = if role == Role::Buyer { p.buyer_pk } else { p.seller_pk };
        Verified {
            product: Product::Escrow,
            role,
            network: "mainnet".into(),
            deal_id: 1,
            params: p,
            party_sk: sk,
            party_pk: pk,
            funding: None,
            active_addr: String::new(),
            disputed_addr: String::new(),
            version: &registry::ESCROW_V1,
        }
    }

    fn spend(mode: u8, amount: u64) -> EscrowSpend {
        let v = verified(Role::Buyer);
        let contract = if mode == 0 { v.params.active_contract().unwrap() } else { v.params.disputed_contract().unwrap() };
        let cov_id = Hash::from_bytes([0xE5; 32]);
        let _entry = UtxoEntry::new(amount, p2sh(&contract.script), 0, false, Some(cov_id));
        EscrowSpend { prev_outpoint: TransactionOutpoint::new(TransactionId::from_bytes([0xE5; 32]), 0), prev_amount: amount, prev_daa: 0, cov_id }
    }

    const AMT: u64 = 10_000_000_000;

    #[test]
    fn release_builds_and_verifies() {
        let v = verified(Role::Buyer);
        let b = build_covenant(&v, Action::Release, 0, &spend(0, AMT)).unwrap();
        assert_eq!(b.outs.len(), 2);
        assert_eq!(b.input_total, AMT);
        // seller gets prev - feeResolve - feeBudget
        assert_eq!(b.outs[0].sompi, AMT - v.params.fee_resolve - v.params.fee_budget);
        assert_eq!(b.outs[1].sompi, v.params.fee_resolve);
    }

    #[test]
    fn refund_requires_seller_role() {
        let buyer = verified(Role::Buyer);
        assert!(build_covenant(&buyer, Action::Refund, 0, &spend(0, AMT)).is_err(), "buyer cannot refund");
        let seller = verified(Role::Seller);
        assert!(build_covenant(&seller, Action::Refund, 0, &spend(0, AMT)).is_ok());
    }

    #[test]
    fn release_needs_buyer_role() {
        let seller = verified(Role::Seller);
        assert!(build_covenant(&seller, Action::Release, 0, &spend(0, AMT)).is_err(), "seller cannot release");
    }

    #[test]
    fn dispute_requires_active_mode() {
        let v = verified(Role::Buyer);
        assert!(build_covenant(&v, Action::Dispute, 1, &spend(1, AMT)).is_err(), "dispute only from ACTIVE");
        let b = build_covenant(&v, Action::Dispute, 0, &spend(0, AMT)).unwrap();
        assert_eq!(b.outs.len(), 1);
        assert!(b.outs[0].covenant.is_some(), "dispute continues the covenant");
        assert_eq!(b.outs[0].sompi, AMT - v.params.fee_budget);
    }

    #[test]
    fn timeout_requires_disputed_mode_and_has_no_fee() {
        let v = verified(Role::Buyer);
        assert!(build_covenant(&v, Action::Timeout, 0, &spend(0, AMT)).is_err(), "timeout only from DISPUTED");
        let b = build_covenant(&v, Action::Timeout, 1, &spend(1, AMT)).unwrap();
        assert_eq!(b.outs.len(), 1, "timeout pays exactly one party, no service fee");
        assert_eq!(b.service_fee, None);
    }

    #[test]
    fn auto_release_is_keyless() {
        // Even a record with the "wrong" role can build a keyless path.
        let seller = verified(Role::Seller);
        assert!(build_covenant(&seller, Action::AutoRelease, 0, &spend(0, AMT)).is_ok());
    }

    #[test]
    fn fund_builds_genesis() {
        let mut v = verified(Role::Buyer);
        v.funding = Some(VerifiedFunding { sk: [7u8; 32], pk: kaspa_forge_contracts::tx::sk_to_xonly(&[7u8; 32]).unwrap(), address: String::new() });
        let utxos = vec![(TransactionOutpoint::new(TransactionId::from_bytes([0x11; 32]), 0), AMT, 0, false)];
        let b = build_fund(&v, &utxos).unwrap();
        assert_eq!(b.outs.len(), 1);
        assert!(b.outs[0].covenant.is_some(), "funding mints a genesis covenant");
        assert_eq!(b.outs[0].sompi, AMT - FUND_FEE);
    }

    #[test]
    fn mutual_shares_conserve_value() {
        let v = verified(Role::Buyer);
        let (expects, to_seller) = mutual_expected(&v, &spend(1, AMT), 4_000_000_000).unwrap();
        assert_eq!(expects.len(), 3);
        let sum: u64 = expects.iter().map(|e| e.sompi).sum();
        assert_eq!(sum + v.params.fee_budget, AMT);
        assert_eq!(expects[2].sompi, to_seller);
    }
}
