//! Human-readable transaction preview (spec §8). Addresses shown are recomputed from the built
//! transaction's own verified scriptPubKeys — never from a server-provided label.

use kaspa_forge_contracts::recovery::Verified;

use crate::txbuild::Built;

pub fn kas(sompi: u64) -> String {
    format!("{}.{:08} KAS", sompi / 100_000_000, sompi % 100_000_000)
}

/// Print the full pre-signature/pre-broadcast preview.
pub fn print(built: &Built, verified: &Verified, broadcast: bool) {
    println!("──────────────────────────────────────────────");
    println!("network:          {}", verified.network);
    println!(
        "contract:         {} v{}  source {}…",
        built_family(),
        verified.version.version,
        &verified.version.source_sha256[..12]
    );
    println!("path:             {}", built.path);
    println!("mode:             {}", if built.mode == 0 { "ACTIVE" } else { "DISPUTED" });
    if built.input_outpoints.len() == 1 {
        println!("covenant input:   {}", crate::node::fmt_outpoint(&built.input_outpoints[0]));
    } else {
        println!("funding inputs:   {} UTXO(s)", built.input_outpoints.len());
        for op in &built.input_outpoints {
            println!("                  {}", crate::node::fmt_outpoint(op));
        }
    }
    println!("input value:      {}", kas(built.input_total));
    println!("outputs:");
    for o in &built.outs {
        let cov = if o.covenant.is_some() { "  [covenant]" } else { "" };
        println!("  {:<22} {}  {}{cov}", o.label, kas(o.sompi), o.address);
    }
    if let Some(f) = built.service_fee {
        println!("service fee:      {}", kas(f));
    } else {
        println!("service fee:      none (timeout path)");
    }
    println!("network fee:      {}", kas(built.fee_budget));
    println!("txid:             {}", built.tx.id());
    if broadcast {
        println!("action:           BUILT, VERIFIED, and will be SUBMITTED to the node");
    } else {
        println!("action:           BUILT and VERIFIED — NOT submitted (pass --broadcast to send)");
    }
    println!("──────────────────────────────────────────────");
}

fn built_family() -> &'static str {
    "escrow"
}
