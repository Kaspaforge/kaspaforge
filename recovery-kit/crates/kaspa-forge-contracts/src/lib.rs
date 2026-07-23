//! kaspa-forge-contracts — the public core of Kaspa Forge.
//!
//! Pure-Rust library: the escrow/deposit covenant transition builders and the low-level tx
//! primitives that both the product WASM crate and the party-side recovery CLI (`dealctl`) build
//! on. No gRPC, no wasm-bindgen, no hosted-server imports — safe to vendor, publish, and audit
//! independently.
//!
//! ## Modules
//! - [`tx`] — shared transaction-building primitives (p2pk, p2sh, signing, tx construction).
//! - [`escrow`] — escrow («Garant») / deposit deal params, compilation, and all transition builders.

pub mod escrow;
pub mod recovery;
pub mod registry;
pub mod tx;
pub mod vectors;
