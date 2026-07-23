//! The minimal party-side recovery record (spec §5) and its fail-closed offline verifier.
//!
//! A recovery record is the *only* thing a party needs to independently rebuild and sign every
//! covenant path their key authorizes, without any Kaspa Forge server. It carries the party's own
//! signing key and the public constructor parameters — and NOTHING else (no seed/master, service
//! token, chat key, arbiter key, or operator metadata). Every struct uses `deny_unknown_fields`, so
//! a record can never smuggle a hosted/secret field into a public export (review finding #7).
//!
//! `verify` is offline and fail-closed (spec §5.3): it recomputes the party pubkey, the funding
//! address, and the ACTIVE/DISPUTED covenant addresses locally and refuses on ANY mismatch, unknown
//! version, malformed key, out-of-range fee budget, or unsafe integer.

use serde::{Deserialize, Serialize};

use crate::escrow::EscrowParams;
use crate::registry::{self, ContractVersion, MAX_EXACT_SOMPI, MAX_FEE_BUDGET};
use crate::tx::{prefix, pubkey_address, spk_address, p2sh};

pub const SCHEMA: &str = "kaspa-forge-deal-recovery";
pub const SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Product {
    Escrow,
    Deposit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Buyer,
    Seller,
}

impl Role {
    /// Human label for the given product: Deposit inverts buyer/seller into holder/depositor (spec §0).
    pub fn product_label(&self, product: Product) -> &'static str {
        match (product, self) {
            (Product::Escrow, Role::Buyer) => "buyer",
            (Product::Escrow, Role::Seller) => "seller",
            (Product::Deposit, Role::Buyer) => "holder",
            (Product::Deposit, Role::Seller) => "depositor",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContractRef {
    pub family: String,
    pub version: u32,
    pub source_sha256: String,
    pub silverscript_revision: String,
    pub rusty_kaspa_tag: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Funding {
    pub sk: String,
    pub pk: String,
    pub address: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Params {
    pub buyer_pk: String,
    pub seller_pk: String,
    pub arbiter_pk: String,
    pub dispute_window: i64,
    pub arbiter_deadline: i64,
    pub timeout_to: i64,
    pub fee_pk: String,
    pub fee_resolve: u64,
    pub fee_dispute: u64,
    pub fee_budget: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Addresses {
    pub active: String,
    pub disputed: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecoveryRecord {
    pub schema: String,
    pub schema_version: u32,
    pub product: Product,
    pub deal_id: u64,
    pub network: String,
    pub contract: ContractRef,
    pub role: Role,
    pub party_sk: String,
    pub party_pk: String,
    #[serde(default)]
    pub funding: Option<Funding>,
    pub params: Params,
    pub addresses: Addresses,
}

/// A fully validated record: every field parsed, every invariant checked. Money commands operate on
/// this, never on raw JSON.
pub struct Verified {
    pub product: Product,
    pub role: Role,
    pub network: String,
    pub deal_id: u64,
    pub params: EscrowParams,
    pub party_sk: [u8; 32],
    pub party_pk: [u8; 32],
    pub funding: Option<VerifiedFunding>,
    pub active_addr: String,
    pub disputed_addr: String,
    pub version: &'static ContractVersion,
}

pub struct VerifiedFunding {
    pub sk: [u8; 32],
    pub pk: [u8; 32],
    pub address: String,
}

/// Strictly parse a fixed-length lowercase-hex field into 32 bytes. Rejects wrong length, uppercase,
/// and non-hex WITHOUT ever indexing the untrusted string (review finding #6: no panic on short hex).
fn hex32(field: &str, s: &str) -> Result<[u8; 32], String> {
    if s.len() != 64 {
        return Err(format!("{field}: expected 64 hex chars, got {}", s.len()));
    }
    if !s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err(format!("{field}: must be lowercase hex [0-9a-f]"));
    }
    let v = hex::decode(s).map_err(|e| format!("{field}: {e}"))?;
    v.try_into().map_err(|_| format!("{field}: not 32 bytes"))
}

/// x-only pubkey derived from a private key, or fail-closed if the key is out of range.
fn sk_to_pk(field: &str, sk: &[u8; 32]) -> Result<[u8; 32], String> {
    let kp = secp256k1::Keypair::from_seckey_slice(secp256k1::SECP256K1, sk)
        .map_err(|_| format!("{field}: not a valid secp256k1 private key"))?;
    Ok(kp.x_only_public_key().0.serialize())
}

fn check_sompi(field: &str, v: u64) -> Result<(), String> {
    if v > MAX_EXACT_SOMPI {
        return Err(format!("{field}: {v} exceeds the JSON-safe integer limit"));
    }
    Ok(())
}

impl RecoveryRecord {
    pub fn from_json(s: &str) -> Result<Self, String> {
        serde_json::from_str(s).map_err(|e| format!("recovery record JSON: {e}"))
    }

    pub fn to_json(&self) -> Result<String, String> {
        serde_json::to_string_pretty(self).map_err(|e| e.to_string())
    }

    /// Fail-closed offline verification (spec §5.3). Returns a fully typed `Verified` or an error.
    pub fn verify(&self) -> Result<Verified, String> {
        // 1. schema / version
        if self.schema != SCHEMA {
            return Err(format!("unknown schema {:?}", self.schema));
        }
        if self.schema_version != SCHEMA_VERSION {
            return Err(format!("unsupported schema_version {}", self.schema_version));
        }
        // 2. network
        prefix(&self.network)?; // rejects unknown networks

        // 3. registry: known contract family/version/source + accepted compiler + rusty-kaspa tag.
        //    Escrow, Deposit and Marketplace all ride the escrow covenant → family must be "escrow".
        if self.contract.family != "escrow" {
            return Err(format!("unknown contract family {:?} (only 'escrow' is supported)", self.contract.family));
        }
        let version = registry::lookup(&self.contract.family, self.contract.version, &self.contract.source_sha256)
            .ok_or_else(|| format!(
                "unknown contract fingerprint: {} v{} source {}",
                self.contract.family, self.contract.version, self.contract.source_sha256
            ))?;
        if !version.silverscript_revisions.iter().any(|r| r.eq_ignore_ascii_case(&self.contract.silverscript_revision)) {
            return Err(format!("unsupported silverscript revision {}", self.contract.silverscript_revision));
        }
        if !version.rusty_kaspa_tag.eq_ignore_ascii_case(&self.contract.rusty_kaspa_tag) {
            return Err(format!("unsupported rusty-kaspa tag {}", self.contract.rusty_kaspa_tag));
        }
        // 4. the LINKED toolchain reproduces this version's fingerprints, so recomputed addresses are trustworthy.
        registry::assert_compiler_matches(version)?;

        // 5. fee_budget range + safe integers (spec §5.3 points 7, 8).
        if !(0 < self.params.fee_budget && self.params.fee_budget <= MAX_FEE_BUDGET) {
            return Err(format!("fee_budget {} out of range (0, {}]", self.params.fee_budget, MAX_FEE_BUDGET));
        }
        check_sompi("fee_resolve", self.params.fee_resolve)?;
        check_sompi("fee_dispute", self.params.fee_dispute)?;
        check_sompi("fee_budget", self.params.fee_budget)?;
        if self.params.dispute_window < 0 || self.params.arbiter_deadline < 0 {
            return Err("dispute_window / arbiter_deadline must be non-negative DAA".into());
        }
        if self.params.timeout_to != 0 && self.params.timeout_to != 1 {
            return Err(format!("timeout_to must be 0 (buyer) or 1 (seller), got {}", self.params.timeout_to));
        }

        // 6. keys
        let buyer_pk = hex32("params.buyer_pk", &self.params.buyer_pk)?;
        let seller_pk = hex32("params.seller_pk", &self.params.seller_pk)?;
        let arbiter_pk = hex32("params.arbiter_pk", &self.params.arbiter_pk)?;
        let fee_pk = hex32("params.fee_pk", &self.params.fee_pk)?;
        let party_sk = hex32("party_sk", &self.party_sk)?;
        let party_pk = hex32("party_pk", &self.party_pk)?;

        // party_sk -> party_pk, and party_pk == pk for the claimed role (spec §5.3 points 3, 4).
        let derived = sk_to_pk("party_sk", &party_sk)?;
        if derived != party_pk {
            return Err("party_sk does not derive party_pk".into());
        }
        let role_pk = match self.role {
            Role::Buyer => buyer_pk,
            Role::Seller => seller_pk,
        };
        if party_pk != role_pk {
            return Err("party_pk does not match the params key for this role".into());
        }

        // 7. rebuild the covenant params and recompute ACTIVE/DISPUTED addresses locally (spec §5.3 point 5).
        let params = EscrowParams {
            buyer_pk,
            seller_pk,
            arbiter_pk,
            dispute_window: self.params.dispute_window,
            arbiter_deadline: self.params.arbiter_deadline,
            timeout_to: self.params.timeout_to,
            fee_pk,
            fee_resolve: self.params.fee_resolve,
            fee_dispute: self.params.fee_dispute,
            fee_budget: self.params.fee_budget,
        };
        let active_addr = spk_address(&p2sh(&params.active_contract()?.script), &self.network)?;
        let disputed_addr = spk_address(&p2sh(&params.disputed_contract()?.script), &self.network)?;
        if active_addr != self.addresses.active {
            return Err(format!("ACTIVE address mismatch: recomputed {active_addr} != recorded {}", self.addresses.active));
        }
        if disputed_addr != self.addresses.disputed {
            return Err(format!("DISPUTED address mismatch: recomputed {disputed_addr} != recorded {}", self.addresses.disputed));
        }

        // 8. optional funding key (spec §5.3 point 6).
        let funding = match &self.funding {
            None => None,
            Some(f) => {
                let sk = hex32("funding.sk", &f.sk)?;
                let pk = hex32("funding.pk", &f.pk)?;
                if sk_to_pk("funding.sk", &sk)? != pk {
                    return Err("funding.sk does not derive funding.pk".into());
                }
                let address = pubkey_address(&pk, &self.network)?;
                if address != f.address {
                    return Err(format!("funding address mismatch: recomputed {address} != recorded {}", f.address));
                }
                Some(VerifiedFunding { sk, pk, address })
            }
        };

        Ok(Verified {
            product: self.product,
            role: self.role,
            network: self.network.clone(),
            deal_id: self.deal_id,
            params,
            party_sk,
            party_pk,
            funding,
            active_addr,
            disputed_addr,
            version,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A complete, self-consistent record built from the canonical reference deal, so verify() passes.
    fn good_record() -> RecoveryRecord {
        let p = registry::canonical_reference_params();
        let hx = |b: &[u8; 32]| hex::encode(b);
        let network = "mainnet";
        let active = spk_address(&p2sh(&p.active_contract().unwrap().script), network).unwrap();
        let disputed = spk_address(&p2sh(&p.disputed_contract().unwrap().script), network).unwrap();
        // buyer is seckey [1;32]; the buyer is the recovering party.
        let party_sk = [1u8; 32];
        RecoveryRecord {
            schema: SCHEMA.into(),
            schema_version: SCHEMA_VERSION,
            product: Product::Escrow,
            deal_id: 123,
            network: network.into(),
            contract: ContractRef {
                family: "escrow".into(),
                version: 1,
                source_sha256: registry::ESCROW_V1.source_sha256.into(),
                silverscript_revision: "d25bd3427a093c17327ca3d6b9e1aa5f7688c863".into(),
                rusty_kaspa_tag: "v2.0.1".into(),
            },
            role: Role::Buyer,
            party_sk: hex::encode(party_sk),
            party_pk: hx(&p.buyer_pk),
            funding: None,
            params: Params {
                buyer_pk: hx(&p.buyer_pk),
                seller_pk: hx(&p.seller_pk),
                arbiter_pk: hx(&p.arbiter_pk),
                dispute_window: p.dispute_window,
                arbiter_deadline: p.arbiter_deadline,
                timeout_to: p.timeout_to,
                fee_pk: hx(&p.fee_pk),
                fee_resolve: p.fee_resolve,
                fee_dispute: p.fee_dispute,
                fee_budget: p.fee_budget,
            },
            addresses: Addresses { active, disputed },
        }
    }

    #[test]
    fn good_record_verifies() {
        let v = good_record().verify().expect("canonical record must verify");
        assert_eq!(v.role, Role::Buyer);
        assert_eq!(v.deal_id, 123);
    }

    #[test]
    fn json_round_trip_is_lossless() {
        let r = good_record();
        let j = r.to_json().unwrap();
        let back = RecoveryRecord::from_json(&j).unwrap();
        assert!(back.verify().is_ok());
    }

    #[test]
    fn unknown_field_rejected() {
        let mut j: serde_json::Value = serde_json::from_str(&good_record().to_json().unwrap()).unwrap();
        j["service_token"] = serde_json::json!("leak");
        let err = RecoveryRecord::from_json(&j.to_string()).unwrap_err();
        assert!(err.contains("service_token") || err.contains("unknown field"), "deny_unknown_fields: {err}");
    }

    #[test]
    fn short_hex_does_not_panic_and_fails_closed() {
        let mut r = good_record();
        r.params.buyer_pk = "00".into();
        let err = match r.verify() { Ok(_) => panic!("expected error"), Err(e) => e };
        assert!(err.contains("64 hex"), "must fail closed on short hex, got: {err}");
    }

    #[test]
    fn uppercase_hex_rejected() {
        let mut r = good_record();
        r.party_pk = r.party_pk.to_uppercase();
        assert!(r.verify().is_err(), "uppercase hex must be rejected");
    }

    #[test]
    fn wrong_party_key_rejected() {
        let mut r = good_record();
        r.party_sk = hex::encode([9u8; 32]); // not the buyer key
        let err = match r.verify() { Ok(_) => panic!("expected error"), Err(e) => e };
        assert!(err.contains("party_sk does not derive") || err.contains("does not match"), "{err}");
    }

    #[test]
    fn wrong_role_rejected() {
        let mut r = good_record();
        r.role = Role::Seller; // party_sk is the buyer key
        assert!(r.verify().is_err(), "party key must match the claimed role");
    }

    #[test]
    fn tampered_address_rejected() {
        let mut r = good_record();
        r.addresses.active = "kaspa:qqefghijklmnopqrstuvwxyz0123456789abcdefghij".into();
        assert!(r.verify().is_err(), "recomputed ACTIVE address must gate the recorded one");
    }

    #[test]
    fn fee_budget_out_of_range_rejected() {
        let mut r = good_record();
        r.params.fee_budget = MAX_FEE_BUDGET + 1;
        assert!(r.verify().is_err());
        let mut r0 = good_record();
        r0.params.fee_budget = 0;
        assert!(r0.verify().is_err());
    }

    #[test]
    fn unknown_source_hash_rejected() {
        let mut r = good_record();
        r.contract.source_sha256 = "00".repeat(32);
        assert!(r.verify().is_err(), "unknown contract source must fail closed");
    }

    #[test]
    fn deposit_role_labels() {
        assert_eq!(Role::Buyer.product_label(Product::Deposit), "holder");
        assert_eq!(Role::Seller.product_label(Product::Deposit), "depositor");
        assert_eq!(Role::Buyer.product_label(Product::Escrow), "buyer");
    }
}
