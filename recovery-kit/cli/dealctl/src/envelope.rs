//! On-disk transaction envelopes (spec §7.5, §7.6): a signed transaction ready to submit from an
//! online machine WITHOUT the private key, and a one-party mutual-settlement signature package.
//!
//! Both are self-describing and re-verified before use. `submit` never trusts the envelope blindly:
//! it recomputes the txid from the transaction bytes, re-derives every output address from the
//! transaction's own scriptPubKeys, and re-checks value conservation and the single-input invariant.

use kaspa_consensus_core::tx::Transaction;
use serde::{Deserialize, Serialize};

use kaspa_forge_contracts::recovery::{Product, Role};
use kaspa_forge_contracts::tx::spk_address;

use crate::txbuild::{Built, OutPlan};

pub const SIGNED_TX_SCHEMA: &str = "kaspa-forge-signed-tx";
pub const MUTUAL_SIG_SCHEMA: &str = "kaspa-forge-mutual-signature";
pub const SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OutJson {
    pub label: String,
    pub address: String,
    pub sompi: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub covenant: Option<String>,
}

impl From<&OutPlan> for OutJson {
    fn from(o: &OutPlan) -> Self {
        OutJson { label: o.label.clone(), address: o.address.clone(), sompi: o.sompi, covenant: o.covenant.clone() }
    }
}

/// A built, signed transaction plus everything needed to re-verify it before broadcast.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignedTx {
    pub schema: String,
    pub schema_version: u32,
    pub network: String,
    pub product: Product,
    pub deal_id: u64,
    pub path: String,
    pub mode: u8,
    pub inputs: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub covenant_id: Option<String>,
    pub input_total: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_fee: Option<u64>,
    pub fee_budget: u64,
    pub outputs: Vec<OutJson>,
    pub txid: String,
    pub tx: Transaction,
}

impl SignedTx {
    pub fn from_built(b: &Built, network: &str, product: Product, deal_id: u64) -> Self {
        SignedTx {
            schema: SIGNED_TX_SCHEMA.into(),
            schema_version: SCHEMA_VERSION,
            network: network.into(),
            product,
            deal_id,
            path: b.path.clone(),
            mode: b.mode,
            inputs: b.input_outpoints.iter().map(crate::node::fmt_outpoint).collect(),
            covenant_id: b.covenant_id.map(|h| h.to_string()),
            input_total: b.input_total,
            service_fee: b.service_fee,
            fee_budget: b.fee_budget,
            outputs: b.outs.iter().map(OutJson::from).collect(),
            txid: b.tx.id().to_string(),
            tx: b.tx.clone(),
        }
    }

    pub fn from_json(s: &str) -> Result<Self, String> {
        let v: SignedTx = serde_json::from_str(s).map_err(|e| format!("signed-tx envelope: {e}"))?;
        if v.schema != SIGNED_TX_SCHEMA {
            return Err(format!("not a signed-tx envelope (schema {:?})", v.schema));
        }
        if v.schema_version != SCHEMA_VERSION {
            return Err(format!("unsupported signed-tx schema_version {}", v.schema_version));
        }
        Ok(v)
    }

    pub fn to_json(&self) -> Result<String, String> {
        serde_json::to_string_pretty(self).map_err(|e| e.to_string())
    }

    /// Paths that spend a covenant UTXO and therefore MUST have exactly one input (single-input
    /// invariant). Funding paths consolidate several plain P2PK inputs and may have more.
    fn is_covenant_path(&self) -> bool {
        matches!(self.path.as_str(), "release" | "refund" | "dispute" | "auto-release" | "timeout" | "mutual")
    }

    fn known_path(&self) -> bool {
        self.is_covenant_path() || matches!(self.path.as_str(), "fund" | "sweep-funding")
    }

    /// Static path policy: the mode a path requires (if any), the exact output count, and which
    /// single output (if any) must carry a covenant binding. Derived from the covenant paths, NOT
    /// from the envelope's own metadata — so a transaction cannot be relabelled to a different path.
    fn path_policy(&self) -> Result<(Option<u8>, usize, Option<usize>), String> {
        Ok(match self.path.as_str() {
            // path            required_mode   out_count   covenant_output
            "fund" => (Some(0), 1, Some(0)),                  // ACTIVE genesis
            "dispute" => (Some(0), 1, Some(0)),               // ACTIVE -> DISPUTED continuation
            "auto-release" => (Some(0), 2, None),             // ACTIVE: seller + fee
            "timeout" => (Some(1), 1, None),                  // DISPUTED: one party, no fee
            "release" | "refund" => (None, 2, None),          // either mode: party + fee
            "mutual" => (None, 3, None),                      // either mode: fee + buyer + seller
            "sweep-funding" => (Some(0), 1, None),            // plain P2PK sweep
            other => return Err(format!("unknown transaction path {other:?}")),
        })
    }

    fn check_path_policy(&self) -> Result<(), String> {
        let (req_mode, out_count, cov_idx) = self.path_policy()?;
        if let Some(m) = req_mode {
            if self.mode != m {
                let want = if m == 0 { "ACTIVE" } else { "DISPUTED" };
                return Err(format!("{} requires {want} mode, but the envelope declares mode {}", self.path, self.mode));
            }
        }
        if self.tx.outputs.len() != out_count {
            return Err(format!("{} must have {out_count} output(s), the transaction has {}", self.path, self.tx.outputs.len()));
        }
        for (i, o) in self.tx.outputs.iter().enumerate() {
            let has_cov = o.covenant.is_some();
            let should = cov_idx == Some(i);
            if has_cov != should {
                return Err(format!("{} path: output {i} covenant binding {} contradicts the path shape", self.path, has_cov));
            }
        }
        Ok(())
    }

    /// Re-verify the envelope end-to-end and return the transaction ready to submit (spec §7.6).
    /// Fail-closed: any inconsistency between the stated metadata and the actual transaction bytes,
    /// a value that does not conserve, or a violation of the CLI's own path/single-input policy,
    /// aborts before broadcast.
    pub fn verify_for_submit(&self) -> Result<&Transaction, String> {
        // 1. txid must match the actual transaction.
        let real = self.tx.id().to_string();
        if real != self.txid {
            return Err(format!("txid mismatch: envelope {} != recomputed {real}", self.txid));
        }
        // 2. path / mode / product must be recognised, and the transaction's actual shape (mode,
        //    output count, covenant-output position) must match the path — so a transaction cannot be
        //    relabelled to a different path (e.g. a release presented as a dispute).
        if !self.known_path() {
            return Err(format!("unknown transaction path {:?}", self.path));
        }
        if self.mode > 1 {
            return Err(format!("invalid mode {}", self.mode));
        }
        self.check_path_policy()?;
        // 3. inputs: the multiset of spent outpoints must EXACTLY equal the stated set (rejects
        //    duplicates and any extra/altered input), every spent outpoint is unique, and covenant
        //    paths must spend exactly one UTXO.
        if self.tx.inputs.len() != self.inputs.len() {
            return Err(format!("input count {} != stated {}", self.tx.inputs.len(), self.inputs.len()));
        }
        if self.is_covenant_path() && self.tx.inputs.len() != 1 {
            return Err(format!("single-input invariant: {} path has {} inputs", self.path, self.tx.inputs.len()));
        }
        let mut actual: Vec<String> = self.tx.inputs.iter().map(|i| crate::node::fmt_outpoint(&i.previous_outpoint)).collect();
        let mut stated = self.inputs.clone();
        actual.sort();
        stated.sort();
        if actual != stated {
            return Err("transaction inputs do not exactly match the stated inputs".into());
        }
        let mut deduped = actual.clone();
        deduped.dedup();
        if deduped.len() != actual.len() {
            return Err("transaction spends the same outpoint more than once".into());
        }
        // 4. outputs match the stated plan: address recomputed from the tx's own scriptPubKey, value,
        //    and covenant binding.
        if self.tx.outputs.len() != self.outputs.len() {
            return Err(format!("output count {} != stated {}", self.tx.outputs.len(), self.outputs.len()));
        }
        for (i, want) in self.outputs.iter().enumerate() {
            let o = &self.tx.outputs[i];
            let addr = spk_address(&o.script_public_key, &self.network)?;
            if addr != want.address {
                return Err(format!("output {i} address {addr} != stated {}", want.address));
            }
            if o.value != want.sompi {
                return Err(format!("output {i} value {} != stated {}", o.value, want.sompi));
            }
            if o.value == 0 {
                return Err(format!("output {i} is a dust/zero output"));
            }
            let got = o.covenant.as_ref().map(|c| c.covenant_id.to_string());
            if got != want.covenant {
                return Err(format!("output {i} covenant binding mismatch"));
            }
        }
        // 4. value conservation.
        let out_total: u64 = self.tx.outputs.iter().try_fold(0u64, |a, o| a.checked_add(o.value)).ok_or("output overflow")?;
        let with_fee = out_total.checked_add(self.fee_budget).ok_or("value+fee overflow")?;
        if with_fee != self.input_total {
            return Err(format!("value not conserved: outputs {out_total} + fee {} != input {}", self.fee_budget, self.input_total));
        }
        Ok(&self.tx)
    }

    /// Stronger, optional re-verification against a trusted recovery record (when `submit --recovery`
    /// is used): for a covenant path, reconstruct the spend from the envelope and recompute the exact
    /// expected outputs from the record's parameters — catching a tampered recipient/amount that the
    /// self-consistency checks alone cannot. Non-covenant paths (fund/sweep) fall back to structural
    /// checks only.
    pub fn verify_against_record(&self, verified: &kaspa_forge_contracts::recovery::Verified) -> Result<(), String> {
        if verified.product != self.product {
            return Err("recovery record product does not match the envelope".into());
        }
        if verified.network != self.network {
            return Err("recovery record network does not match the envelope".into());
        }
        if verified.deal_id != self.deal_id {
            return Err("recovery record deal_id does not match the envelope".into());
        }
        if !self.is_covenant_path() {
            return Ok(()); // funding paths carry no covenant spend to recompute from params
        }
        let outpoint = crate::node::parse_outpoint(self.inputs.first().ok_or("no input in envelope")?)?;
        let cov_hex = self.covenant_id.as_ref().ok_or("covenant path envelope is missing covenant_id")?;
        let cov_id: kaspa_hashes::Hash = cov_hex.parse().map_err(|_| "bad covenant_id in envelope")?;
        let spend = kaspa_forge_contracts::escrow::EscrowSpend {
            prev_outpoint: outpoint,
            prev_amount: self.input_total,
            prev_daa: 0,
            cov_id,
        };
        let expects = if self.path == "mutual" {
            // mutual outputs are [fee, buyer, seller]; recover to_buyer from the buyer output.
            let to_buyer = self.tx.outputs.get(1).ok_or("malformed mutual outputs")?.value;
            crate::txbuild::mutual_expected(verified, &spend, to_buyer)?.0
        } else {
            let action = crate::txbuild::Action::from_name(&self.path).ok_or_else(|| format!("unknown covenant path {}", self.path))?;
            crate::txbuild::expected_covenant_outputs(verified, action, &spend)?.0
        };
        crate::txbuild::verify_outputs(&self.tx, &expects)
    }
}

/// A PUBLIC-only view of a deal, written offline by `dealctl watch` and consumed by the online
/// `prepare`/`status` commands so the private recovery record (with the signing key) NEVER has to be
/// copied onto the online machine. It carries only the deal's public addresses and identity.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WatchRecord {
    pub schema: String,
    pub schema_version: u32,
    pub network: String,
    pub product: Product,
    pub deal_id: u64,
    pub active: String,
    pub disputed: String,
}

pub const WATCH_SCHEMA: &str = "kaspa-forge-watch";

impl WatchRecord {
    pub fn from_json(s: &str) -> Result<Self, String> {
        let v: WatchRecord = serde_json::from_str(s).map_err(|e| format!("watch file: {e}"))?;
        if v.schema != WATCH_SCHEMA {
            return Err(format!("not a watch file (schema {:?})", v.schema));
        }
        if v.schema_version != SCHEMA_VERSION {
            return Err(format!("unsupported watch schema_version {}", v.schema_version));
        }
        Ok(v)
    }
    pub fn to_json(&self) -> Result<String, String> {
        serde_json::to_string_pretty(self).map_err(|e| e.to_string())
    }
}

/// A covenant-line package written online by `dealctl prepare` and consumed offline by the money
/// commands (`--line`). It carries exactly the per-line facts an air-gapped machine needs to build a
/// transaction without a node: outpoint, amount, covenant id and mode. It contains NO private key.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LinePackage {
    pub schema: String,
    pub schema_version: u32,
    pub network: String,
    pub product: Product,
    pub deal_id: u64,
    pub lines: Vec<LineEntry>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LineEntry {
    pub mode: u8,
    pub outpoint: String,
    pub amount: u64,
    pub covenant_id: String,
    pub daa: u64,
}

pub const LINE_PACKAGE_SCHEMA: &str = "kaspa-forge-line-package";

impl LinePackage {
    pub fn from_json(s: &str) -> Result<Self, String> {
        let v: LinePackage = serde_json::from_str(s).map_err(|e| format!("line package: {e}"))?;
        if v.schema != LINE_PACKAGE_SCHEMA {
            return Err(format!("not a line package (schema {:?})", v.schema));
        }
        if v.schema_version != SCHEMA_VERSION {
            return Err(format!("unsupported line package schema_version {}", v.schema_version));
        }
        Ok(v)
    }
    pub fn to_json(&self) -> Result<String, String> {
        serde_json::to_string_pretty(self).map_err(|e| e.to_string())
    }
}

/// One party's signature over a mutual settlement (spec §7.5). Two of these, one per role, over the
/// SAME unsigned transaction, combine into a submit-ready mutual transaction.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MutualSig {
    pub schema: String,
    pub schema_version: u32,
    pub network: String,
    pub product: Product,
    pub deal_id: u64,
    pub mode: u8,
    pub outpoint: String,
    pub covenant_id: String,
    pub to_buyer: u64,
    pub to_seller: u64,
    /// The id of the unsigned mutual transaction — the exact object both parties sign.
    pub unsigned_txid: String,
    pub signer_role: Role,
    pub signature: String,
}

impl MutualSig {
    pub fn from_json(s: &str) -> Result<Self, String> {
        let v: MutualSig = serde_json::from_str(s).map_err(|e| format!("mutual-signature package: {e}"))?;
        if v.schema != MUTUAL_SIG_SCHEMA {
            return Err(format!("not a mutual-signature package (schema {:?})", v.schema));
        }
        if v.schema_version != SCHEMA_VERSION {
            return Err(format!("unsupported mutual-signature schema_version {}", v.schema_version));
        }
        Ok(v)
    }

    pub fn to_json(&self) -> Result<String, String> {
        serde_json::to_string_pretty(self).map_err(|e| e.to_string())
    }

    /// Two packages combine only if they describe the SAME transaction from DIFFERENT roles (spec §7.5).
    pub fn agrees_with(&self, other: &MutualSig) -> Result<(), String> {
        if self.signer_role == other.signer_role {
            return Err("both signatures are from the same role — need one buyer and one seller".into());
        }
        let same = self.network == other.network
            && self.product == other.product
            && self.deal_id == other.deal_id
            && self.mode == other.mode
            && self.outpoint == other.outpoint
            && self.covenant_id == other.covenant_id
            && self.to_buyer == other.to_buyer
            && self.to_seller == other.to_seller
            && self.unsigned_txid == other.unsigned_txid;
        if !same {
            return Err("the two signatures are over different transactions — refusing to combine".into());
        }
        Ok(())
    }
}
