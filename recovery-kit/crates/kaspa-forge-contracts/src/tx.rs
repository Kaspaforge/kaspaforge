// Shared transaction-building primitives — the single source of truth for every Kaspa Forge
// covenant tool. These functions are MOVED verbatim from the product WASM crate
// (`kaspa-safe-core`, `src/core.rs`); the WASM crate now re-exports them from here instead of
// keeping its own copy, so the browser and `dealctl` build byte-identical transactions by
// construction (spec §3.1 "one source of transaction logic").
//
// Pure functions: no gRPC, no wasm-bindgen, no hosted-server imports. Universal
// p2pk/p2sh/sigscript/signing/genesis primitives — vault-, board- and chat-specific builders stay
// in the private WASM crate; only what the escrow builders and a covenant CLI need lives here.

use kaspa_addresses::{Address, Prefix, Version};
use kaspa_consensus_core::hashing::covenant_id::covenant_id;
use kaspa_consensus_core::hashing::sighash_type::SIG_HASH_ALL;
use kaspa_consensus_core::sign::sign_input;
use kaspa_consensus_core::subnets::SUBNETWORK_ID_NATIVE;
use kaspa_consensus_core::tx::{
    PopulatedTransaction, ScriptPublicKey, Transaction, TransactionInput, TransactionOutpoint, TransactionOutput,
    UtxoEntry, VerifiableTransaction,
};
use kaspa_hashes::Hash;
use kaspa_txscript::script_builder::ScriptBuilder;
use kaspa_txscript::{extract_script_pub_key_address, pay_to_script_hash_script, EngineFlags};
use silverscript_lang::ast::Expr;
use silverscript_lang::compiler::CompiledContract;

/// Network transition fee default (the `constant FEE` legacy default in escrow.sil / vault.sil).
pub const FEE: u64 = 1_000_000;
/// Base fee for a funding/consolidation transaction (regular P2PK inputs, no covenant script).
pub const FUND_FEE: u64 = 1_000_000;
/// 1 sigop = 100k script units = 10 budget units; 20 = margin for covenant script ops.
pub const COMPUTE_BUDGET: u16 = 20;

pub fn prefix(network: &str) -> Result<Prefix, String> {
    match network {
        "mainnet" => Ok(Prefix::Mainnet),
        "testnet" => Ok(Prefix::Testnet),
        "simnet" => Ok(Prefix::Simnet),
        other => Err(format!("unknown network: {other}")),
    }
}

/// Bare P2PK script: OP_DATA_32 <pk> OP_CHECKSIG (34 bytes).
pub fn p2pk_script(pk: &[u8; 32]) -> Vec<u8> {
    let mut s = Vec::with_capacity(34);
    s.push(0x20);
    s.extend_from_slice(pk);
    s.push(0xac);
    s
}

/// Version-prefixed spk encoding of P2PK (36 bytes) — introspection format and the dest state field.
pub fn p2pk_spk_encoded(pk: &[u8; 32]) -> [u8; 36] {
    let mut s = [0u8; 36];
    s[2..].copy_from_slice(&p2pk_script(pk));
    s
}

pub fn p2sh(script: &[u8]) -> ScriptPublicKey {
    pay_to_script_hash_script(script)
}

pub fn spk_address(spk: &ScriptPublicKey, network: &str) -> Result<String, String> {
    Ok(extract_script_pub_key_address(spk, prefix(network)?).map_err(|e| e.to_string())?.to_string())
}

pub fn pubkey_address(pk: &[u8; 32], network: &str) -> Result<String, String> {
    Ok(Address::new(prefix(network)?, Version::PubKey, pk).to_string())
}

/// x-only pubkey from a private key.
pub fn sk_to_xonly(sk: &[u8; 32]) -> Option<[u8; 32]> {
    let kp = secp256k1::Keypair::from_seckey_slice(secp256k1::SECP256K1, sk).ok()?;
    Some(kp.x_only_public_key().0.serialize())
}

pub fn engine_flags() -> EngineFlags {
    EngineFlags { covenants_enabled: true, ..Default::default() }
}

fn push_redeem(script: &[u8]) -> Vec<u8> {
    ScriptBuilder::with_flags(engine_flags()).add_data(script).expect("push redeem").drain()
}

/// Sigscript for invoking a covenant entrypoint: arguments (+selector) + push(redeem).
pub fn covenant_sigscript(compiled: &CompiledContract<'_>, function: &str, args: Vec<Expr<'_>>) -> Result<Vec<u8>, String> {
    let mut ss = compiled.build_sig_script(function, args).map_err(|e| format!("sigscript {function}: {e}"))?;
    ss.extend_from_slice(&push_redeem(&compiled.script));
    Ok(ss)
}

/// Input signature (65 bytes: schnorr64+type) for the `sig` argument — without the push prefix.
pub fn input_signature(tx: &impl VerifiableTransaction, input_index: usize, privkey: &[u8; 32]) -> Vec<u8> {
    sign_input(tx, input_index, privkey, SIG_HASH_ALL)[1..].to_vec()
}

/// Full sigscript for a P2PK input (push+sig+type) — for the funding key.
pub fn p2pk_sigscript(tx: &impl VerifiableTransaction, input_index: usize, privkey: &[u8; 32]) -> Vec<u8> {
    sign_input(tx, input_index, privkey, SIG_HASH_ALL)
}

pub fn genesis_covenant_id(funding_outpoint: TransactionOutpoint, out_idx: u32, output: &TransactionOutput) -> Hash {
    covenant_id(funding_outpoint, [(out_idx, output)].into_iter())
}

pub struct InputSpec {
    pub outpoint: TransactionOutpoint,
    pub entry: UtxoEntry,
    pub sequence: u64,
}

/// Build a v1 transaction with a given compute budget per input (sigscripts are set after signing).
pub fn build_tx_payload(inputs: &[InputSpec], outputs: Vec<TransactionOutput>, budget: u16, payload: Vec<u8>) -> Transaction {
    Transaction::new(
        1,
        inputs
            .iter()
            .map(|i| TransactionInput::new_with_compute_budget(i.outpoint, vec![], i.sequence, budget))
            .collect(),
        outputs,
        0,
        SUBNETWORK_ID_NATIVE,
        0,
        payload,
    )
}

pub fn build_tx_budget(inputs: &[InputSpec], outputs: Vec<TransactionOutput>, budget: u16) -> Transaction {
    build_tx_payload(inputs, outputs, budget, vec![])
}

/// Build a v1 transaction with the default covenant compute budget.
pub fn build_tx(inputs: &[InputSpec], outputs: Vec<TransactionOutput>) -> Transaction {
    build_tx_budget(inputs, outputs, COMPUTE_BUDGET)
}

pub fn populated<'a>(tx: &'a Transaction, entries: &[UtxoEntry]) -> PopulatedTransaction<'a> {
    PopulatedTransaction::new(tx, entries.to_vec())
}
