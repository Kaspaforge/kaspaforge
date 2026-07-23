//! `dealctl extract` (spec §5.1): pull the minimal recovery record for one deal out of a decrypted
//! Desk profile, migrating a legacy `cfg` (which has no explicit `fee_budget`) to the default
//! 1_000_000 sompi that the browser used when it created the covenant. The result is written 0600,
//! without overwriting, and only after `verify()` confirms it reproduces the deal's stored addresses.

use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;

use kaspa_forge_contracts::recovery::{
    Addresses, ContractRef, Funding, Params, Product, RecoveryRecord, Role, SCHEMA, SCHEMA_VERSION,
};
use kaspa_forge_contracts::registry::ESCROW_V1;
use kaspa_forge_contracts::tx::{pubkey_address, sk_to_xonly};

/// Legacy default: the browser's `default_fee_budget()` when a cfg carried no explicit field.
const LEGACY_FEE_BUDGET: u64 = 1_000_000;
/// The canonical public silverscript revision this build compiles with (recorded in ESCROW_V1).
const BUILD_SILVERSCRIPT_REV: &str = "26e3b9f94821b6fe47a2492755252ec4f995abb1";

fn get<'a>(v: &'a serde_json::Value, k: &str) -> Option<&'a serde_json::Value> {
    v.get(k).filter(|x| !x.is_null())
}
fn s(v: &serde_json::Value, k: &str) -> Option<String> {
    get(v, k).and_then(|x| x.as_str()).map(|x| x.to_string())
}
fn n(v: &serde_json::Value, k: &str) -> Option<i64> {
    get(v, k).and_then(|x| x.as_i64())
}
fn u(v: &serde_json::Value, k: &str) -> Option<u64> {
    get(v, k).and_then(|x| x.as_u64())
}

fn deal_id_matches(deal: &serde_json::Value, want: &str) -> bool {
    match deal.get("id") {
        Some(serde_json::Value::Number(nr)) => nr.to_string() == want,
        Some(serde_json::Value::String(st)) => st == want,
        _ => false,
    }
}

/// Build the recovery record for `deal_id` from a decrypted profile JSON.
pub fn extract_record(profile_json: &str, deal_id: &str) -> Result<RecoveryRecord, String> {
    let profile: serde_json::Value =
        serde_json::from_str(profile_json).map_err(|e| format!("profile.json: {e}"))?;
    let deals = profile.get("deals").and_then(|d| d.as_array()).ok_or("profile.json has no deals array")?;
    let deal = deals
        .iter()
        .find(|d| deal_id_matches(d, deal_id))
        .ok_or_else(|| format!("deal {deal_id} not found in this profile"))?;

    let id_num: u64 = deal_id.parse().map_err(|_| format!("deal id {deal_id} is not a number"))?;
    let network = s(deal, "network").unwrap_or_else(|| "mainnet".into());
    let product = if s(deal, "template").as_deref() == Some("deposit") { Product::Deposit } else { Product::Escrow };
    let role = match s(deal, "role").as_deref() {
        Some("buyer") => Role::Buyer,
        Some("seller") => Role::Seller,
        other => return Err(format!("deal {deal_id}: unknown or missing role {other:?}")),
    };

    let party_sk = s(deal, "sk").ok_or_else(|| format!("deal {deal_id}: no private key in this profile — cannot recover from this device"))?;
    let sk_bytes: [u8; 32] = hex::decode(party_sk.trim())
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| format!("deal {deal_id}: sk is not 32 bytes of hex"))?;
    let party_pk = match s(deal, "pk") {
        Some(pk) => pk,
        None => hex::encode(sk_to_xonly(&sk_bytes).ok_or("sk is not a valid private key")?),
    };

    let cfg = get(deal, "cfg").ok_or_else(|| {
        format!("deal {deal_id}: no contract parameters in this profile — the recovery topology is incomplete; re-export a fresh backup while the service is reachable")
    })?;
    let addresses = Addresses {
        active: s(deal, "escrow_addr").ok_or_else(|| format!("deal {deal_id}: no escrow (ACTIVE) address stored"))?,
        disputed: s(deal, "disputed_addr").ok_or_else(|| format!("deal {deal_id}: no disputed address stored"))?,
    };

    let params = Params {
        buyer_pk: s(cfg, "buyer_pk").ok_or("cfg.buyer_pk missing")?,
        seller_pk: s(cfg, "seller_pk").ok_or("cfg.seller_pk missing")?,
        arbiter_pk: s(cfg, "arbiter_pk").ok_or("cfg.arbiter_pk missing")?,
        dispute_window: n(cfg, "dispute_window").ok_or("cfg.dispute_window missing")?,
        arbiter_deadline: n(cfg, "arbiter_deadline").ok_or("cfg.arbiter_deadline missing")?,
        timeout_to: n(cfg, "timeout_to").ok_or("cfg.timeout_to missing")?,
        fee_pk: s(cfg, "fee_pk").ok_or("cfg.fee_pk missing")?,
        fee_resolve: u(cfg, "fee_resolve").ok_or("cfg.fee_resolve missing")?,
        fee_dispute: u(cfg, "fee_dispute").ok_or("cfg.fee_dispute missing")?,
        // Legacy migration (spec §5.1): the Desk cfg never stored fee_budget; the browser used the
        // default 1_000_000 to build the covenant. verify() below confirms this reproduces the address.
        fee_budget: u(cfg, "fee_budget").unwrap_or(LEGACY_FEE_BUDGET),
    };

    let funding = match (s(deal, "funding_sk"), s(deal, "funding_pk")) {
        (Some(fsk), fpk_opt) => {
            let fsk_bytes: [u8; 32] = hex::decode(fsk.trim())
                .ok()
                .and_then(|b| b.try_into().ok())
                .ok_or("funding_sk is not 32 bytes of hex")?;
            let fpk = match fpk_opt {
                Some(pk) => pk,
                None => hex::encode(sk_to_xonly(&fsk_bytes).ok_or("funding_sk invalid")?),
            };
            let fpk_bytes: [u8; 32] = hex::decode(fpk.trim())
                .ok()
                .and_then(|b| b.try_into().ok())
                .ok_or("funding_pk is not 32 bytes of hex")?;
            let address = pubkey_address(&fpk_bytes, &network)?;
            Some(Funding { sk: fsk, pk: fpk, address })
        }
        _ => None,
    };

    let record = RecoveryRecord {
        schema: SCHEMA.into(),
        schema_version: SCHEMA_VERSION,
        product,
        deal_id: id_num,
        network,
        contract: ContractRef {
            family: "escrow".into(),
            version: 1,
            source_sha256: ESCROW_V1.source_sha256.into(),
            silverscript_revision: BUILD_SILVERSCRIPT_REV.into(),
            rusty_kaspa_tag: ESCROW_V1.rusty_kaspa_tag.into(),
        },
        role,
        party_sk,
        party_pk,
        funding,
        params,
        addresses,
    };

    // Self-check: verify() recomputes the ACTIVE/DISPUTED addresses from the params (with the
    // migrated fee_budget) and compares them to the stored ones. If they differ, either fee_budget
    // was not the default or the cfg is inconsistent — fail rather than emit a broken record.
    record.verify().map_err(|e| format!("extracted record does not verify (recovery topology may be incomplete): {e}"))?;
    Ok(record)
}

/// Write the record to `output` with 0600 permissions and WITHOUT overwriting (spec §5.1).
pub fn write_record(record: &RecoveryRecord, output: &str) -> Result<(), String> {
    let json = record.to_json()?;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(output)
        .map_err(|e| format!("cannot create {output} (it must not already exist): {e}"))?;
    f.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
    f.write_all(b"\n").map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use kaspa_forge_contracts::registry;
    use kaspa_forge_contracts::tx::{p2sh, spk_address};

    // A Desk profile whose single deal is the canonical reference deal, cfg WITHOUT fee_budget.
    fn profile() -> String {
        let p = registry::canonical_reference_params();
        let hx = |b: &[u8; 32]| hex::encode(b);
        let active = spk_address(&p2sh(&p.active_contract().unwrap().script), "mainnet").unwrap();
        let disputed = spk_address(&p2sh(&p.disputed_contract().unwrap().script), "mainnet").unwrap();
        serde_json::json!({
            "deals": [{
                "id": 42,
                "role": "buyer",
                "sk": hex::encode([1u8; 32]),
                "network": "mainnet",
                "escrow_addr": active,
                "disputed_addr": disputed,
                "cfg": {
                    "buyer_pk": hx(&p.buyer_pk), "seller_pk": hx(&p.seller_pk), "arbiter_pk": hx(&p.arbiter_pk),
                    "dispute_window": p.dispute_window, "arbiter_deadline": p.arbiter_deadline, "timeout_to": p.timeout_to,
                    "fee_pk": hx(&p.fee_pk), "fee_resolve": p.fee_resolve, "fee_dispute": p.fee_dispute
                    // note: NO fee_budget — must be migrated
                }
            }]
        }).to_string()
    }

    #[test]
    fn extract_migrates_fee_budget_and_verifies() {
        let r = extract_record(&profile(), "42").unwrap();
        assert_eq!(r.params.fee_budget, LEGACY_FEE_BUDGET);
        assert!(r.verify().is_ok());
        assert_eq!(r.deal_id, 42);
    }

    #[test]
    fn extract_missing_deal_fails() {
        assert!(extract_record(&profile(), "999").is_err());
    }

    #[test]
    fn extract_without_cfg_fails_closed() {
        let mut v: serde_json::Value = serde_json::from_str(&profile()).unwrap();
        v["deals"][0].as_object_mut().unwrap().remove("cfg");
        assert!(extract_record(&v.to_string(), "42").is_err());
    }
}
