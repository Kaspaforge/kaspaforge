// Offline vault recovery via a vault JSON record extracted from the encrypted Desk profile —
// against any Kaspa v2+ node (--utxoindex). Legacy RU/EN text sheets remain parser-compatible.
// The commands do not depend on the Kaspa Safe server: the contract checks only keys and time.

use std::io::Read as _;

use age::armor::ArmoredReader;
use age::secrecy::Secret;
use kaspa_addresses::{Address, Prefix, Version};
use kaspa_consensus_core::tx::{
    CovenantBinding, PopulatedTransaction, ScriptPublicKey, TransactionOutpoint, TransactionOutput, UtxoEntry,
};
use kaspa_grpc_client::GrpcClient;
use kaspa_rpc_core::api::rpc::RpcApi;
use kaspa_txscript::extract_script_pub_key_address;
use silverscript_lang::compiler::CompiledContract;

use crate::vault::*;

// vaultctl is a standalone, independently-auditable crate: it deliberately does NOT depend on
// kaspa-safe-core for this ~15-line age helper (DRY trade-off, spec §4). Mirrors
// kaspa-safe/wasm/src/age_crypto.rs (Task 1) — keep the two in sync if the age format changes.
fn is_age_armor(s: &str) -> bool {
    s.trim_start().starts_with("-----BEGIN AGE ENCRYPTED FILE-----")
}

fn decrypt_armored(armored: &str, passphrase: &str) -> Result<Vec<u8>, String> {
    let dec = match age::Decryptor::new(ArmoredReader::new(armored.as_bytes()))
        .map_err(|e| format!("parse: {e}"))?
    {
        age::Decryptor::Passphrase(d) => d,
        _ => return Err("not a passphrase-encrypted age file".into()),
    };
    let mut r = dec
        .decrypt(&Secret::new(passphrase.to_owned()), None)
        .map_err(|_| "wrong passphrase or corrupted file".to_string())?;
    let mut pt = vec![];
    r.read_to_end(&mut pt).map_err(|e| format!("read: {e}"))?;
    Ok(pt)
}

pub const DEFAULT_NODE: &str = "grpc://node.kaspaforge.org:16110"; // OfficeForge public node; ANY v2+ node with --utxoindex will do

const DAA_PER_HOUR: u64 = 36_000; // Kaspa ~10 blocks/s

pub struct Recovery {
    pub network: String,
    pub delay: i64,
    pub inherit_delay: i64,
    pub auto_inherit: i64,
    /// Constructor feeBudget; the sheet line / JSON field is optional → defaults to FEE (1M).
    /// The value is part of the address: require_addr_match will catch a mismatch.
    pub fee_budget: u64,
    pub sheet_vault_addr: Option<String>, // vault_addr from JSON; name kept for legacy parser compatibility
    pub hot_sk: Option<[u8; 32]>,
    pub hot_pk: [u8; 32],
    pub alarm_sk: Option<[u8; 32]>,
    pub alarm_pk: [u8; 32],
    pub heir_pk: [u8; 32],
}

fn die(msg: &str) -> ! {
    eprintln!("error: {msg}");
    std::process::exit(1);
}

fn hex32_str(s: &str, what: &str) -> [u8; 32] {
    match hex::decode(s.trim()).ok().and_then(|v| <[u8; 32]>::try_from(v).ok()) {
        Some(a) => a,
        None => die(&format!("{what}: expected 64 hex characters, got «{s}»")),
    }
}

fn pk_from_sk(sk: &[u8; 32]) -> [u8; 32] {
    use secp256k1::{Keypair, Secp256k1, SecretKey};
    let kp = Keypair::from_secret_key(&Secp256k1::new(), &SecretKey::from_slice(sk).expect("bad secret key"));
    kp.x_only_public_key().0.serialize()
}

fn first_int(s: &str) -> Option<i64> {
    let digits: String = s.chars().skip_while(|c| !c.is_ascii_digit()).take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

impl Recovery {
    pub fn load(path: &str) -> Recovery {
        let raw = std::fs::read_to_string(path).unwrap_or_else(|e| die(&format!("cannot read {path}: {e}")));
        let raw = if is_age_armor(&raw) {
            let pw = rpassword::prompt_password("Passphrase for encrypted sheet: ")
                .unwrap_or_else(|e| die(&format!("passphrase read: {e}")));
            String::from_utf8(decrypt_armored(&raw, &pw).unwrap_or_else(|e| die(&e)))
                .unwrap_or_else(|_| die("decrypted sheet is not UTF-8"))
        } else {
            raw
        };
        if raw.trim_start().starts_with('{') {
            Self::from_json(&raw)
        } else {
            Self::from_sheet(&raw)
        }
    }

    fn from_json(raw: &str) -> Recovery {
        let v: serde_json::Value = serde_json::from_str(raw).unwrap_or_else(|e| die(&format!("JSON: {e}")));
        // string fields: absence→None, but PRESENCE of a non-string→die (otherwise "vault_addr":123
        // would silently disable require_addr_match, "network":5 → silently mainnet)
        let s = |k: &str| -> Option<String> {
            match &v[k] {
                serde_json::Value::Null => None,
                serde_json::Value::String(x) => { let t = x.trim().to_string(); (!t.is_empty()).then_some(t) }
                _ => die(&format!("JSON: {k} must be a string")),
            }
        };
        let hot_sk = s("hot_sk").map(|x| hex32_str(&x, "hot_sk"));
        let alarm_sk = s("alarm_sk").map(|x| hex32_str(&x, "alarm_sk"));
        let hot_pk = s("hot_pk").map(|x| hex32_str(&x, "hot_pk")).or(hot_sk.as_ref().map(pk_from_sk));
        let alarm_pk = s("alarm_pk").map(|x| hex32_str(&x, "alarm_pk")).or(alarm_sk.as_ref().map(pk_from_sk));
        // strict typing: field is PRESENT but of the wrong type → die, not a silent default
        // (otherwise "auto_inherit":"true" or "inherit_delay":"259200" would silently yield a different address)
        let int_field = |k: &str, default: i64| -> i64 {
            match &v[k] {
                serde_json::Value::Null => default,
                serde_json::Value::Number(n) => n.as_i64().unwrap_or_else(|| die(&format!("JSON: {k} is not an integer"))),
                _ => die(&format!("JSON: {k} must be a number (DAA), not a string/boolean")),
            }
        };
        let bool_field = |k: &str| -> i64 {
            match &v[k] {
                serde_json::Value::Null => 0,
                serde_json::Value::Bool(b) => *b as i64,
                _ => die(&format!("JSON: {k} must be true/false, not a string/number")),
            }
        };
        let fee_budget = int_field("fee_budget", FEE as i64);
        if !(1_000_000..=10_000_000).contains(&fee_budget) {
            die("JSON: fee_budget must be in [1_000_000, 10_000_000] sompi");
        }
        Recovery {
            network: s("network").unwrap_or_else(|| "mainnet".into()),
            delay: match &v["delay"] { serde_json::Value::Number(n) => n.as_i64().unwrap_or_else(|| die("JSON: delay is not an integer")), _ => die("JSON: delay is required (a DAA number)") },
            inherit_delay: int_field("inherit_delay", 0),
            auto_inherit: bool_field("auto_inherit"),
            fee_budget: fee_budget as u64,
            sheet_vault_addr: s("vault_addr"),
            hot_sk,
            hot_pk: hot_pk.unwrap_or_else(|| die("JSON: hot_pk or hot_sk is required")),
            alarm_sk,
            alarm_pk: alarm_pk.unwrap_or_else(|| die("JSON: alarm_pk or alarm_sk is required")),
            heir_pk: s("heir_pk").map(|x| hex32_str(&x, "heir_pk")).unwrap_or(ZERO_HEIR),
        }
    }

    /// Parser for the wizard's recovery sheet (RU and EN). Format: «Key: value» per line.
    fn from_sheet(raw: &str) -> Recovery {
        let mut network = "mainnet".to_string();
        let (mut delay, mut inherit_delay, mut auto_inherit) = (None::<i64>, 0i64, 0i64);
        let mut fee_budget = FEE; // optional in the sheet; absent → default 1M
        let (mut vault_addr, mut hot_sk, mut hot_pk, mut alarm_sk, mut alarm_pk, mut heir_pk) =
            (None, None, None::<[u8; 32]>, None, None::<[u8; 32]>, ZERO_HEIR);
        for line in raw.lines() {
            let Some((k, val)) = line.split_once(':') else { continue };
            let (k, val) = (k.trim(), val.trim());
            // NOTE: sheet field labels below are matched in both RU and EN — the wizard emits
            // either language, so the Russian keys MUST stay for RU recovery sheets to parse.
            match k {
                "Сеть" | "Network" => network = val.to_string(),
                "Задержка вывода" | "Withdrawal delay" => delay = first_int(val),
                "Наследование" | "Inheritance" => {
                    if !(val.starts_with("выключено") || val.starts_with("disabled")) {
                        inherit_delay = first_int(val).unwrap_or(0);
                        let low = val.to_lowercase();
                        auto_inherit = if low.contains("авто") || low.contains("automatic") { 1 } else { 0 };
                    }
                }
                // split_once cuts on the FIRST ':', so val = «kaspa:qq…» in full
                "Адрес сейфа" | "Vault address" => vault_addr = Some(val.to_string()),
                "Горячий ключ" | "Hot key" => hot_sk = Some(hex32_str(val, "hot key")),
                "Горячий pubkey" | "Hot pubkey" => hot_pk = Some(hex32_str(val, "hot pubkey")),
                "Тревожный ключ" | "Alarm key" => alarm_sk = Some(hex32_str(val, "alarm key")),
                "Тревожный pubkey" | "Alarm pubkey" => alarm_pk = Some(hex32_str(val, "alarm pubkey")),
                "Pubkey наследника" | "Heir pubkey" => heir_pk = hex32_str(val, "heir pubkey"),
                "Бюджет комиссии" | "Fee budget" => fee_budget = first_int(val).map(|n| n as u64).unwrap_or(FEE),
                _ => {}
            }
        }
        let vault_addr = vault_addr.filter(|v| !v.is_empty());
        let hot_pk = hot_pk.or(hot_sk.as_ref().map(pk_from_sk)).unwrap_or_else(|| die("the sheet has no hot pubkey/key"));
        let alarm_pk = alarm_pk.or(alarm_sk.as_ref().map(pk_from_sk)).unwrap_or_else(|| die("the sheet has no alarm pubkey/key"));
        Recovery {
            network,
            delay: delay.unwrap_or_else(|| die("the sheet is missing the \"Withdrawal delay\" line")),
            inherit_delay,
            auto_inherit,
            fee_budget,
            sheet_vault_addr: vault_addr,
            hot_sk,
            hot_pk,
            alarm_sk,
            alarm_pk,
            heir_pk,
        }
    }

    pub fn prefix(&self) -> Prefix {
        match self.network.as_str() {
            "mainnet" => Prefix::Mainnet,
            "testnet" | "testnet-10" | "testnet-11" => Prefix::Testnet,
            "simnet" => Prefix::Simnet,
            "devnet" => Prefix::Devnet,
            other => die(&format!("unknown network «{other}»")),
        }
    }

    pub fn vault_contract(&self) -> CompiledContract<'static> {
        compile_vault(&self.hot_pk, &self.alarm_pk, self.delay, &self.heir_pk, self.inherit_delay, self.auto_inherit, MODE_VAULT, &ZERO_DEST, self.fee_budget as i64)
    }

    pub fn unvault_contract(&self, dest_pk: &[u8; 32]) -> CompiledContract<'static> {
        compile_vault(
            &self.hot_pk, &self.alarm_pk, self.delay, &self.heir_pk, self.inherit_delay, self.auto_inherit,
            MODE_UNVAULTING, &p2pk_spk_encoded(dest_pk), self.fee_budget as i64,
        )
    }

    pub fn addr(&self, spk: &ScriptPublicKey) -> Address {
        extract_script_pub_key_address(spk, self.prefix()).expect("address from spk")
    }

    /// Before any mutating command: the computed vault address must match the one printed
    /// on the sheet, otherwise the parameters diverged — die with a diagnosis, not «UTXO not found».
    pub fn require_addr_match(&self) {
        if let Some(sheet) = &self.sheet_vault_addr {
            let computed = self.addr(&p2sh(&self.vault_contract().script)).to_string();
            if &computed != sheet {
                // fee_budget is part of the address; sheets predating 2026-07-11 had no "Fee budget" line,
                // so the parser silently took the 1M default — if the vault used a different budget, the address won't match.
                // Spell this out as an explicit cause so the user does not have to guess (audit 2026-07-11).
                let fee_hint = if self.fee_budget == FEE {
                    "\nNOTE: fee budget = 1_000_000 sompi (the default assumed when the sheet has no \"Fee budget\" line — sheets predate 11.07.2026). If the vault was created with a non-default budget, add `Fee budget: <N> sompi` (or `fee_budget` in JSON)."
                } else { "" };
                die(&format!(
                    "the address from the parameters did not match vault_addr in the recovery record:\n  computed:  {computed}\n  in record: {sheet}\ncommon causes: wrong inheritance mode (auto/manual), a different term, a different network, a wrong/missing fee budget, OR the vault was created under an older contract version (this vaultctl carries the current one).{fee_hint}\nRun `status` to diagnose; for a no-heir vault use auto_inherit:false."
                ));
            }
        }
    }
}

/// kaspa:q…-address -> x-only pubkey (or 64 hex chars of the pubkey directly).
pub fn dest_pubkey(arg: &str) -> [u8; 32] {
    if arg.len() == 64 && arg.chars().all(|c| c.is_ascii_hexdigit()) {
        let pk = hex32_str(arg, "pubkey");
        // critical: dest is fixed in the contract FOREVER. If it's not a curve point (user pasted
        // a txid instead of a pubkey — both are 64 hex), P2PK(pk) is unspendable → complete will BURN the funds.
        // We check the validity of the x-only point; ~half of random 32-byte values fail it.
        if secp256k1::XOnlyPublicKey::from_slice(&pk).is_err() {
            die("--to: the 64 hex are not a valid pubkey (a curve point). Looks like NOT a pubkey was pasted (e.g. a txid). Prefer a normal kaspa:q… address — it has a checksum.");
        }
        return pk;
    }
    let a: Address = match arg.try_into() {
        Ok(a) => a,
        Err(e) => die(&format!("neither an address nor a pubkey: {arg} ({e:?})")),
    };
    if a.version != Version::PubKey {
        die("a normal schnorr address is required (kaspa:q…), not P2SH/ECDSA");
    }
    a.payload.as_slice().try_into().unwrap()
}

fn kas(sompi: u64) -> String {
    format!("{:.4} KAS", sompi as f64 / 100_000_000.0)
}

fn daa_human(daa: u64) -> String {
    let h = daa / DAA_PER_HOUR;
    if h >= 48 { format!("~{} d", h / 24) } else if h >= 1 { format!("~{h} h") } else { format!("~{} min", daa / 600) }
}

async fn covenant_utxo(c: &GrpcClient, addr: Address) -> Option<(TransactionOutpoint, UtxoEntry)> {
    let list = c.get_utxos_by_addresses(vec![addr]).await.unwrap_or_else(|e| die(&format!("node: {e}")));
    list.into_iter()
        .filter(|e| e.utxo_entry.covenant_id.is_some())
        .max_by_key(|e| e.utxo_entry.amount)
        .map(|e| (TransactionOutpoint::from(e.outpoint), UtxoEntry::from(e.utxo_entry)))
}

async fn virtual_daa(c: &GrpcClient) -> u64 {
    c.get_block_dag_info().await.unwrap_or_else(|e| die(&format!("node: {e}"))).virtual_daa_score
}

async fn submit_or_dry(c: &GrpcClient, tx: &kaspa_consensus_core::tx::Transaction, dry: bool, action: &str) {
    if dry {
        println!("[dry-run] {action}: transaction built and signed, txid {} — NOT broadcast", tx.id());
        return;
    }
    let rpc_tx: kaspa_rpc_core::RpcTransaction = tx.into();
    match c.submit_transaction(rpc_tx, false).await {
        Ok(txid) => println!("{action}: accepted, txid {txid}"),
        Err(e) => die(&format!("{action}: the node rejected the transaction: {e}")),
    }
}

fn need(sk: &Option<[u8; 32]>, what: &str) -> [u8; 32] {
    sk.unwrap_or_else(|| die(&format!("this action needs {what} in vault.json (or a separate alarm card where applicable)")))
}

/// Generic single-input transition covenant-UTXO -> output out (the binding preserves covenant_id).
fn spend_tx(
    prev: &(TransactionOutpoint, UtxoEntry),
    sequence: u64,
    output: TransactionOutput,
) -> (kaspa_consensus_core::tx::Transaction, Vec<UtxoEntry>) {
    let spec = SpendSpec { prev_outpoint: prev.0, prev_entry: prev.1.clone(), sequence, output };
    (build_spend_tx(&spec), vec![prev.1.clone()])
}

pub async fn status(c: &GrpcClient, r: &Recovery, dest: Option<&str>) {
    let vdaa = virtual_daa(c).await;
    let vault_c = r.vault_contract();
    let vaddr = r.addr(&p2sh(&vault_c.script));
    println!("network: {} · virtual DAA {vdaa}", r.network);
    println!("vault address (computed): {vaddr}");
    if let Some(sheet) = &r.sheet_vault_addr {
        if sheet != &vaddr.to_string() {
            println!("⚠ address did NOT match vault_addr in the recovery record ({sheet}).");
            println!("  Common causes: wrong inheritance mode (auto/manual), a different term, a different network.");
        } else {
            println!("✓ matches vault_addr in the recovery record");
        }
    }
    match covenant_utxo(c, vaddr.clone()).await {
        Some((op, e)) => {
            let age = vdaa.saturating_sub(e.block_daa_score);
            println!("IN VAULT: {} (utxo {}:{}), age {age} DAA ({})", kas(e.amount), op.transaction_id, op.index, daa_human(age));
            if r.inherit_delay > 0 {
                let left = (r.inherit_delay as u64).saturating_sub(age);
                let mode = if r.auto_inherit == 1 { "auto" } else { "manual" };
                if left == 0 {
                    println!("inheritance ({mode}): term EXPIRED — the vault is open to the heir ({}). A check-in is still possible.", daa_human(r.inherit_delay as u64));
                } else {
                    println!("inheritance ({mode}): {left} DAA until it opens to the heir ({})", daa_human(left));
                }
            }
        }
        None => {
            println!("VAULT EMPTY. Possible causes: a withdrawal started (see below), completed, or the vault was never funded.");
            if dest.is_none() {
                println!("hint: if a withdrawal is in progress — rerun with --dest <destination address> to see the cancel window");
            }
        }
    }
    if let Some(d) = dest {
        let dpk = dest_pubkey(d);
        let uaddr = r.addr(&p2sh(&r.unvault_contract(&dpk).script));
        println!("unvault address for this destination: {uaddr}");
        match covenant_utxo(c, uaddr).await {
            Some((_, e)) => {
                let age = vdaa.saturating_sub(e.block_daa_score);
                let left = (r.delay as u64).saturating_sub(age);
                if left > 0 {
                    println!("WITHDRAWAL IN PROGRESS: {} · cancel window open for another {left} DAA ({}) — cancel will make it", kas(e.amount), daa_human(left));
                } else {
                    println!("WITHDRAWAL MATURED: {} · window closed, complete will deliver to the destination", kas(e.amount));
                }
            }
            None => println!("unvault address is empty (no withdrawal to this destination, or already completed)"),
        }
    }
}

pub async fn initiate(c: &GrpcClient, r: &Recovery, to: &str, dry: bool) {
    r.require_addr_match();
    let hot_sk = need(&r.hot_sk, "hot key");
    let dpk = dest_pubkey(to);
    let vault_c = r.vault_contract();
    let prev = covenant_utxo(c, r.addr(&p2sh(&vault_c.script))).await.unwrap_or_else(|| die("vault UTXO not found (vault empty?)"));
    let cov_id = prev.1.covenant_id.unwrap();
    let unvault_c = r.unvault_contract(&dpk);
    let out = TransactionOutput::with_covenant(
        prev.1.amount - r.fee_budget,
        p2sh(&unvault_c.script),
        Some(CovenantBinding { authorizing_input: 0, covenant_id: cov_id }),
    );
    let (mut tx, entries) = spend_tx(&prev, 0, out);
    let sig = input_signature(&PopulatedTransaction::new(&tx, entries), 0, &hot_sk);
    tx.inputs[0].signature_script = covenant_sigscript(&vault_c, "initiate", vec![sig.into(), dpk.to_vec().into()]);
    tx.finalize();
    println!("cancel window: {} DAA ({})", r.delay, daa_human(r.delay as u64));
    submit_or_dry(c, &tx, dry, "withdrawal initiated").await;
}

pub async fn cancel(c: &GrpcClient, r: &Recovery, dest: &str, dry: bool) {
    r.require_addr_match();
    let alarm_sk = need(&r.alarm_sk, "alarm key");
    let dpk = dest_pubkey(dest);
    let unvault_c = r.unvault_contract(&dpk);
    let vault_c = r.vault_contract();
    let prev = covenant_utxo(c, r.addr(&p2sh(&unvault_c.script)))
        .await
        .unwrap_or_else(|| die("no active withdrawal to this destination (check --dest; see status)"));
    let cov_id = prev.1.covenant_id.unwrap();
    let out = TransactionOutput::with_covenant(
        prev.1.amount - r.fee_budget,
        p2sh(&vault_c.script),
        Some(CovenantBinding { authorizing_input: 0, covenant_id: cov_id }),
    );
    let (mut tx, entries) = spend_tx(&prev, 0, out);
    let sig = input_signature(&PopulatedTransaction::new(&tx, entries), 0, &alarm_sk);
    tx.inputs[0].signature_script = covenant_sigscript(&unvault_c, "cancel", vec![sig.into()]);
    tx.finalize();
    submit_or_dry(c, &tx, dry, "CANCEL (funds return to the vault)").await;
}

pub async fn complete(c: &GrpcClient, r: &Recovery, dest: &str, dry: bool) {
    r.require_addr_match();
    let dpk = dest_pubkey(dest);
    let unvault_c = r.unvault_contract(&dpk);
    let prev = covenant_utxo(c, r.addr(&p2sh(&unvault_c.script)))
        .await
        .unwrap_or_else(|| die("no active withdrawal to this destination (check --dest)"));
    let vdaa = virtual_daa(c).await;
    let age = vdaa.saturating_sub(prev.1.block_daa_score);
    if age < r.delay as u64 {
        die(&format!("cancel window still open: {age} of {} DAA elapsed — complete will be accepted later", r.delay));
    }
    let out = TransactionOutput::new(prev.1.amount - r.fee_budget, ScriptPublicKey::new(0, p2pk_script(&dpk).into()));
    let (mut tx, _entries) = spend_tx(&prev, r.delay as u64, out);
    tx.inputs[0].signature_script = covenant_sigscript(&unvault_c, "complete", vec![]);
    tx.finalize();
    submit_or_dry(c, &tx, dry, "withdrawal completed (funds at the destination)").await;
}

pub async fn checkin(c: &GrpcClient, r: &Recovery, dry: bool) {
    r.require_addr_match();
    let hot_sk = need(&r.hot_sk, "hot key");
    let vault_c = r.vault_contract();
    let prev = covenant_utxo(c, r.addr(&p2sh(&vault_c.script))).await.unwrap_or_else(|| die("vault UTXO not found"));
    let cov_id = prev.1.covenant_id.unwrap();
    let out = TransactionOutput::with_covenant(
        prev.1.amount - r.fee_budget,
        p2sh(&vault_c.script),
        Some(CovenantBinding { authorizing_input: 0, covenant_id: cov_id }),
    );
    let (mut tx, entries) = spend_tx(&prev, 0, out);
    let sig = input_signature(&PopulatedTransaction::new(&tx, entries), 0, &hot_sk);
    tx.inputs[0].signature_script = covenant_sigscript(&vault_c, "checkin", vec![sig.into()]);
    tx.finalize();
    submit_or_dry(c, &tx, dry, "check-in (\"I'm alive\", inheritance timer reset)").await;
}

/// Migrate: both signatures (hot+alarm) = full owner authority by definition — the whole UTXO
/// moves to `to` INSTANTLY, from either mode (vault-version upgrade, rotation of a compromised
/// hot key, exit). The contract does not constrain the outputs; the network fee here reuses
/// r.fee_budget (migrate itself is not fee-capped on-chain — the owner signs the whole tx).
/// --dest <addr> = the UTXO sits on the unvault address (a mid-withdrawal rescue).
pub async fn migrate(c: &GrpcClient, r: &Recovery, to: &str, dest: Option<&str>, dry: bool) {
    r.require_addr_match();
    let hot_sk = need(&r.hot_sk, "hot key");
    let alarm_sk = need(&r.alarm_sk, "alarm key");
    let to_pk = dest_pubkey(to);
    let (contract, from) = match dest {
        Some(d) => (r.unvault_contract(&dest_pubkey(d)), "UNVAULTING (mid-withdrawal rescue)"),
        None => (r.vault_contract(), "VAULT"),
    };
    let prev = covenant_utxo(c, r.addr(&p2sh(&contract.script))).await.unwrap_or_else(|| {
        die(if dest.is_some() {
            "no withdrawal-in-progress UTXO on the unvault address (check --dest; see status)"
        } else {
            "vault UTXO not found (vault empty? withdrawal in progress? then add --dest <its destination address>)"
        })
    });
    let out = TransactionOutput::new(prev.1.amount - r.fee_budget, ScriptPublicKey::new(0, p2pk_script(&to_pk).into()));
    let spec = SpendSpec { prev_outpoint: prev.0, prev_entry: prev.1.clone(), sequence: 0, output: out };
    let mut tx = build_spend_tx_budget(&spec, MIGRATE_BUDGET);
    let entries = vec![prev.1.clone()];
    let s_hot = input_signature(&PopulatedTransaction::new(&tx, entries.clone()), 0, &hot_sk);
    let s_alarm = input_signature(&PopulatedTransaction::new(&tx, entries), 0, &alarm_sk);
    tx.inputs[0].signature_script = covenant_sigscript(&contract, "migrate", vec![s_hot.into(), s_alarm.into()]);
    tx.finalize();
    println!("MIGRATE from {from}: both keys = full owner authority, no delay");
    submit_or_dry(c, &tx, dry, "migrate (funds moved instantly)").await;
}

pub async fn inherit(c: &GrpcClient, r: &Recovery, heir_sk: Option<&str>, dry: bool) {
    r.require_addr_match();
    if r.inherit_delay <= 0 || r.heir_pk == ZERO_HEIR {
        die("inheritance is disabled for this vault");
    }
    let vault_c = r.vault_contract();
    let prev = covenant_utxo(c, r.addr(&p2sh(&vault_c.script))).await.unwrap_or_else(|| die("vault UTXO not found (already claimed?)"));
    let vdaa = virtual_daa(c).await;
    let age = vdaa.saturating_sub(prev.1.block_daa_score);
    if age < r.inherit_delay as u64 {
        let left = r.inherit_delay as u64 - age;
        die(&format!("inheritance term not expired yet: {left} DAA left ({})", daa_human(left)));
    }
    let out = TransactionOutput::new(prev.1.amount - r.fee_budget, ScriptPublicKey::new(0, p2pk_script(&r.heir_pk).into()));
    let (mut tx, entries) = spend_tx(&prev, r.inherit_delay as u64, out);
    if r.auto_inherit == 1 {
        tx.inputs[0].signature_script = covenant_sigscript(&vault_c, "inheritAuto", vec![]);
    } else {
        let sk_hex = heir_sk.unwrap_or_else(|| die("manual mode: --heir-sk <heir's private key, hex> is required"));
        let sk = hex32_str(sk_hex, "--heir-sk");
        if pk_from_sk(&sk) != r.heir_pk {
            die("--heir-sk does not match heir_pk in vault.json");
        }
        let sig = input_signature(&PopulatedTransaction::new(&tx, entries), 0, &sk);
        tx.inputs[0].signature_script = covenant_sigscript(&vault_c, "inheritSigned", vec![sig.into()]);
    }
    tx.finalize();
    submit_or_dry(c, &tx, dry, "inheritance delivered to the heir").await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_age_armor() {
        assert!(is_age_armor("-----BEGIN AGE ENCRYPTED FILE-----\nx"));
        assert!(!is_age_armor("Vault address: kaspa:q...\nHot key: ab..."));
    }

    #[test]
    fn current_desk_json_derives_the_production_v3_address() {
        // Same public vector as desk/src/features/safes/vault-cfg.parity.test.ts. If vaultctl's
        // contract arguments/source drift from the shipped browser WASM, this address changes.
        let json = r#"{
          "network":"mainnet",
          "vault_addr":"kaspa:prn46scxqnuzynmz2xg93nv4d5wlkmpac8tqvnwgqcfyg936e464q8asuyfkw",
          "hot_pk":"7c69e9ea9b643b25f62727c9f261ba05b45f74963bfc81f9d3fe6c33f8656d49",
          "alarm_pk":"5b0d2e0c4d02721a73e55eb17ce57a595005304f6e33f02389395a935921b31a",
          "delay":864000,
          "heir_pk":"35b09c8b0ac8dc04a7cb8244907f5b50fd892f80d0128c84ff106a79541d843a",
          "inherit_delay":25920000,
          "auto_inherit":false,
          "fee_budget":1000000
        }"#;
        let r = Recovery::from_json(json);
        let derived = r.addr(&p2sh(&r.vault_contract().script)).to_string();
        assert_eq!(derived, r.sheet_vault_addr.unwrap());
    }
}
