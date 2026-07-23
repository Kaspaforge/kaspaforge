//! Command orchestration. Offline commands (extract, verify) never touch the network; online
//! commands talk only to the user-selected node. Money commands build → locally verify → preview →
//! optionally save → optionally broadcast, and default to NOT broadcasting (spec §7.6).

use kaspa_forge_contracts::recovery::{Product, RecoveryRecord, Role, Verified};

use crate::envelope::{LineEntry, LinePackage, MutualSig, SignedTx, LINE_PACKAGE_SCHEMA, MUTUAL_SIG_SCHEMA, SCHEMA_VERSION};
use crate::node::{self, CovenantLine};
use crate::preview::{self, kas};
use crate::txbuild::{self, Action, Built};

#[derive(Default)]
pub struct Opts {
    pub recovery: Option<String>,
    pub node: Option<String>,
    pub outpoint: Option<String>,
    pub all: bool,
    pub output: Option<String>,
    pub broadcast: bool,
    pub json: bool,
    pub to: Option<String>,
    pub to_buyer: Option<u64>,
    // Air-gapped signing: when the covenant line is supplied explicitly, money/mutual-sign commands
    // build and sign OFFLINE with no node contact (spec DoD "offline sign + online submit").
    pub amount: Option<u64>,
    pub covenant_id: Option<String>,
    pub mode: Option<u8>,
    /// Offline covenant-line package produced by `dealctl prepare` (the documented air-gap input).
    pub line: Option<String>,
    /// Public watch file (from `dealctl watch`): lets the ONLINE `prepare`/`status` run without the
    /// private recovery record.
    pub watch: Option<String>,
    pub profile: Option<String>,
    pub deal: Option<String>,
    pub tx: Option<String>,
    pub buyer_signature: Option<String>,
    pub seller_signature: Option<String>,
}

impl Opts {
    fn node(&self) -> String {
        self.node.clone().unwrap_or_else(|| node::DEFAULT_NODE.to_string())
    }
    fn recovery(&self) -> Result<String, String> {
        self.recovery.clone().ok_or_else(|| "--recovery <file> is required".to_string())
    }
}

fn load_verified(opts: &Opts) -> Result<Verified, String> {
    let path = opts.recovery()?;
    let text = std::fs::read_to_string(&path).map_err(|e| format!("cannot read {path}: {e}"))?;
    let record = RecoveryRecord::from_json(&text)?;
    record.verify()
}

fn spend_from(outpoint: &str, amount: u64, cov: &str, mode: u8, daa: u64) -> Result<(kaspa_forge_contracts::escrow::EscrowSpend, u8), String> {
    if mode > 1 {
        return Err(format!("mode must be 0 (ACTIVE) or 1 (DISPUTED), got {mode}"));
    }
    let prev_outpoint = node::parse_outpoint(outpoint)?;
    let cov_id: kaspa_hashes::Hash = cov.parse().map_err(|_| "bad covenant id (expected 64 hex chars)".to_string())?;
    Ok((kaspa_forge_contracts::escrow::EscrowSpend { prev_outpoint, prev_amount: amount, prev_daa: daa, cov_id }, mode))
}

/// If the covenant line is available WITHOUT a node — from a `--line` package (written online by
/// `dealctl prepare`) or from the four raw flags — return it so the command builds and signs entirely
/// OFFLINE. `--line` is the documented path; the raw flags are an advanced fallback.
fn offline_line(opts: &Opts, v: &Verified) -> Option<Result<(kaspa_forge_contracts::escrow::EscrowSpend, u8), String>> {
    if let Some(path) = &opts.line {
        return Some((|| {
            let pkg = LinePackage::from_json(&std::fs::read_to_string(path).map_err(|e| format!("cannot read {path}: {e}"))?)?;
            // Bind the package to THIS deal: a package prepared for another network / product / deal
            // must never be signed against this recovery record (air-gap trust boundary).
            if pkg.network != v.network {
                return Err(format!("line package network {:?} != recovery record network {:?}", pkg.network, v.network));
            }
            if pkg.product != v.product {
                return Err("line package product does not match the recovery record".into());
            }
            if pkg.deal_id != v.deal_id {
                return Err(format!("line package deal_id {} != recovery record deal_id {}", pkg.deal_id, v.deal_id));
            }
            if pkg.lines.is_empty() {
                return Err("line package has no covenant lines".into());
            }
            // If several lines, disambiguate with --outpoint; else take the only one.
            let entry = match &opts.outpoint {
                Some(want) => pkg.lines.iter().find(|l| l.outpoint == *want).ok_or_else(|| format!("no line matching --outpoint {want} in the package"))?,
                None if pkg.lines.len() == 1 => &pkg.lines[0],
                None => return Err("the package has multiple lines — select one with --outpoint txid:index".into()),
            };
            spend_from(&entry.outpoint, entry.amount, &entry.covenant_id, entry.mode, entry.daa)
        })());
    }
    match (&opts.outpoint, opts.amount, &opts.covenant_id, opts.mode) {
        (Some(op), Some(amount), Some(cov), Some(mode)) => Some(spend_from(op, amount, cov, mode, 0)),
        _ => None,
    }
}

/// The public identity + addresses of a deal — enough for the online `prepare`/`status` to read the
/// chain, with NO private key. Sourced from a `--watch` file (preferred, secret-free) or, on the
/// offline machine, from the recovery record itself.
struct PublicView {
    network: String,
    product: Product,
    deal_id: u64,
    active: String,
    disputed: String,
}

fn load_public(opts: &Opts) -> Result<PublicView, String> {
    if let Some(path) = &opts.watch {
        let w = crate::envelope::WatchRecord::from_json(&std::fs::read_to_string(path).map_err(|e| format!("cannot read {path}: {e}"))?)?;
        return Ok(PublicView { network: w.network, product: w.product, deal_id: w.deal_id, active: w.active, disputed: w.disputed });
    }
    let v = load_verified(opts)?;
    Ok(PublicView { network: v.network, product: v.product, deal_id: v.deal_id, active: v.active_addr, disputed: v.disputed_addr })
}

/// Offline, no node, no secrets leave: derive the deal's PUBLIC watch view from the recovery record.
pub fn run_watch(opts: &Opts) -> Result<(), String> {
    let v = load_verified(opts)?;
    let output = opts.output.clone().ok_or("--output <file> is required")?;
    let w = crate::envelope::WatchRecord {
        schema: crate::envelope::WATCH_SCHEMA.into(),
        schema_version: SCHEMA_VERSION,
        network: v.network,
        product: v.product,
        deal_id: v.deal_id,
        active: v.active_addr,
        disputed: v.disputed_addr,
    };
    write_file(&output, &w.to_json()?)?;
    println!("wrote PUBLIC watch file → {output} (no private key inside).");
    println!("Copy ONLY this file to the online machine: dealctl prepare --watch {output} --node grpc://… --output lines.json");
    Ok(())
}

pub async fn run_prepare(opts: &Opts) -> Result<(), String> {
    // Public input only — the private recovery record never has to touch the online machine.
    let p = load_public(opts)?;
    let output = opts.output.clone().ok_or("--output <file> is required")?;
    let c = node::connect(&opts.node()).await?;
    let (lines, _stray) = node::covenant_lines(&c, &p.active, &p.disputed).await?;
    if lines.is_empty() {
        return Err("no covenant UTXOs to prepare — check status".into());
    }
    let vdaa = node::virtual_daa(&c).await?;
    let entries: Vec<LineEntry> = lines
        .iter()
        .map(|l| LineEntry {
            mode: l.mode,
            outpoint: node::fmt_outpoint(&l.spend.prev_outpoint),
            amount: l.spend.prev_amount,
            covenant_id: l.spend.cov_id.to_string(),
            daa: l.spend.prev_daa,
        })
        .collect();
    let pkg = LinePackage {
        schema: LINE_PACKAGE_SCHEMA.into(),
        schema_version: SCHEMA_VERSION,
        network: p.network,
        product: p.product,
        deal_id: p.deal_id,
        lines: entries,
    };
    write_file(&output, &pkg.to_json()?)?;
    println!("prepared {} covenant line(s) → {output} (virtual DAA {vdaa})", pkg.lines.len());
    println!("Move it to your OFFLINE machine and sign, e.g.:");
    println!("  dealctl escrow release --recovery deal.recovery.json --line {output} --output release.tx.json");
    Ok(())
}

/// Save/preview a single offline-built transaction; refuse to broadcast (air-gapped machine).
fn emit_offline(opts: &Opts, v: &Verified, built: &Built) -> Result<(), String> {
    preview::print(built, v, false);
    if opts.broadcast {
        return Err("offline build cannot broadcast — save with --output, move the file to an online machine, then: dealctl submit --tx <file> --node grpc://…".into());
    }
    let env = SignedTx::from_built(built, &v.network, v.product, v.deal_id);
    match &opts.output {
        Some(out) => {
            write_file(out, &env.to_json()?)?;
            println!("signed offline → {out}. Submit from an online machine: dealctl submit --tx {out} --node grpc://…");
        }
        None => println!("(add --output <file> to save this signed transaction for later online submit)"),
    }
    Ok(())
}

// ── offline ──

pub fn run_extract(opts: &Opts) -> Result<(), String> {
    let profile = opts.profile.clone().ok_or("--profile <profile.json> is required")?;
    let deal = opts.deal.clone().ok_or("--deal <id> is required")?;
    let output = opts.output.clone().ok_or("--output <file> is required")?;
    let text = std::fs::read_to_string(&profile).map_err(|e| format!("cannot read {profile}: {e}"))?;
    let record = crate::extract::extract_record(&text, &deal)?;
    crate::extract::write_record(&record, &output)?;
    println!("extracted deal {deal} → {output} (0600). Verify it offline: dealctl verify --recovery {output}");
    Ok(())
}

pub fn run_verify(opts: &Opts) -> Result<(), String> {
    let v = load_verified(opts)?;
    println!("recovery record OK");
    println!("  product:   {}", product_name(v.product));
    println!("  role:      {}", v.role.product_label(v.product));
    println!("  network:   {}", v.network);
    println!("  contract:  escrow v{} source {}…", v.version.version, &v.version.source_sha256[..12]);
    println!("  ACTIVE:    {}", v.active_addr);
    println!("  DISPUTED:  {}", v.disputed_addr);
    println!("  funding:   {}", if v.funding.is_some() { "present" } else { "none" });
    Ok(())
}

// ── online ──

pub async fn run_status(opts: &Opts) -> Result<(), String> {
    // Full record on the offline machine (shows role + available actions), or a secret-free watch
    // file on the online machine (shows the covenant lines only — no private key needed).
    let full = if opts.watch.is_some() { None } else { Some(load_verified(opts)?) };
    let p = match &full {
        Some(v) => PublicView {
            network: v.network.clone(),
            product: v.product,
            deal_id: v.deal_id,
            active: v.active_addr.clone(),
            disputed: v.disputed_addr.clone(),
        },
        None => load_public(opts)?,
    };
    let c = node::connect(&opts.node()).await?;
    let vdaa = node::virtual_daa(&c).await?;
    let (lines, stray) = node::covenant_lines(&c, &p.active, &p.disputed).await?;

    if opts.json {
        return status_json(&p, full.as_ref(), vdaa, &lines, &stray);
    }
    println!("deal {} · {} · virtual DAA {}", p.deal_id, product_name(p.product), vdaa);
    if let Some(v) = &full {
        println!("role: {}", v.role.product_label(v.product));
    }
    println!("ACTIVE   {}", p.active);
    println!("DISPUTED {}", p.disputed);
    if lines.is_empty() {
        println!("no covenant UTXOs — deal not funded, already resolved, or on a different network.");
    }
    for l in &lines {
        let age = vdaa.saturating_sub(l.spend.prev_daa);
        println!("─ {} line", mode_name(l.mode));
        println!("  outpoint:   {}", node::fmt_outpoint(&l.spend.prev_outpoint));
        println!("  amount:     {}", kas(l.spend.prev_amount));
        println!("  covenant:   {}", l.spend.cov_id);
        println!("  age:        {age} DAA");
        if let Some(v) = &full {
            println!("  actions:    {}", available_actions(v, l, age));
        }
    }
    for s in &stray {
        println!("─ stray plain UTXO (unsupported by covenant flow): {} {}", s.outpoint, kas(s.amount));
    }
    Ok(())
}

pub async fn run_money(opts: &Opts, action: Action, product: Product) -> Result<(), String> {
    let v = load_verified(opts)?;
    txbuild::check_product(&v, product)?;

    // Air-gapped path: when the covenant line is supplied on the command line, build and sign with
    // NO node contact, then save for online submit (spec DoD "offline sign + online submit"). The
    // keyless-path DAA maturity check is skipped offline (no node); the node enforces it on submit.
    if let Some(line) = offline_line(opts, &v) {
        let (spend, mode) = line?;
        let built = txbuild::build_covenant(&v, action, mode, &spend)?;
        return emit_offline(opts, &v, &built);
    }

    let c = node::connect(&opts.node()).await?;
    let vdaa = node::virtual_daa(&c).await?;
    let (lines, _stray) = node::covenant_lines(&c, &v.active_addr, &v.disputed_addr).await?;

    // Consider only lines in the mode this path requires (keeps single-line selection unambiguous).
    let candidates: Vec<&CovenantLine> = match action.required_mode() {
        Some(m) => lines.iter().filter(|l| l.mode == m).collect(),
        None => lines.iter().collect(),
    };
    let selected = select_lines(&candidates, opts)?;

    let mut builts: Vec<Built> = Vec::new();
    for line in &selected {
        if let Some(min) = action.maturity_daa(&v.params) {
            let age = vdaa.saturating_sub(line.spend.prev_daa);
            if age < min {
                return Err(format!(
                    "{}: timelock not matured — age {age} DAA < required {min} DAA (need {} more)",
                    action.name(),
                    min - age
                ));
            }
        }
        let built = txbuild::build_covenant(&v, action, line.mode, &line.spend)?;
        builts.push(built);
    }

    emit_and_maybe_broadcast(opts, &v, builts, &c).await
}

pub async fn run_fund(opts: &Opts) -> Result<(), String> {
    let v = load_verified(opts)?;
    let f = v.funding.as_ref().ok_or("this recovery record has no funding key — nothing to fund")?;
    let c = node::connect(&opts.node()).await?;
    let utxos = node::plain_utxos(&c, &f.address).await?;
    let tuples: Vec<_> = utxos.iter().map(|u| (u.outpoint, u.amount, u.daa, u.coinbase)).collect();
    let built = txbuild::build_fund(&v, &tuples)?;
    emit_and_maybe_broadcast(opts, &v, vec![built], &c).await
}

pub async fn run_sweep_funding(opts: &Opts) -> Result<(), String> {
    let v = load_verified(opts)?;
    let to = opts.to.clone().ok_or("--to <kaspa:q…> is required")?;
    let f = v.funding.as_ref().ok_or("this recovery record has no funding key — nothing to sweep")?;
    let c = node::connect(&opts.node()).await?;
    let utxos = node::plain_utxos(&c, &f.address).await?;
    let tuples: Vec<_> = utxos.iter().map(|u| (u.outpoint, u.amount, u.daa, u.coinbase)).collect();
    let built = txbuild::build_funding_sweep(&v, &to, &tuples)?;
    emit_and_maybe_broadcast(opts, &v, vec![built], &c).await
}

pub async fn run_mutual_sign(opts: &Opts) -> Result<(), String> {
    let v = load_verified(opts)?;
    let to_buyer = opts.to_buyer.ok_or("--to-buyer <sompi> is required")?;
    let output = opts.output.clone().ok_or("--output <file> is required")?;

    // Air-gapped: covenant line supplied explicitly → sign with NO node.
    if let Some(line) = offline_line(opts, &v) {
        let (spend, mode) = line?;
        return mutual_sign_line(&v, &spend, mode, to_buyer, &output);
    }

    let c = node::connect(&opts.node()).await?;
    let (lines, _stray) = node::covenant_lines(&c, &v.active_addr, &v.disputed_addr).await?;
    let candidates: Vec<&CovenantLine> = lines.iter().collect();
    let selected = select_lines(&candidates, opts)?;
    if selected.len() != 1 {
        return Err("mutual-sign works on one UTXO line; select it with --outpoint".into());
    }
    let line = selected[0];
    mutual_sign_line(&v, &line.spend, line.mode, to_buyer, &output)
}

fn mutual_sign_line(
    v: &Verified,
    spend: &kaspa_forge_contracts::escrow::EscrowSpend,
    mode: u8,
    to_buyer: u64,
    output: &str,
) -> Result<(), String> {
    let (_expects, to_seller) = txbuild::mutual_expected(v, spend, to_buyer)?;
    let unsigned = txbuild::mutual_unsigned_tx(v, spend, mode, to_buyer)?;
    let contract = if mode == 0 { v.params.active_contract()? } else { v.params.disputed_contract()? };
    let sig = kaspa_forge_contracts::escrow::mutual_sig(&v.params, &contract, spend, to_buyer, &v.party_sk)?;
    let pkg = MutualSig {
        schema: MUTUAL_SIG_SCHEMA.into(),
        schema_version: SCHEMA_VERSION,
        network: v.network.clone(),
        product: v.product,
        deal_id: v.deal_id,
        mode,
        outpoint: node::fmt_outpoint(&spend.prev_outpoint),
        covenant_id: spend.cov_id.to_string(),
        to_buyer,
        to_seller,
        unsigned_txid: unsigned.id().to_string(),
        signer_role: v.role,
        signature: hex::encode(sig),
    };
    write_file(output, &pkg.to_json()?)?;
    println!("signed mutual settlement as {} → {output}", v.role.product_label(v.product));
    println!("  to buyer:  {}", kas(to_buyer));
    println!("  to seller: {}", kas(to_seller));
    println!("Send this to the other party; either party combines both with: dealctl mutual-combine");
    Ok(())
}

pub async fn run_mutual_combine(opts: &Opts) -> Result<(), String> {
    let v = load_verified(opts)?;
    let bpath = opts.buyer_signature.clone().ok_or("--buyer-signature <file> is required")?;
    let spath = opts.seller_signature.clone().ok_or("--seller-signature <file> is required")?;
    let buyer = MutualSig::from_json(&std::fs::read_to_string(&bpath).map_err(|e| format!("{bpath}: {e}"))?)?;
    let seller = MutualSig::from_json(&std::fs::read_to_string(&spath).map_err(|e| format!("{spath}: {e}"))?)?;
    if buyer.signer_role != Role::Buyer || seller.signer_role != Role::Seller {
        return Err("--buyer-signature must be the buyer's package and --seller-signature the seller's".into());
    }
    buyer.agrees_with(&seller)?;

    // Reconstruct the covenant line from the (agreeing) packages and the trusted params.
    let outpoint = node::parse_outpoint(&buyer.outpoint)?;
    let cov_id: kaspa_hashes::Hash = buyer.covenant_id.parse().map_err(|_| "bad covenant id in package")?;
    let prev_amount = buyer
        .to_buyer
        .checked_add(buyer.to_seller)
        .and_then(|x| x.checked_add(v.params.fee_resolve))
        .and_then(|x| x.checked_add(v.params.fee_budget))
        .ok_or("mutual amounts overflow")?;
    let spend = kaspa_forge_contracts::escrow::EscrowSpend { prev_outpoint: outpoint, prev_amount, prev_daa: 0, cov_id };

    // Confirm the unsigned tx we rebuild is the exact one both parties signed.
    let unsigned = txbuild::mutual_unsigned_tx(&v, &spend, buyer.mode, buyer.to_buyer)?;
    if unsigned.id().to_string() != buyer.unsigned_txid {
        return Err("rebuilt mutual transaction does not match the signed commitment — refusing".into());
    }
    let buyer_sig = hex::decode(&buyer.signature).map_err(|_| "buyer signature is not hex")?;
    let seller_sig = hex::decode(&seller.signature).map_err(|_| "seller signature is not hex")?;
    let built = txbuild::build_mutual(&v, &spend, buyer.mode, buyer.to_buyer, buyer_sig, seller_sig)?;

    let c = if opts.broadcast { Some(node::connect(&opts.node()).await?) } else { None };
    if let Some(c) = c {
        emit_and_maybe_broadcast(opts, &v, vec![built], &c).await
    } else {
        preview::print(&built, &v, false);
        if let Some(out) = &opts.output {
            let env = SignedTx::from_built(&built, &v.network, v.product, v.deal_id);
            write_file(out, &env.to_json()?)?;
            println!("saved → {out}. Submit later with: dealctl submit --tx {out} --node <grpc://…>");
        }
        Ok(())
    }
}

pub async fn run_submit(opts: &Opts) -> Result<(), String> {
    let path = opts.tx.clone().ok_or("--tx <file> is required")?;
    let text = std::fs::read_to_string(&path).map_err(|e| format!("cannot read {path}: {e}"))?;
    let env = SignedTx::from_json(&text)?;
    env.verify_for_submit()?; // fail-closed structural re-verification, no key needed
    // Optional stronger check: recompute expected outputs from a trusted recovery record.
    if opts.recovery.is_some() {
        let v = load_verified(opts)?;
        env.verify_against_record(&v)?;
        println!("envelope re-verified against recovery record (outputs match params)");
    }
    println!("envelope re-verified: {} · txid {}", env.path, env.txid);
    let c = node::connect(&opts.node()).await?;
    let txid = node::submit(&c, &env.tx).await?;
    println!("SUBMITTED: txid {txid}");
    Ok(())
}

// ── shared ──

async fn emit_and_maybe_broadcast(
    opts: &Opts,
    v: &Verified,
    builts: Vec<Built>,
    c: &kaspa_grpc_client::GrpcClient,
) -> Result<(), String> {
    let multi = builts.len() > 1;
    for (i, built) in builts.iter().enumerate() {
        if !opts.json {
            preview::print(built, v, opts.broadcast);
        }
        let env = SignedTx::from_built(built, &v.network, v.product, v.deal_id);
        if opts.json {
            println!("{}", env.to_json()?);
        }
        if let Some(out) = &opts.output {
            let path = if multi { format!("{out}.{i}") } else { out.clone() };
            write_file(&path, &env.to_json()?)?;
            println!("saved → {path}");
        }
        if opts.broadcast {
            let txid = node::submit(c, &built.tx).await?;
            println!("SUBMITTED: txid {txid}");
        }
    }
    if !opts.broadcast {
        println!("(nothing submitted — re-run with --broadcast, or submit a saved file with: dealctl submit)");
    }
    Ok(())
}

fn select_lines<'a>(lines: &[&'a CovenantLine], opts: &Opts) -> Result<Vec<&'a CovenantLine>, String> {
    if opts.outpoint.is_some() && opts.all {
        return Err("--outpoint and --all are mutually exclusive".into());
    }
    if let Some(op) = &opts.outpoint {
        let want = node::parse_outpoint(op)?;
        let sel: Vec<&CovenantLine> = lines.iter().copied().filter(|l| l.spend.prev_outpoint == want).collect();
        if sel.is_empty() {
            return Err(format!("no covenant UTXO matching --outpoint {op} in the required mode"));
        }
        return Ok(sel);
    }
    if opts.all {
        if lines.is_empty() {
            return Err("no covenant UTXOs to act on".into());
        }
        return Ok(lines.to_vec());
    }
    match lines.len() {
        0 => Err("no covenant UTXO for this path — check status".into()),
        1 => Ok(vec![lines[0]]),
        _ => Err("multiple covenant UTXOs — pick one with --outpoint txid:index, or use --all for a separate tx each".into()),
    }
}

fn available_actions(v: &Verified, line: &CovenantLine, age: u64) -> String {
    let mut acts = Vec::new();
    let is_buyer = v.role == Role::Buyer;
    let is_seller = v.role == Role::Seller;
    if line.mode == 0 {
        if is_buyer { acts.push("release"); acts.push("dispute"); }
        if is_seller { acts.push("refund"); }
        if age >= v.params.dispute_window as u64 { acts.push("auto-release (keyless)"); }
    } else {
        if is_buyer { acts.push("release"); }
        if is_seller { acts.push("refund"); }
        if age >= v.params.arbiter_deadline as u64 { acts.push("timeout (keyless)"); }
    }
    acts.push("mutual (both parties)");
    acts.join(", ")
}

fn status_json(p: &PublicView, full: Option<&Verified>, vdaa: u64, lines: &[CovenantLine], stray: &[node::PlainUtxo]) -> Result<(), String> {
    let lines_json: Vec<serde_json::Value> = lines
        .iter()
        .map(|l| {
            let age = vdaa.saturating_sub(l.spend.prev_daa);
            serde_json::json!({
                "mode": if l.mode == 0 { "active" } else { "disputed" },
                "outpoint": node::fmt_outpoint(&l.spend.prev_outpoint),
                "amount_sompi": l.spend.prev_amount,
                "covenant_id": l.spend.cov_id.to_string(),
                "age_daa": age,
            })
        })
        .collect();
    let out = serde_json::json!({
        "deal_id": p.deal_id,
        "product": product_name(p.product),
        "role": full.map(|v| v.role.product_label(v.product)),
        "network": p.network,
        "virtual_daa": vdaa,
        "active_addr": p.active,
        "disputed_addr": p.disputed,
        "lines": lines_json,
        "stray_plain_utxos": stray.len(),
    });
    println!("{}", serde_json::to_string_pretty(&out).map_err(|e| e.to_string())?);
    Ok(())
}

fn write_file(path: &str, contents: &str) -> Result<(), String> {
    std::fs::write(path, format!("{contents}\n")).map_err(|e| format!("cannot write {path}: {e}"))
}

fn product_name(p: Product) -> &'static str {
    match p {
        Product::Escrow => "escrow",
        Product::Deposit => "deposit",
    }
}

fn mode_name(mode: u8) -> &'static str {
    if mode == 0 { "ACTIVE" } else { "DISPUTED" }
}
