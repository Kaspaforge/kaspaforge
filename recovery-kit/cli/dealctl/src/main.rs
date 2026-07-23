//! dealctl — the public party-side recovery CLI for Kaspa Forge Escrow and Deposit (spec §7).
//!
//! It rebuilds and signs any covenant path your key authorizes, using ONLY a local recovery record
//! and a Kaspa node of your choice — no Kaspa Forge server is contacted at any step. Money commands
//! build offline, verify locally, preview, and never broadcast unless you pass --broadcast.

use std::collections::HashMap;

use dealctl::commands::{self, Opts};
use dealctl::txbuild::Action;
use kaspa_forge_contracts::recovery::Product;

const USAGE: &str = r#"dealctl — Kaspa Forge Escrow/Deposit recovery (party-side, hosted-independent)

Prepare (offline unless a node is named):
  extract  --profile profile.json --deal <id> --output deal.recovery.json
  verify   --recovery deal.recovery.json
  status   --recovery deal.recovery.json [--node grpc://…] [--json]
  watch    --recovery deal.recovery.json --output watch.json                   (OFFLINE: public view,
                                                                                NO private key inside)
  prepare  --watch watch.json --node grpc://… --output lines.json              (ONLINE: exports the
                                                                                covenant lines; needs NO key)

Funding:
  fund          --recovery … [--node …] [--output tx.json] [--broadcast]
  sweep-funding --recovery … --to kaspa:q… [--node …] [--broadcast]

Escrow paths:
  escrow release   | refund | dispute | auto-release | timeout
Deposit paths (product=deposit):
  deposit return   | concede | claim  | auto-return  | timeout
    common: --recovery … [--node …] [--outpoint txid:index | --all] [--output tx.json] [--broadcast]

  AIR-GAPPED signing — the private key NEVER touches the online machine:
    OFFLINE:  watch   --recovery deal.recovery.json --output watch.json        (public, no key)
    ONLINE:   prepare --watch watch.json --node grpc://… --output lines.json   (no key)
    OFFLINE:  escrow release --recovery deal.recovery.json --line lines.json --output release.tx.json
    ONLINE:   submit  --tx release.tx.json --node grpc://…                       (no key)
  The signer binds lines.json to the recovery record (network/product/deal_id must match). (Advanced:
  instead of --line, pass all of --outpoint --amount --covenant-id --mode.)

Mutual settlement:
  mutual-sign    --recovery … --to-buyer <sompi> [--outpoint …] --output me.sig.json
  mutual-combine --recovery … --buyer-signature b.json --seller-signature s.json [--output tx.json] [--broadcast]

Submit a pre-signed transaction (no key needed):
  submit --tx tx.json [--node grpc://…]

Default node is grpc://127.0.0.1:16110. Nothing is ever sent to a Kaspa Forge server."#;

fn parse_flags(args: &[String]) -> (Vec<String>, HashMap<String, String>) {
    const BOOL: &[&str] = &["all", "broadcast", "json"];
    let (mut pos, mut flags) = (Vec::new(), HashMap::new());
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if let Some(name) = a.strip_prefix("--") {
            if BOOL.contains(&name) {
                flags.insert(name.to_string(), "1".into());
            } else if let Some(val) = args.get(i + 1) {
                flags.insert(name.to_string(), val.clone());
                i += 1;
            } else {
                flags.insert(name.to_string(), String::new());
            }
        } else {
            pos.push(a.clone());
        }
        i += 1;
    }
    (pos, flags)
}

fn build_opts(flags: &HashMap<String, String>) -> Result<Opts, String> {
    let to_buyer = match flags.get("to-buyer") {
        Some(s) => Some(s.parse::<u64>().map_err(|_| "--to-buyer must be a sompi integer".to_string())?),
        None => None,
    };
    let amount = match flags.get("amount") {
        Some(s) => Some(s.parse::<u64>().map_err(|_| "--amount must be a sompi integer".to_string())?),
        None => None,
    };
    let mode = match flags.get("mode") {
        Some(s) => Some(s.parse::<u8>().map_err(|_| "--mode must be 0 or 1".to_string())?),
        None => None,
    };
    Ok(Opts {
        recovery: flags.get("recovery").cloned(),
        node: flags.get("node").cloned(),
        outpoint: flags.get("outpoint").cloned(),
        all: flags.contains_key("all"),
        output: flags.get("output").cloned(),
        broadcast: flags.contains_key("broadcast"),
        json: flags.contains_key("json"),
        to: flags.get("to").cloned(),
        to_buyer,
        amount,
        covenant_id: flags.get("covenant-id").cloned(),
        mode,
        line: flags.get("line").cloned(),
        watch: flags.get("watch").cloned(),
        profile: flags.get("profile").cloned(),
        deal: flags.get("deal").cloned(),
        tx: flags.get("tx").cloned(),
        buyer_signature: flags.get("buyer-signature").cloned(),
        seller_signature: flags.get("seller-signature").cloned(),
    })
}

fn escrow_action(sub: &str) -> Option<Action> {
    match sub {
        "release" => Some(Action::Release),
        "refund" => Some(Action::Refund),
        "dispute" => Some(Action::Dispute),
        "auto-release" => Some(Action::AutoRelease),
        "timeout" => Some(Action::Timeout),
        _ => None,
    }
}

fn deposit_action(sub: &str) -> Option<Action> {
    match sub {
        "return" => Some(Action::Release),
        "concede" => Some(Action::Refund),
        "claim" => Some(Action::Dispute),
        "auto-return" => Some(Action::AutoRelease),
        "timeout" => Some(Action::Timeout),
        _ => None,
    }
}

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    let cmd = argv.get(1).map(|s| s.as_str()).unwrap_or("");
    let rest: &[String] = if argv.len() > 2 { &argv[2..] } else { &[] };
    let (pos, flags) = parse_flags(rest);

    let opts = match build_opts(&flags) {
        Ok(o) => o,
        Err(e) => fail_usage(&e),
    };
    let rt = || tokio::runtime::Runtime::new().expect("tokio runtime");

    let result: Result<(), String> = match cmd {
        "extract" => commands::run_extract(&opts),
        "verify" => commands::run_verify(&opts),
        "status" => rt().block_on(commands::run_status(&opts)),
        "watch" => commands::run_watch(&opts),
        "prepare" => rt().block_on(commands::run_prepare(&opts)),
        "fund" => rt().block_on(commands::run_fund(&opts)),
        "sweep-funding" => rt().block_on(commands::run_sweep_funding(&opts)),
        "submit" => rt().block_on(commands::run_submit(&opts)),
        "mutual-sign" => rt().block_on(commands::run_mutual_sign(&opts)),
        "mutual-combine" => rt().block_on(commands::run_mutual_combine(&opts)),
        "escrow" => match pos.first().and_then(|s| escrow_action(s)) {
            Some(action) => rt().block_on(commands::run_money(&opts, action, Product::Escrow)),
            None => fail_usage("escrow <release|refund|dispute|auto-release|timeout>"),
        },
        "deposit" => match pos.first().and_then(|s| deposit_action(s)) {
            Some(action) => rt().block_on(commands::run_money(&opts, action, Product::Deposit)),
            None => fail_usage("deposit <return|concede|claim|auto-return|timeout>"),
        },
        "" | "help" | "-h" | "--help" => {
            println!("{USAGE}");
            std::process::exit(0);
        }
        other => fail_usage(&format!("unknown command: {other}")),
    };

    if let Err(e) = result {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

fn fail_usage(msg: &str) -> ! {
    eprintln!("{msg}\n\n{USAGE}");
    std::process::exit(2);
}
