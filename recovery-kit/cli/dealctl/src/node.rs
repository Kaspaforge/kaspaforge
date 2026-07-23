//! Direct gRPC access to a user-selected Kaspa node (spec §9). The RPC response is treated as
//! UNTRUSTED input: it can make a command fail or stall, but it can never change where money goes —
//! every address and script is computed locally from the recovery file, and every built transaction
//! is re-verified locally before it is signed or broadcast. Node errors are sanitized before display.

use kaspa_addresses::Address;
use kaspa_consensus_core::tx::{Transaction, TransactionOutpoint};
use kaspa_forge_contracts::escrow::EscrowSpend;
use kaspa_grpc_client::GrpcClient;
use kaspa_rpc_core::api::rpc::RpcApi;

/// Default node endpoint — always loopback. A remote node must be named explicitly with `--node`.
pub const DEFAULT_NODE: &str = "grpc://127.0.0.1:16110";

/// One covenant UTXO of the deal, tagged with the mode of the address it was found at.
pub struct CovenantLine {
    pub mode: u8, // 0 = ACTIVE address, 1 = DISPUTED address
    pub spend: EscrowSpend,
}

/// A plain (non-covenant) UTXO: either a funding-key P2PK output, or a stray payment sitting on a
/// covenant address that the single-input covenant flow cannot touch.
pub struct PlainUtxo {
    pub outpoint: TransactionOutpoint,
    pub amount: u64,
    pub daa: u64,
    pub coinbase: bool,
}

pub async fn connect(node: &str) -> Result<GrpcClient, String> {
    GrpcClient::connect(node.to_string())
        .await
        .map_err(|e| format!("cannot connect to node {node}: {}", sanitize(&e.to_string())))
}

pub async fn virtual_daa(c: &GrpcClient) -> Result<u64, String> {
    Ok(c.get_block_dag_info().await.map_err(|e| san("get_block_dag_info", &e.to_string()))?.virtual_daa_score)
}

fn addr(a: &str) -> Result<Address, String> {
    a.try_into().map_err(|e| format!("bad address {a}: {e:?}"))
}

/// Every covenant UTXO at the ACTIVE and DISPUTED addresses, tagged with mode, plus any stray plain
/// UTXO found at those addresses (unsupported by the single-input covenant flow).
pub async fn covenant_lines(
    c: &GrpcClient,
    active_addr: &str,
    disputed_addr: &str,
) -> Result<(Vec<CovenantLine>, Vec<PlainUtxo>), String> {
    let mut lines = Vec::new();
    let mut stray = Vec::new();
    for (mode, a) in [(0u8, active_addr), (1u8, disputed_addr)] {
        let list = c
            .get_utxos_by_addresses(vec![addr(a)?])
            .await
            .map_err(|e| san("get_utxos_by_addresses", &e.to_string()))?;
        if list.len() > MAX_UTXOS {
            return Err(format!("node returned {} UTXOs at one address (> {MAX_UTXOS}) — refusing", list.len()));
        }
        for e in list {
            match e.utxo_entry.covenant_id {
                Some(cov_id) => lines.push(CovenantLine {
                    mode,
                    spend: EscrowSpend {
                        prev_outpoint: TransactionOutpoint::from(e.outpoint),
                        prev_amount: e.utxo_entry.amount,
                        prev_daa: e.utxo_entry.block_daa_score,
                        cov_id,
                    },
                }),
                None => stray.push(PlainUtxo {
                    outpoint: TransactionOutpoint::from(e.outpoint),
                    amount: e.utxo_entry.amount,
                    daa: e.utxo_entry.block_daa_score,
                    coinbase: e.utxo_entry.is_coinbase,
                }),
            }
        }
    }
    Ok((lines, stray))
}

/// Plain P2PK UTXOs at a funding address (covenant_id must be absent).
pub async fn plain_utxos(c: &GrpcClient, address: &str) -> Result<Vec<PlainUtxo>, String> {
    let list = c
        .get_utxos_by_addresses(vec![addr(address)?])
        .await
        .map_err(|e| san("get_utxos_by_addresses", &e.to_string()))?;
    if list.len() > MAX_UTXOS {
        return Err(format!("node returned {} UTXOs at the funding address (> {MAX_UTXOS}) — refusing", list.len()));
    }
    Ok(list
        .into_iter()
        .filter(|e| e.utxo_entry.covenant_id.is_none())
        .map(|e| PlainUtxo {
            outpoint: TransactionOutpoint::from(e.outpoint),
            amount: e.utxo_entry.amount,
            daa: e.utxo_entry.block_daa_score,
            coinbase: e.utxo_entry.is_coinbase,
        })
        .collect())
}

pub async fn submit(c: &GrpcClient, tx: &Transaction) -> Result<String, String> {
    let rpc_tx: kaspa_rpc_core::RpcTransaction = tx.into();
    let txid = c
        .submit_transaction(rpc_tx, false)
        .await
        .map_err(|e| san("submit_transaction", &e.to_string()))?;
    Ok(txid.to_string())
}

/// Canonical `txid:index` rendering of an outpoint — the exact format `--outpoint` and every stored
/// package use, so a value copied from `status` parses back with `parse_outpoint`.
pub fn fmt_outpoint(op: &TransactionOutpoint) -> String {
    format!("{}:{}", op.transaction_id, op.index)
}

/// Parse a `txid:index` outpoint selector.
pub fn parse_outpoint(s: &str) -> Result<TransactionOutpoint, String> {
    let (txid, idx) = s.rsplit_once(':').ok_or("outpoint must be txid:index")?;
    let id: kaspa_consensus_core::tx::TransactionId =
        txid.parse().map_err(|_| format!("bad txid {txid} in outpoint"))?;
    let index: u32 = idx.parse().map_err(|_| format!("bad index {idx} in outpoint"))?;
    Ok(TransactionOutpoint::new(id, index))
}

fn san(op: &str, e: &str) -> String {
    format!("node {op} failed: {}", sanitize(e))
}

/// Keep node-provided error text short and free of anything that might echo private material.
/// Truncates by CHARACTER (never inside a multi-byte UTF-8 sequence — a poisoned node error must not
/// panic the CLI).
fn sanitize(e: &str) -> String {
    let one: String = e.chars().map(|c| if c == '\n' || c == '\r' { ' ' } else { c }).collect();
    if one.chars().count() > 200 {
        let head: String = one.chars().take(200).collect();
        format!("{head}…")
    } else {
        one
    }
}

/// Cap on the number of UTXOs accepted at a single address, to bound memory and reject absurd
/// poisoned responses. (Value summation with overflow checking lives in `txbuild::checked_utxo_total`.)
pub const MAX_UTXOS: usize = 100_000;
