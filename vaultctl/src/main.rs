// vaultctl — Kaspa Safe utility.
//
// RECOVERY (primary purpose): offline access to the vault via the recovery sheet,
// against any Kaspa v2+ node with --utxoindex. No Kaspa Safe server required.
// Commands: status | initiate | cancel | complete | checkin | inherit (see USAGE below).
// --recovery accepts the recovery sheet as-is (RU/EN .txt from the wizard) or JSON.
//
// DEV MODE (spike, simnet 127.0.0.1:16510): keygen | mine | balance | create | send |
// vault-status | selftest; initiate/cancel/complete WITHOUT --recovery work off .keys/keys.json.

mod multi_utxo;
mod ops;
mod recovery;
mod vault;

use std::fs;
use std::path::PathBuf;

use kaspa_addresses::{Address, Prefix, Version};
use kaspa_grpc_client::GrpcClient;
use kaspa_rpc_core::api::rpc::RpcApi;
use secp256k1::{Keypair, Secp256k1, SecretKey};

const RPC_URL: &str = "grpc://127.0.0.1:16510";
const ROLES: [&str; 4] = ["mine", "hot", "alarm", "dest"];

fn keys_path() -> PathBuf {
    // .keys/ sits next to vaultctl (spike/.keys — in .gitignore)
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join(".keys/keys.json")
}

fn load_keys() -> serde_json::Value {
    serde_json::from_str(&fs::read_to_string(keys_path()).expect("no .keys/keys.json — run vaultctl keygen first")).unwrap()
}

fn role_keypair(keys: &serde_json::Value, role: &str) -> Keypair {
    let sk_hex = keys[role].as_str().unwrap_or_else(|| panic!("role {role} not found in keys.json"));
    let sk = SecretKey::from_slice(&hex::decode(sk_hex).unwrap()).unwrap();
    Keypair::from_secret_key(&Secp256k1::new(), &sk)
}

pub fn role_address(keys: &serde_json::Value, role: &str) -> Address {
    let kp = role_keypair(keys, role);
    let (xonly, _) = kp.x_only_public_key();
    Address::new(Prefix::Simnet, Version::PubKey, &xonly.serialize())
}

fn cmd_keygen() {
    let path = keys_path();
    if path.exists() {
        eprintln!("{} already exists — not overwriting", path.display());
        std::process::exit(1);
    }
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path.parent().unwrap(), fs::Permissions::from_mode(0o700)).unwrap();
    }
    let secp = Secp256k1::new();
    let mut obj = serde_json::Map::new();
    for role in ROLES {
        let (sk, _) = secp.generate_keypair(&mut rand::thread_rng());
        obj.insert(role.to_string(), serde_json::Value::String(hex::encode(sk.secret_bytes())));
    }
    let keys = serde_json::Value::Object(obj);
    fs::write(&path, serde_json::to_string_pretty(&keys).unwrap()).unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    for role in ROLES {
        println!("{role}: {}", role_address(&keys, role));
    }
    println!("keys in {}", path.display());
}

async fn client() -> GrpcClient {
    GrpcClient::connect(RPC_URL.to_string()).await.expect("no connection to the simnet node (is kaspad --simnet running?)")
}

async fn cmd_mine(n: u64) {
    let keys = load_keys();
    let pay = role_address(&keys, "mine");
    let c = client().await;
    for i in 0..n {
        let template = c.get_block_template(pay.clone(), vec![]).await.expect("get_block_template");
        let resp = c.submit_block(template.block, false).await.expect("submit_block");
        if !matches!(resp.report, kaspa_rpc_core::SubmitBlockReport::Success) {
            panic!("block rejected: {:?}", resp.report);
        }
        if (i + 1) % 100 == 0 || i + 1 == n {
            println!("mined {}/{n}", i + 1);
        }
    }
    let info = c.get_block_dag_info().await.unwrap();
    println!("virtual DAA score: {}", info.virtual_daa_score);
}

async fn cmd_balance(role: &str) {
    let keys = load_keys();
    let addr = role_address(&keys, role);
    let c = client().await;
    let utxos = c.get_utxos_by_addresses(vec![addr.clone()]).await.expect("get_utxos_by_addresses");
    let total: u64 = utxos.iter().map(|u| u.utxo_entry.amount).sum();
    println!("{role} {addr}: {} UTXO, {} KAS ({} sompi)", utxos.len(), total as f64 / 100_000_000.0, total);
}

/// Flag parsing: --key value | --dry-run; returns (positional, flags).
fn parse_flags(args: &[String]) -> (Vec<String>, std::collections::HashMap<String, String>) {
    let (mut pos, mut flags) = (Vec::new(), std::collections::HashMap::new());
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if a == "--dry-run" {
            flags.insert("dry-run".into(), "1".into());
        } else if let Some(name) = a.strip_prefix("--") {
            i += 1;
            match args.get(i) {
                Some(v) => { flags.insert(name.to_string(), v.clone()); }
                None => { eprintln!("flag --{name} needs a value"); std::process::exit(2); }
            }
        } else {
            pos.push(a.clone());
        }
        i += 1;
    }
    (pos, flags)
}

async fn recovery_client(flags: &std::collections::HashMap<String, String>) -> GrpcClient {
    let url = flags.get("node").cloned().unwrap_or_else(|| recovery::DEFAULT_NODE.to_string());
    match GrpcClient::connect(url.clone()).await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("no connection to node {url}: {e}");
            eprintln!("any Kaspa v2+ node with --utxoindex works: --node grpc://host:16110");
            std::process::exit(1);
        }
    }
}

const USAGE: &str = "vaultctl — Kaspa Safe

Recovery (via the recovery sheet, any v2+ node with --utxoindex):
  status   --recovery <sheet.txt> [--dest <address>] [--node grpc://host:16110]
  initiate --recovery <sheet.txt> --to <kaspa:q…>   [--dry-run]
  cancel   --recovery <sheet.txt> --dest <kaspa:q…> [--dry-run]
  complete --recovery <sheet.txt> --dest <kaspa:q…> [--dry-run]
  checkin  --recovery <sheet.txt>                   [--dry-run]
  inherit  --recovery <sheet.txt> [--heir-sk <hex>] [--dry-run]
  migrate  --recovery <sheet.txt> --to <kaspa:q…> [--dest <addr>] [--dry-run]
           (both keys = instant full-authority move: upgrade/rotation/exit;
            --dest = the withdrawal-in-progress destination, to rescue an UNVAULTING UTXO)

Dev (spike, simnet): keygen | selftest | mine <n> | balance [role] |
  create <kas> <delay> | send <address> <kas> | vault-status |
  initiate/cancel/complete without --recovery (via .keys/keys.json) |
  migrate [exit] — both keys: direct-genesis into a new vault / plain exit to dest";

#[tokio::main]
async fn main() {
    let argv: Vec<String> = std::env::args().collect();
    let cmd = argv.get(1).map(|s| s.as_str()).unwrap_or("");
    let rest = if argv.len() > 2 { &argv[2..] } else { &[] };
    let (pos, flags) = parse_flags(rest);
    let dry = flags.contains_key("dry-run");
    let rec = flags.get("recovery").map(|p| recovery::Recovery::load(p));

    match (cmd, rec) {
        ("status", Some(r)) => recovery::status(&recovery_client(&flags).await, &r, flags.get("dest").map(|s| s.as_str())).await,
        ("initiate", Some(r)) => {
            let Some(to) = flags.get("to") else { eprintln!("initiate: --to <kaspa:q…> required"); std::process::exit(2) };
            recovery::initiate(&recovery_client(&flags).await, &r, to, dry).await
        }
        ("cancel", Some(r)) => {
            let Some(dest) = flags.get("dest") else { eprintln!("cancel: --dest <address the withdrawal goes TO> required (shown in status/alert)"); std::process::exit(2) };
            recovery::cancel(&recovery_client(&flags).await, &r, dest, dry).await
        }
        ("complete", Some(r)) => {
            let Some(dest) = flags.get("dest") else { eprintln!("complete: --dest <withdrawal destination address> required"); std::process::exit(2) };
            recovery::complete(&recovery_client(&flags).await, &r, dest, dry).await
        }
        ("checkin", Some(r)) => recovery::checkin(&recovery_client(&flags).await, &r, dry).await,
        ("inherit", Some(r)) => recovery::inherit(&recovery_client(&flags).await, &r, flags.get("heir-sk").map(|s| s.as_str()), dry).await,
        ("migrate", Some(r)) => {
            let Some(to) = flags.get("to") else { eprintln!("migrate: --to <kaspa:q…> required (where the funds move)"); std::process::exit(2) };
            recovery::migrate(&recovery_client(&flags).await, &r, to, flags.get("dest").map(|s| s.as_str()), dry).await
        }
        ("status" | "checkin" | "inherit", None) => {
            eprintln!("{cmd}: --recovery <recovery-sheet.txt or .json> required");
            std::process::exit(2);
        }
        // ---- spike dev mode (simnet, .keys/keys.json) ----
        ("keygen", None) => cmd_keygen(),
        ("selftest", None) => vault::selftest(),
        ("multi-utxo", None) => { let _ = multi_utxo::run(); }
        ("create", None) => {
            let amount = pos.first().and_then(|s| s.parse().ok()).unwrap_or(100u64);
            let delay = pos.get(1).and_then(|s| s.parse().ok()).unwrap_or(60i64);
            ops::create(&client().await, &load_keys(), amount, delay).await
        }
        ("initiate", None) => ops::initiate(&client().await, &load_keys()).await,
        ("cancel", None) => ops::cancel(&client().await, &load_keys()).await,
        ("complete", None) => ops::complete(&client().await, &load_keys()).await,
        ("migrate", None) => ops::migrate(&client().await, &load_keys(), pos.first().map(|s| s.as_str()) == Some("exit")).await,
        ("vault-status", None) => ops::vault_status(&client().await, &load_keys()).await,
        ("send", None) => ops::send(&client().await, &load_keys(), pos.first().expect("address"), pos.get(1).and_then(|s| s.parse().ok()).expect("KAS amount")).await,
        ("mine", None) => cmd_mine(pos.first().and_then(|s| s.parse().ok()).unwrap_or(1)).await,
        ("balance", None) => cmd_balance(pos.first().map(|s| s.as_str()).unwrap_or("mine")).await,
        _ => {
            eprintln!("{USAGE}");
            std::process::exit(2);
        }
    }
}
