//! Versioned contract registry — the fail-closed allowlist of covenant versions a recovery record
//! may reference (spec §4.1, §5.3). A recovery tool must refuse anything not listed here.
//!
//! Two fingerprints are recorded per version:
//!   * `source_sha256` — the SHA-256 of the exact `escrow.sil` source that was compiled;
//!   * a *compiler fingerprint* — the SHA-256 of the compiled ACTIVE and DISPUTED scripts for a
//!     fixed canonical reference contract. If the linked SilverScript codegen ever changes, the
//!     compiler fingerprint changes too, so `assert_compiler_matches` catches a mismatched
//!     toolchain before any address is trusted (review finding #2: "compare the compiler
//!     fingerprint as well as the source fingerprint").
//!
//! `silverscript_revisions` lists every public compiler commit **proven to emit byte-identical
//! bytecode** for this source. `d25bd342…` is the revision recorded in the spec; `26e3b9f9…` is the
//! revision this crate is pinned to and the one compiled into the live product WASM. Both produce
//! the same ACTIVE/DISPUTED scripts (verified in `tests::compiler_fingerprint_is_stable`), so a
//! record pinning either one is accepted.

use sha2::{Digest, Sha256};

use crate::escrow::{EscrowParams, ESCROW_SRC};

/// One supported covenant version.
pub struct ContractVersion {
    /// Contract family. Escrow, Deposit and Marketplace all share the escrow covenant → always "escrow".
    pub family: &'static str,
    pub version: u32,
    /// SHA-256 (lowercase hex) of the exact `escrow.sil` source.
    pub source_sha256: &'static str,
    /// Public SilverScript commits proven to emit identical bytecode for this source.
    pub silverscript_revisions: &'static [&'static str],
    /// Pinned rusty-kaspa tag.
    pub rusty_kaspa_tag: &'static str,
    /// Compiler fingerprint: SHA-256 of the compiled ACTIVE script for the canonical reference deal.
    pub canonical_active_sha256: &'static str,
    /// Compiler fingerprint: SHA-256 of the compiled DISPUTED script for the canonical reference deal.
    pub canonical_disputed_sha256: &'static str,
}

/// escrow.sil v1 — the single covenant behind Escrow, Deposit and Marketplace.
pub const ESCROW_V1: ContractVersion = ContractVersion {
    family: "escrow",
    version: 1,
    source_sha256: "65d4b6bb3c516647b72a873dab1272445c498f8b17bfba19ec15519726dcb4a0",
    silverscript_revisions: &[
        "d25bd3427a093c17327ca3d6b9e1aa5f7688c863",
        "26e3b9f94821b6fe47a2492755252ec4f995abb1",
    ],
    rusty_kaspa_tag: "v2.0.1",
    canonical_active_sha256: "41140bf288bbbda418804bdb79b9f7df27a028c9bafb2994363c008415619e4c",
    canonical_disputed_sha256: "6f62e3044132821516d699cbfe1e6180d0fba87b281f9ce11fd4a03994623b32",
};

/// The whole registry.
pub const REGISTRY: &[&ContractVersion] = &[&ESCROW_V1];

/// The ceiling for a network transition fee budget (escrow.sil `MAX_FEE_BUDGET`, 0.1 KAS). A recovery
/// record's `fee_budget` must satisfy `0 < fee_budget <= MAX_FEE_BUDGET` (spec §5.3 point 7).
pub const MAX_FEE_BUDGET: u64 = 10_000_000;

/// Largest amount that survives a round-trip through a JSON number / browser signing without losing
/// precision (2^53 − 1 is the IEEE-754 safe-integer limit). Every sompi value in a recovery record
/// must be a safe integer (spec §5.3 point 8).
pub const MAX_EXACT_SOMPI: u64 = (1u64 << 53) - 1;

/// Fail-closed lookup by (family, version, source_sha256).
pub fn lookup(family: &str, version: u32, source_sha256: &str) -> Option<&'static ContractVersion> {
    REGISTRY
        .iter()
        .copied()
        .find(|v| v.family == family && v.version == version && v.source_sha256.eq_ignore_ascii_case(source_sha256))
}

/// The canonical reference deal used for the compiler fingerprint. Fixed forever: deterministic
/// x-only keys from seckeys [1;32]…[4;32], the same parameters used to derive the recorded hashes.
pub fn canonical_reference_params() -> EscrowParams {
    let pk = |b: u8| {
        secp256k1::Keypair::from_seckey_slice(secp256k1::SECP256K1, &[b; 32])
            .expect("static seckey is valid")
            .x_only_public_key()
            .0
            .serialize()
    };
    EscrowParams {
        buyer_pk: pk(1),
        seller_pk: pk(2),
        arbiter_pk: pk(3),
        dispute_window: 600,
        arbiter_deadline: 1200,
        timeout_to: 0,
        fee_pk: pk(4),
        fee_resolve: 20_000_000,
        fee_dispute: 500_000_000,
        fee_budget: 1_000_000,
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Compile the canonical reference deal with the LINKED SilverScript and return
/// (active_script_sha256, disputed_script_sha256).
pub fn compiler_fingerprint() -> Result<(String, String), String> {
    let p = canonical_reference_params();
    let active = p.active_contract()?;
    let disputed = p.disputed_contract()?;
    Ok((sha256_hex(&active.script), sha256_hex(&disputed.script)))
}

/// The SHA-256 of the escrow source actually linked into this build.
pub fn linked_source_sha256() -> String {
    sha256_hex(ESCROW_SRC.as_bytes())
}

/// Verify that the linked toolchain reproduces this version's recorded fingerprints. Fail-closed:
/// any mismatch of source hash or compiled bytecode means the tool cannot be trusted to compute
/// addresses, so it must refuse to sign or submit.
pub fn assert_compiler_matches(v: &ContractVersion) -> Result<(), String> {
    let src = linked_source_sha256();
    if !src.eq_ignore_ascii_case(v.source_sha256) {
        return Err(format!(
            "linked escrow.sil source hash {src} does not match registered {} for {} v{}",
            v.source_sha256, v.family, v.version
        ));
    }
    let (active, disputed) = compiler_fingerprint()?;
    if !active.eq_ignore_ascii_case(v.canonical_active_sha256) {
        return Err(format!("compiler fingerprint (ACTIVE) {active} != registered {}", v.canonical_active_sha256));
    }
    if !disputed.eq_ignore_ascii_case(v.canonical_disputed_sha256) {
        return Err(format!("compiler fingerprint (DISPUTED) {disputed} != registered {}", v.canonical_disputed_sha256));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linked_source_matches_registered() {
        assert_eq!(linked_source_sha256(), ESCROW_V1.source_sha256);
    }

    #[test]
    fn compiler_fingerprint_is_stable() {
        // The linked compiler must reproduce the recorded canonical bytecode. This is the byte-parity
        // gate: if silverscript codegen ever drifts, this fails and the version must be re-fingerprinted.
        let (active, disputed) = compiler_fingerprint().unwrap();
        assert_eq!(active, ESCROW_V1.canonical_active_sha256, "ACTIVE script codegen drifted");
        assert_eq!(disputed, ESCROW_V1.canonical_disputed_sha256, "DISPUTED script codegen drifted");
        assert!(assert_compiler_matches(&ESCROW_V1).is_ok());
    }

    #[test]
    fn lookup_is_fail_closed() {
        assert!(lookup("escrow", 1, ESCROW_V1.source_sha256).is_some());
        assert!(lookup("escrow", 2, ESCROW_V1.source_sha256).is_none(), "unknown version rejected");
        assert!(lookup("vault", 1, ESCROW_V1.source_sha256).is_none(), "wrong family rejected");
        assert!(lookup("escrow", 1, "00").is_none(), "wrong source hash rejected");
    }
}
