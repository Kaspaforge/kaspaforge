// On-chain vault operations against the simnet node (spike Tasks 5-7).

use std::fs;

use kaspa_addresses::{Address, Prefix};
use kaspa_consensus_core::subnets::SUBNETWORK_ID_NATIVE;
use kaspa_consensus_core::tx::{
    CovenantBinding, PopulatedTransaction, ScriptPublicKey, Transaction, TransactionInput, TransactionOutpoint, TransactionOutput,
    UtxoEntry,
};
use kaspa_grpc_client::GrpcClient;
use kaspa_hashes::Hash;
use kaspa_rpc_core::api::rpc::RpcApi;
use kaspa_txscript::extract_script_pub_key_address;
use kaspa_txscript::pay_to_address_script;

use crate::vault::*;

const WALLET_FEE: u64 = 3_000_000; // sompi, funding-transaction fee

fn state_path() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join(".keys/vault-state.json")
}

fn save_state(v: &serde_json::Value) {
    fs::write(state_path(), serde_json::to_string_pretty(v).unwrap()).unwrap();
}

fn load_state() -> serde_json::Value {
    serde_json::from_str(&fs::read_to_string(state_path()).expect("no vault-state.json — run vaultctl create first")).unwrap()
}

fn hex32(v: &serde_json::Value, k: &str) -> [u8; 32] {
    hex::decode(v[k].as_str().unwrap()).unwrap().try_into().unwrap()
}

/// Mature UTXOs of the address (100+ confirmations for coinbase), sorted by descending amount.
async fn spendable_utxos(c: &GrpcClient, addr: Address) -> Vec<(TransactionOutpoint, UtxoEntry)> {
    let virtual_daa = c.get_block_dag_info().await.unwrap().virtual_daa_score;
    let resp = c.get_utxos_by_addresses(vec![addr]).await.expect("get_utxos_by_addresses");
    let mut utxos: Vec<(TransactionOutpoint, UtxoEntry)> = resp
        .into_iter()
        .filter(|e| {
            let need = if e.utxo_entry.is_coinbase { 1010 } else { 10 };
            e.utxo_entry.block_daa_score + need <= virtual_daa
        })
        .map(|e| (TransactionOutpoint::from(e.outpoint), UtxoEntry::from(e.utxo_entry)))
        .collect();
    utxos.sort_by_key(|(_, e)| std::cmp::Reverse(e.amount));
    utxos
}

async fn submit(c: &GrpcClient, tx: &Transaction) -> String {
    let rpc_tx: kaspa_rpc_core::RpcTransaction = tx.into();
    let txid = c.submit_transaction(rpc_tx, false).await.expect("submit_transaction");
    txid.to_string()
}

fn spk_address(spk: &ScriptPublicKey) -> Address {
    extract_script_pub_key_address(spk, Prefix::Simnet).expect("address from spk")
}

fn keypair_parts(keys: &serde_json::Value, role: &str) -> ([u8; 32], [u8; 32]) {
    use secp256k1::{Keypair, Secp256k1, SecretKey};
    let sk_hex = keys[role].as_str().unwrap();
    let sk_bytes: [u8; 32] = hex::decode(sk_hex).unwrap().try_into().unwrap();
    let kp = Keypair::from_secret_key(&Secp256k1::new(), &SecretKey::from_slice(&sk_bytes).unwrap());
    (sk_bytes, kp.x_only_public_key().0.serialize())
}

/// Task 5: create the vault — funding tx v1 with a genesis covenant binding.
pub async fn create(c: &GrpcClient, keys: &serde_json::Value, amount_kas: u64, delay: i64) {
    let (mine_sk, _) = keypair_parts(keys, "mine");
    let (_, hot_pk) = keypair_parts(keys, "hot");
    let (_, alarm_pk) = keypair_parts(keys, "alarm");
    let mine_addr = crate::role_address(keys, "mine");

    let amount = amount_kas * 100_000_000;
    let utxos = spendable_utxos(c, mine_addr.clone()).await;
    let (outpoint, entry) = utxos.into_iter().find(|(_, e)| e.amount > amount + WALLET_FEE).expect("no mature UTXO of the required size");

    let vault_c = compile_vault(&hot_pk, &alarm_pk, delay, &ZERO_HEIR, 0, 0, MODE_VAULT, &ZERO_DEST, FEE as i64);
    let vault_spk = p2sh(&vault_c.script);
    let vault_addr = spk_address(&vault_spk);

    // vault output (binding is added after computing the genesis id — the binding itself is not part of the hash)
    let mut vault_out = TransactionOutput::new(amount, vault_spk.clone());
    let cov_id = genesis_covenant_id(outpoint, 0, &vault_out);
    vault_out.covenant = Some(CovenantBinding { authorizing_input: 0, covenant_id: cov_id });

    let change = TransactionOutput::new(entry.amount - amount - WALLET_FEE, pay_to_address_script(&mine_addr));

    let mut tx = Transaction::new(
        1,
        vec![TransactionInput::new_with_compute_budget(outpoint, vec![], 0, COMPUTE_BUDGET)],
        vec![vault_out, change],
        0,
        SUBNETWORK_ID_NATIVE,
        0,
        vec![],
    );
    // P2PK wallet input: sigscript = push(sig65) in full, as sign_input returns it
    let entries = vec![entry.clone()];
    let full_sig = kaspa_consensus_core::sign::sign_input(
        &PopulatedTransaction::new(&tx, entries.clone()),
        0,
        &mine_sk,
        kaspa_consensus_core::hashing::sighash_type::SIG_HASH_ALL,
    );
    tx.inputs[0].signature_script = full_sig;
    tx.finalize();

    let txid = submit(c, &tx).await;
    save_state(&serde_json::json!({
        "delay": delay,
        "cov_id": cov_id.to_string(),
        "vault_addr": vault_addr.to_string(),
        "create_txid": txid,
    }));
    println!("vault created: txid {txid}");
    println!("covenant_id: {cov_id}");
    println!("vault address: {vault_addr} ({amount_kas} KAS, delay {delay} DAA)");
    println!("mine a block or two (vaultctl mine 2) and check: vaultctl vault-status");
}

fn parse_cov_id(st: &serde_json::Value) -> Hash {
    st["cov_id"].as_str().unwrap().parse().unwrap()
}

/// Find the covenant UTXO by its P2SH address.
async fn covenant_utxo(c: &GrpcClient, spk: &ScriptPublicKey) -> Option<(TransactionOutpoint, UtxoEntry)> {
    let resp = c.get_utxos_by_addresses(vec![spk_address(spk)]).await.expect("get_utxos_by_addresses");
    resp.into_iter().map(|e| (TransactionOutpoint::from(e.outpoint), UtxoEntry::from(e.utxo_entry))).next()
}

struct Ctx {
    vault_c: silverscript_lang::compiler::CompiledContract<'static>,
    unvault_c: Option<silverscript_lang::compiler::CompiledContract<'static>>,
    cov_id: Hash,
    delay: i64,
}

fn build_ctx(keys: &serde_json::Value, st: &serde_json::Value) -> Ctx {
    let (_, hot_pk) = keypair_parts(keys, "hot");
    let (_, alarm_pk) = keypair_parts(keys, "alarm");
    let delay = st["delay"].as_i64().unwrap();
    let vault_c = compile_vault(&hot_pk, &alarm_pk, delay, &ZERO_HEIR, 0, 0, MODE_VAULT, &ZERO_DEST, FEE as i64);
    let unvault_c = st["dest_pk"].as_str().map(|d| {
        let dest_pk: [u8; 32] = hex::decode(d).unwrap().try_into().unwrap();
        compile_vault(&hot_pk, &alarm_pk, delay, &ZERO_HEIR, 0, 0, MODE_UNVAULTING, &p2pk_spk_encoded(&dest_pk), FEE as i64)
    });
    Ctx { vault_c, unvault_c, cov_id: parse_cov_id(st), delay }
}

/// Task 6: initiate a withdrawal (hot) — VAULT -> UNVAULTING.
pub async fn initiate(c: &GrpcClient, keys: &serde_json::Value) {
    let mut st = load_state();
    let (hot_sk, hot_pk) = keypair_parts(keys, "hot");
    let (_, alarm_pk) = keypair_parts(keys, "alarm");
    let (_, dest_pk) = keypair_parts(keys, "dest");
    let ctx = build_ctx(keys, &st);

    let (outpoint, entry) = covenant_utxo(c, &p2sh(&ctx.vault_c.script)).await.expect("vault UTXO not found (mode=VAULT)");
    let unvault_c = compile_vault(&hot_pk, &alarm_pk, ctx.delay, &ZERO_HEIR, 0, 0, MODE_UNVAULTING, &p2pk_spk_encoded(&dest_pk), FEE as i64);

    let spec = SpendSpec {
        prev_outpoint: outpoint,
        prev_entry: entry.clone(),
        sequence: 0,
        output: TransactionOutput::with_covenant(
            entry.amount - FEE,
            p2sh(&unvault_c.script),
            Some(CovenantBinding { authorizing_input: 0, covenant_id: ctx.cov_id }),
        ),
    };
    let mut tx = build_spend_tx(&spec);
    let entries = vec![entry];
    let sig = input_signature(&PopulatedTransaction::new(&tx, entries.clone()), 0, &hot_sk);
    tx.inputs[0].signature_script = covenant_sigscript(&ctx.vault_c, "initiate", vec![sig.into(), dest_pk.to_vec().into()]);
    tx.finalize();

    let txid = submit(c, &tx).await;
    st["dest_pk"] = serde_json::json!(hex::encode(dest_pk));
    st["initiate_txid"] = serde_json::json!(txid);
    save_state(&st);
    println!("withdrawal initiated: txid {txid}");
    println!("UNVAULTING address: {}", spk_address(&p2sh(&unvault_c.script)));
    println!("cancel window: {} DAA blocks", ctx.delay);
}

/// Task 6: cancel with the alarm key — UNVAULTING -> VAULT.
pub async fn cancel(c: &GrpcClient, keys: &serde_json::Value) {
    let st = load_state();
    let (alarm_sk, _) = keypair_parts(keys, "alarm");
    let ctx = build_ctx(keys, &st);
    let unvault_c = ctx.unvault_c.as_ref().expect("no dest_pk in state — withdrawal not initiated");

    let (outpoint, entry) = covenant_utxo(c, &p2sh(&unvault_c.script)).await.expect("UNVAULTING UTXO not found");
    let spec = SpendSpec {
        prev_outpoint: outpoint,
        prev_entry: entry.clone(),
        sequence: 0,
        output: TransactionOutput::with_covenant(
            entry.amount - FEE,
            p2sh(&ctx.vault_c.script),
            Some(CovenantBinding { authorizing_input: 0, covenant_id: ctx.cov_id }),
        ),
    };
    let mut tx = build_spend_tx(&spec);
    let entries = vec![entry];
    let sig = input_signature(&PopulatedTransaction::new(&tx, entries.clone()), 0, &alarm_sk);
    tx.inputs[0].signature_script = covenant_sigscript(unvault_c, "cancel", vec![sig.into()]);
    tx.finalize();

    let txid = submit(c, &tx).await;
    println!("CANCEL succeeded: txid {txid} — funds back in the vault {}", spk_address(&p2sh(&ctx.vault_c.script)));
}

/// Task 7: complete the withdrawal after the timelock — UNVAULTING -> dest.
pub async fn complete(c: &GrpcClient, keys: &serde_json::Value) {
    let st = load_state();
    let ctx = build_ctx(keys, &st);
    let unvault_c = ctx.unvault_c.as_ref().expect("no dest_pk in state — withdrawal not initiated");
    let dest_pk: [u8; 32] = hex::decode(st["dest_pk"].as_str().unwrap()).unwrap().try_into().unwrap();

    let (outpoint, entry) = covenant_utxo(c, &p2sh(&unvault_c.script)).await.expect("UNVAULTING UTXO not found");
    let spec = SpendSpec {
        prev_outpoint: outpoint,
        prev_entry: entry.clone(),
        sequence: ctx.delay as u64,
        output: TransactionOutput::new(entry.amount - FEE, ScriptPublicKey::new(0, p2pk_script(&dest_pk).into())),
    };
    let mut tx = build_spend_tx(&spec);
    tx.inputs[0].signature_script = covenant_sigscript(unvault_c, "complete", vec![]);
    tx.finalize();

    let txid = submit(c, &tx).await;
    println!("withdrawal COMPLETED: txid {txid} — funds at dest {}", crate::role_address(keys, "dest"));
}

/// Path 6 migrate (dev, simnet): both keys = instant full authority. `vaultctl migrate` =
/// direct-genesis into a NEW vault in ONE tx (delay+60 as an upgrade analog: new script =>
/// new address; the open spec question — may a covenant input authorize a genesis of another
/// covenant — is answered by the node accepting this). `vaultctl migrate exit` = plain P2PK
/// exit to the dest role. Node-level proof for the migrate spec.
pub async fn migrate(c: &GrpcClient, keys: &serde_json::Value, exit: bool) {
    let mut st = load_state();
    let (hot_sk, hot_pk) = keypair_parts(keys, "hot");
    let (alarm_sk, alarm_pk) = keypair_parts(keys, "alarm");
    let ctx = build_ctx(keys, &st);
    // migrate works from both modes; the dev command takes the VAULT-UTXO (mode 0)
    let (outpoint, entry) = covenant_utxo(c, &p2sh(&ctx.vault_c.script)).await.expect("vault UTXO not found (mode=VAULT)");

    let (output, new_state) = if exit {
        let (_, dest_pk) = keypair_parts(keys, "dest");
        (TransactionOutput::new(entry.amount - FEE, ScriptPublicKey::new(0, p2pk_script(&dest_pk).into())), None)
    } else {
        let new_delay = ctx.delay + 60;
        let new_c = compile_vault(&hot_pk, &alarm_pk, new_delay, &ZERO_HEIR, 0, 0, MODE_VAULT, &ZERO_DEST, FEE as i64);
        let new_spk = p2sh(&new_c.script);
        // as in create: the genesis id is computed over the output WITHOUT the binding
        let plain = TransactionOutput::new(entry.amount - FEE, new_spk.clone());
        let cov_id = genesis_covenant_id(outpoint, 0, &plain);
        (
            TransactionOutput::with_covenant(plain.value, new_spk.clone(), Some(CovenantBinding { authorizing_input: 0, covenant_id: cov_id })),
            Some((new_delay, cov_id, spk_address(&new_spk))),
        )
    };

    let spec = SpendSpec { prev_outpoint: outpoint, prev_entry: entry.clone(), sequence: 0, output };
    let mut tx = build_spend_tx_budget(&spec, MIGRATE_BUDGET);
    let entries = vec![entry];
    let s_hot = input_signature(&PopulatedTransaction::new(&tx, entries.clone()), 0, &hot_sk);
    let s_alarm = input_signature(&PopulatedTransaction::new(&tx, entries), 0, &alarm_sk);
    tx.inputs[0].signature_script = covenant_sigscript(&ctx.vault_c, "migrate", vec![s_hot.into(), s_alarm.into()]);
    tx.finalize();
    let txid = submit(c, &tx).await;
    match new_state {
        Some((new_delay, cov_id, addr)) => {
            st["delay"] = serde_json::json!(new_delay);
            st["cov_id"] = serde_json::json!(cov_id.to_string());
            st["vault_addr"] = serde_json::json!(addr.to_string());
            st.as_object_mut().unwrap().remove("dest_pk");
            save_state(&st);
            println!("MIGRATE -> NEW vault in one tx (genesis from a covenant input): txid {txid}");
            println!("new vault: {addr} (delay {new_delay}), covenant_id {cov_id}");
            println!("mine a block (vaultctl mine 2) and check: vaultctl vault-status");
        }
        None => println!("MIGRATE exit -> dest ({}): txid {txid}", crate::role_address(keys, "dest")),
    }
}

/// Status: vault / unvaulting / dest balances + covenant_id of the live UTXO.
pub async fn vault_status(c: &GrpcClient, keys: &serde_json::Value) {
    let st = load_state();
    let ctx = build_ctx(keys, &st);
    let virtual_daa = c.get_block_dag_info().await.unwrap().virtual_daa_score;
    println!("virtual DAA: {virtual_daa} · delay {} · covenant_id {}", ctx.delay, ctx.cov_id);

    let show = |label: &str, spk: &ScriptPublicKey, found: &Option<(TransactionOutpoint, UtxoEntry)>| match found {
        Some((op, e)) => {
            let age = virtual_daa.saturating_sub(e.block_daa_score);
            println!(
                "{label}: {} KAS @ {} (utxo {}:{}, age {age} DAA, covenant_id {})",
                e.amount as f64 / 100_000_000.0,
                spk_address(spk),
                op.transaction_id,
                op.index,
                e.covenant_id.map(|h| h.to_string()).unwrap_or("-".into())
            );
        }
        None => println!("{label}: empty ({})", spk_address(spk)),
    };

    let vspk = p2sh(&ctx.vault_c.script);
    show("VAULT     ", &vspk, &covenant_utxo(c, &vspk).await);
    if let Some(uc) = &ctx.unvault_c {
        let uspk = p2sh(&uc.script);
        show("UNVAULTING", &uspk, &covenant_utxo(c, &uspk).await);
    }
    let dest_addr = crate::role_address(keys, "dest");
    let dest_total: u64 =
        c.get_utxos_by_addresses(vec![dest_addr.clone()]).await.unwrap().iter().map(|u| u.utxo_entry.amount).sum();
    println!("DEST      : {} KAS @ {dest_addr}", dest_total as f64 / 100_000_000.0);
}

/// E2E utility: a plain transfer from the mine wallet to an address (e.g. the wizard's funding address).
pub async fn send(c: &GrpcClient, keys: &serde_json::Value, to_addr: &str, amount_kas: u64) {
    let (mine_sk, _) = keypair_parts(keys, "mine");
    let mine_addr = crate::role_address(keys, "mine");
    let amount = amount_kas * 100_000_000;
    let utxos = spendable_utxos(c, mine_addr.clone()).await;
    let (outpoint, entry) =
        utxos.into_iter().find(|(_, e)| e.amount > amount + WALLET_FEE).expect("no mature UTXO of the required size");
    let to: Address = to_addr.try_into().expect("address");
    let out = TransactionOutput::new(amount, pay_to_address_script(&to));
    let change = TransactionOutput::new(entry.amount - amount - WALLET_FEE, pay_to_address_script(&mine_addr));
    let mut tx = Transaction::new(
        1,
        vec![TransactionInput::new_with_compute_budget(outpoint, vec![], 0, COMPUTE_BUDGET)],
        vec![out, change],
        0,
        SUBNETWORK_ID_NATIVE,
        0,
        vec![],
    );
    let entries = vec![entry.clone()];
    tx.inputs[0].signature_script = kaspa_consensus_core::sign::sign_input(
        &PopulatedTransaction::new(&tx, entries.clone()),
        0,
        &mine_sk,
        kaspa_consensus_core::hashing::sighash_type::SIG_HASH_ALL,
    );
    tx.finalize();
    let txid = submit(c, &tx).await;
    println!("sent {amount_kas} KAS to {to_addr}: txid {txid}");
}
