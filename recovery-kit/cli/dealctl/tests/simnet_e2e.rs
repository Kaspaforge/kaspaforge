//! Full hosted-independent E2E against a REAL simnet kaspad v2.0.1 (spec §10.5). Marked #[ignore]:
//! run explicitly with a node up. NO Kaspa Forge server is contacted — only the simnet node RPC.
//!
//! Start the node first:
//!   /opt/kaspa-spike/bin/kaspad --simnet --utxoindex --unsaferpc --enable-unsynced-mining \
//!     --appdir=<clean> --rpclisten=127.0.0.1:16510
//! Then: cargo test --test simnet_e2e -- --ignored --nocapture
//!
//! Exercises the actual dealctl code paths: node::{covenant_lines,plain_utxos,submit} interpreting a
//! real covenant node, txbuild build+local-verify, the SignedTx envelope serialize→deserialize→
//! verify_for_submit round-trip, DAA maturity agreeing with consensus, and balance assertions.

use kaspa_addresses::{Address, Prefix, Version};
use kaspa_consensus_core::tx::{Transaction, TransactionOutpoint, UtxoEntry};
use kaspa_grpc_client::GrpcClient;
use kaspa_rpc_core::api::rpc::RpcApi;

use dealctl::envelope::SignedTx;
use dealctl::node;
use dealctl::txbuild::{self, Action};
use kaspa_forge_contracts::recovery::{
    Addresses, ContractRef, Funding, Params, Product, RecoveryRecord, Role, Verified, SCHEMA, SCHEMA_VERSION,
};
use kaspa_forge_contracts::registry::ESCROW_V1;
use kaspa_forge_contracts::tx::{p2sh, spk_address, sk_to_xonly};

const RPC: &str = "grpc://127.0.0.1:16510";
const NET: &str = "simnet";
const WINDOW: i64 = 30; // dispute window (DAA) — simnet mines fast
const DEADLINE: i64 = 60; // arbiter deadline (DAA)
const AMOUNT: u64 = 200_000_000; // 2 KAS per deal (contract MIN_OUT is 1 KAS; the 50-KAS floor is a hosted rule)
const FR: u64 = 5_000_000;
const FD: u64 = 20_000_000;

fn key(b: u8) -> [u8; 32] { [b; 32] }
fn pk(b: u8) -> [u8; 32] { sk_to_xonly(&key(b)).unwrap() }
fn address(pk: &[u8; 32]) -> Address { Address::new(Prefix::Simnet, Version::PubKey, pk) }

async fn mine(c: &GrpcClient, pay: &Address, n: u64) {
    for _ in 0..n {
        let t = c.get_block_template(pay.clone(), vec![]).await.expect("get_block_template");
        let r = c.submit_block(t.block, false).await.expect("submit_block");
        assert!(matches!(r.report, kaspa_rpc_core::SubmitBlockReport::Success), "block rejected: {:?}", r.report);
    }
}

async fn total(c: &GrpcClient, a: &Address) -> u64 {
    c.get_utxos_by_addresses(vec![a.clone()]).await.unwrap().iter().map(|u| u.utxo_entry.amount).sum()
}

/// Mature spendable UTXOs at an address (coinbase needs ≥1010 confirmations on simnet).
async fn spendable(c: &GrpcClient, a: &Address) -> Vec<(TransactionOutpoint, u64, u64, bool)> {
    let vdaa = c.get_block_dag_info().await.unwrap().virtual_daa_score;
    let mut v: Vec<_> = c
        .get_utxos_by_addresses(vec![a.clone()])
        .await
        .unwrap()
        .into_iter()
        .filter(|e| {
            let need = if e.utxo_entry.is_coinbase { 1010 } else { 10 };
            e.utxo_entry.block_daa_score + need <= vdaa
        })
        .map(|e| (TransactionOutpoint::from(e.outpoint), e.utxo_entry.amount, e.utxo_entry.block_daa_score, e.utxo_entry.is_coinbase))
        .collect();
    v.sort_by_key(|(_, amt, _, _)| std::cmp::Reverse(*amt));
    v
}

async fn submit(c: &GrpcClient, tx: &Transaction) {
    let rpc: kaspa_rpc_core::RpcTransaction = tx.into();
    c.submit_transaction(rpc, false).await.expect("submit_transaction");
}

/// Consolidate an address's mature coinbase UTXOs into a single spendable output for the given key,
/// so a covenant fund transaction has one clean input.
async fn consolidate(c: &GrpcClient, sk: &[u8; 32], pubk: &[u8; 32]) {
    use kaspa_consensus_core::tx::{ScriptPublicKey, TransactionOutput};
    use kaspa_forge_contracts::tx::{build_tx, p2pk_script, p2pk_sigscript, populated, InputSpec};
    let addr = address(pubk);
    // A few bounded rounds — merge the highest-value mature UTXOs into one, enough to fund the small
    // E2E deals. Not an exhaustive sweep (that would be O(n^2) over thousands of coinbase UTXOs).
    for _ in 0..3 {
        let utxos = spendable(c, &addr).await;
        if utxos.len() < 2 {
            break;
        }
        let take: Vec<_> = utxos.into_iter().take(50).collect();
        let sum: u64 = take.iter().map(|(_, a, _, _)| a).sum();
        // fee must cover compute mass of a many-input tx (simnet ~100 sompi/gram); be generous.
        let fee = (take.len() as u64) * 400_000;
        let spk = ScriptPublicKey::new(0, p2pk_script(pubk).into());
        let inputs: Vec<InputSpec> = take
            .iter()
            .map(|(op, a, d, cb)| InputSpec { outpoint: *op, entry: UtxoEntry::new(*a, spk.clone(), *d, *cb, None), sequence: 0 })
            .collect();
        let out = TransactionOutput::new(sum - fee, spk.clone());
        let mut tx = build_tx(&inputs, vec![out]);
        let entries: Vec<UtxoEntry> = inputs.iter().map(|i| i.entry.clone()).collect();
        let sigs: Vec<Vec<u8>> = (0..inputs.len()).map(|i| p2pk_sigscript(&populated(&tx, &entries), i, sk)).collect();
        for (i, s) in sigs.into_iter().enumerate() {
            tx.inputs[i].signature_script = s;
        }
        tx.finalize();
        submit(c, &tx).await;
        mine(c, &address(&pk(9)), 3).await;
    }
}

/// Build a verified recovery record for a deal funded by `funding_key`, on simnet.
fn verified(product: Product, role: Role, funding_key: u8) -> Verified {
    let params = kaspa_forge_contracts::escrow::EscrowParams {
        buyer_pk: pk(1),
        seller_pk: pk(2),
        arbiter_pk: pk(3),
        dispute_window: WINDOW,
        arbiter_deadline: DEADLINE,
        timeout_to: 0,
        fee_pk: pk(4),
        fee_resolve: FR,
        fee_dispute: FD,
        fee_budget: 1_000_000,
    };
    let active = spk_address(&p2sh(&params.active_contract().unwrap().script), NET).unwrap();
    let disputed = spk_address(&p2sh(&params.disputed_contract().unwrap().script), NET).unwrap();
    let hx = |b: &[u8; 32]| hex::encode(b);
    let party_sk = if role == Role::Buyer { key(1) } else { key(2) };
    let record = RecoveryRecord {
        schema: SCHEMA.into(),
        schema_version: SCHEMA_VERSION,
        product,
        deal_id: 1,
        network: NET.into(),
        contract: ContractRef {
            family: "escrow".into(),
            version: 1,
            source_sha256: ESCROW_V1.source_sha256.into(),
            silverscript_revision: "26e3b9f94821b6fe47a2492755252ec4f995abb1".into(),
            rusty_kaspa_tag: ESCROW_V1.rusty_kaspa_tag.into(),
        },
        role,
        party_sk: hex::encode(party_sk),
        party_pk: hx(if role == Role::Buyer { &params.buyer_pk } else { &params.seller_pk }),
        funding: Some(Funding {
            sk: hex::encode(key(funding_key)),
            pk: hx(&pk(funding_key)),
            address: address(&pk(funding_key)).to_string(),
        }),
        params: Params {
            buyer_pk: hx(&params.buyer_pk),
            seller_pk: hx(&params.seller_pk),
            arbiter_pk: hx(&params.arbiter_pk),
            dispute_window: WINDOW,
            arbiter_deadline: DEADLINE,
            timeout_to: 0,
            fee_pk: hx(&params.fee_pk),
            fee_resolve: FR,
            fee_dispute: FD,
            fee_budget: 1_000_000,
        },
        addresses: Addresses { active, disputed },
    };
    record.verify().expect("recovery record must verify")
}

/// Persistent miner "bank" (key 9). Mine past coinbase maturity (1010) and consolidate a few of the
/// matured coinbases into one spendable output.
async fn setup_bank(c: &GrpcClient) {
    mine(c, &address(&pk(9)), 1100).await;
    consolidate(c, &key(9), &pk(9)).await;
    mine(c, &address(&pk(9)), 12).await; // mature the consolidated output
}

/// Send `amount` from the bank (key 9) to a fresh P2PK address, producing ONE mature non-coinbase
/// UTXO there — exactly the shape a real funding address has (not raw coinbase).
async fn send_from_bank(c: &GrpcClient, dest_pk: &[u8; 32], amount: u64) {
    use kaspa_consensus_core::tx::{ScriptPublicKey, TransactionOutput};
    use kaspa_forge_contracts::tx::{build_tx, p2pk_script, p2pk_sigscript, populated, InputSpec};
    let bank_spk = ScriptPublicKey::new(0, p2pk_script(&pk(9)).into());
    let utxos = spendable(c, &address(&pk(9))).await;
    let mut inputs = Vec::new();
    let mut got = 0u64;
    for (op, a, d, cb) in utxos {
        inputs.push(InputSpec { outpoint: op, entry: UtxoEntry::new(a, bank_spk.clone(), d, cb, None), sequence: 0 });
        got += a;
        if got >= amount + 10_000_000 {
            break;
        }
    }
    assert!(got >= amount + 10_000_000, "bank has enough (mine more)");
    let fee = 3_000_000u64;
    let dest = ScriptPublicKey::new(0, p2pk_script(dest_pk).into());
    let change = got - amount - fee;
    let mut outs = vec![TransactionOutput::new(amount, dest)];
    if change > 2_000_000 {
        outs.push(TransactionOutput::new(change, bank_spk.clone()));
    }
    let mut tx = build_tx(&inputs, outs);
    let entries: Vec<UtxoEntry> = inputs.iter().map(|i| i.entry.clone()).collect();
    let sigs: Vec<Vec<u8>> = (0..inputs.len()).map(|i| p2pk_sigscript(&populated(&tx, &entries), i, &key(9))).collect();
    for (i, s) in sigs.into_iter().enumerate() {
        tx.inputs[i].signature_script = s;
    }
    tx.finalize();
    submit(c, &tx).await;
    mine(c, &address(&pk(9)), 15).await; // mature the transfer
}

/// A Desk-shaped encrypted profile record for this deal — cfg WITHOUT fee_budget (so extract must
/// migrate it), so the CLI chain exercises the exact persisted shape.
fn profile_json(v: &Verified) -> String {
    let p = &v.params;
    let hx = |b: &[u8; 32]| hex::encode(b);
    let f = v.funding.as_ref().unwrap();
    serde_json::json!({
        "deals": [{
            "id": v.deal_id,
            "role": if v.role == Role::Buyer { "buyer" } else { "seller" },
            "sk": hex::encode(v.party_sk),
            "funding_sk": hex::encode(f.sk),
            "funding_pk": hx(&f.pk),
            "network": v.network,
            "template": if v.product == Product::Deposit { "deposit" } else { "escrow" },
            "escrow_addr": v.active_addr,
            "disputed_addr": v.disputed_addr,
            "cfg": {
                "buyer_pk": hx(&p.buyer_pk), "seller_pk": hx(&p.seller_pk), "arbiter_pk": hx(&p.arbiter_pk),
                "dispute_window": p.dispute_window, "arbiter_deadline": p.arbiter_deadline, "timeout_to": p.timeout_to,
                "fee_pk": hx(&p.fee_pk), "fee_resolve": p.fee_resolve, "fee_dispute": p.fee_dispute
            }
        }]
    })
    .to_string()
}

fn tmp(name: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join(name)
}

/// Run the dealctl BINARY and return its exit code.
fn cli(args: &[&str]) -> i32 {
    std::process::Command::new(env!("CARGO_BIN_EXE_dealctl")).args(args).status().unwrap().code().unwrap_or(-1)
}

/// age-encrypt then decrypt a file, proving the profile survives the `.age` backup round-trip.
fn age_round_trip(plain: &std::path::Path, out: &std::path::Path) {
    let key = tmp("age-key.txt");
    let enc = tmp("profile.age");
    // age refuses to overwrite existing files; clear any leftovers from a previous run.
    let _ = std::fs::remove_file(&key);
    let _ = std::fs::remove_file(&enc);
    let _ = std::fs::remove_file(out);
    let keygen = std::process::Command::new("age-keygen").args(["-o", key.to_str().unwrap()]).output().unwrap();
    assert!(keygen.status.success(), "age-keygen");
    let recipient = String::from_utf8(keygen.stderr).unwrap().lines().find(|l| l.contains("public key")).and_then(|l| l.split(": ").nth(1)).unwrap_or_default().to_string();
    let recipient = if recipient.is_empty() {
        // some age-keygen versions print the recipient into the key file as a comment
        std::fs::read_to_string(&key).unwrap().lines().find(|l| l.starts_with("# public key:")).and_then(|l| l.split(": ").nth(1)).unwrap().to_string()
    } else { recipient };
    let e = std::process::Command::new("age").args(["-r", recipient.trim(), "-o", enc.to_str().unwrap(), plain.to_str().unwrap()]).status().unwrap();
    assert!(e.success(), "age encrypt");
    let d = std::process::Command::new("age").args(["-d", "-i", key.to_str().unwrap(), "-o", out.to_str().unwrap(), enc.to_str().unwrap()]).status().unwrap();
    assert!(d.success(), "age decrypt");
}

async fn fund_deal(c: &GrpcClient, v: &Verified) {
    let f = v.funding.as_ref().unwrap();
    // give the funding address one mature P2PK UTXO from the bank, then genesis the covenant
    send_from_bank(c, &f.pk, AMOUNT + FR + FD + 20_000_000).await;
    let utxos = node::plain_utxos(c, &f.address).await.unwrap();
    let built = txbuild::build_fund(v, &utxos.iter().map(|u| (u.outpoint, u.amount, u.daa, u.coinbase)).collect::<Vec<_>>()).unwrap();
    submit(c, &built.tx).await;
    mine(c, &address(&pk(9)), 3).await;
}

/// Round-trip a signed money transaction through the on-disk envelope, then submit it (air-gapped
/// build → serialize → deserialize → verify_for_submit → online submit).
async fn submit_via_envelope(c: &GrpcClient, v: &Verified, built: &txbuild::Built) {
    let env = SignedTx::from_built(built, &v.network, v.product, v.deal_id);
    let json = env.to_json().unwrap();
    let reparsed = SignedTx::from_json(&json).unwrap();
    let tx = reparsed.verify_for_submit().expect("envelope re-verify");
    let rpc: kaspa_rpc_core::RpcTransaction = tx.into();
    c.submit_transaction(rpc, false).await.expect("submit reparsed envelope");
    mine(c, &address(&pk(9)), 3).await;
}

#[tokio::test]
#[ignore = "requires a running simnet kaspad on 127.0.0.1:16510"]
async fn e2e_hosted_independent_recovery() {
    let c = GrpcClient::connect(RPC.to_string()).await.expect("no simnet node on 16510 — see the header");
    setup_bank(&c).await;

    // ── Scenario A: fund → status → release (envelope round-trip); seller + fee paid ──
    let buyer = verified(Product::Escrow, Role::Buyer, 7);
    let seller_pk = pk(2);
    let fee_pk = pk(4);
    let seller_before = total(&c, &address(&seller_pk)).await;
    let fee_before = total(&c, &address(&fee_pk)).await;

    fund_deal(&c, &buyer).await;

    // status: the node must report exactly one ACTIVE covenant line with the funded amount.
    let (lines, _stray) = node::covenant_lines(&c, &buyer.active_addr, &buyer.disputed_addr).await.unwrap();
    let active: Vec<_> = lines.iter().filter(|l| l.mode == 0).collect();
    assert_eq!(active.len(), 1, "one ACTIVE covenant line after funding");
    let line = active[0];
    assert!(line.spend.prev_amount > AMOUNT, "covenant holds the funded value");

    let rel = txbuild::build_covenant(&buyer, Action::Release, 0, &line.spend).unwrap();
    submit_via_envelope(&c, &buyer, &rel).await;

    let seller_after = total(&c, &address(&seller_pk)).await;
    let fee_after = total(&c, &address(&fee_pk)).await;
    assert_eq!(seller_after - seller_before, line.spend.prev_amount - FR - 1_000_000, "seller received value minus fees");
    assert_eq!(fee_after - fee_before, FR, "service fee received");
    // the covenant is now empty
    let (after, _) = node::covenant_lines(&c, &buyer.active_addr, &buyer.disputed_addr).await.unwrap();
    assert!(after.is_empty(), "covenant spent");

    // ── Scenario D: fund → dispute → age ≥ deadline → keyless timeout → buyer gets everything ──
    let buyer2 = verified(Product::Escrow, Role::Buyer, 8);
    let buyer_pk = pk(1);
    let buyer_before = total(&c, &address(&buyer_pk)).await;
    fund_deal(&c, &buyer2).await;
    let (lines2, _) = node::covenant_lines(&c, &buyer2.active_addr, &buyer2.disputed_addr).await.unwrap();
    let active2 = lines2.iter().find(|l| l.mode == 0).expect("active line");
    // dispute (buyer) → DISPUTED
    let disp = txbuild::build_covenant(&buyer2, Action::Dispute, 0, &active2.spend).unwrap();
    submit_via_envelope(&c, &buyer2, &disp).await;
    // mine past the arbiter deadline, then keyless timeout
    mine(&c, &address(&pk(9)), (DEADLINE as u64) + 10).await;
    let (lines3, _) = node::covenant_lines(&c, &buyer2.active_addr, &buyer2.disputed_addr).await.unwrap();
    let disputed = lines3.iter().find(|l| l.mode == 1).expect("disputed line");
    let disputed_amount = disputed.spend.prev_amount;
    let to = txbuild::build_covenant(&buyer2, Action::Timeout, 1, &disputed.spend).unwrap();
    submit_via_envelope(&c, &buyer2, &to).await;
    let buyer_after = total(&c, &address(&buyer_pk)).await;
    // timeout pays the whole DISPUTED value minus only the network fee budget (no service fee).
    assert_eq!(buyer_after - buyer_before, disputed_amount - 1_000_000, "keyless timeout paid the buyer exactly");

    // ── Deposit: auto-return after the window pays the depositor (contract seller) ──
    let dep = verified(Product::Deposit, Role::Seller, 6); // depositor funds (contract seller)
    let dep_seller_before = total(&c, &address(&seller_pk)).await;
    fund_deal(&c, &dep).await;
    mine(&c, &address(&pk(9)), (WINDOW as u64) + 10).await;
    let (dlines2, _) = node::covenant_lines(&c, &dep.active_addr, &dep.disputed_addr).await.unwrap();
    let dactive2 = dlines2.iter().find(|l| l.mode == 0).expect("still active");
    let dep_amount = dactive2.spend.prev_amount;
    let ar = txbuild::build_covenant(&dep, Action::AutoRelease, 0, &dactive2.spend).unwrap();
    submit_via_envelope(&c, &dep, &ar).await;
    let seller_paid = total(&c, &address(&seller_pk)).await;
    // auto-return pays the depositor (contract seller) the value minus feeResolve and the fee budget.
    assert_eq!(seller_paid - dep_seller_before, dep_amount - FR - 1_000_000, "deposit auto-return paid the depositor exactly");

    // ── CLI chain from an encrypted backup (spec §10.5): .age → decrypt → extract → verify → prepare
    //    → offline release → submit — driving the actual dealctl binary, asserting the exact balance ──
    let cli_deal = verified(Product::Escrow, Role::Buyer, 10);
    let cli_seller_before = total(&c, &address(&seller_pk)).await;
    fund_deal(&c, &cli_deal).await;

    // Persist a Desk-shaped profile, back it up as .age, and decrypt it — exactly like a real user.
    let profile = tmp("cli_profile.json");
    let decrypted = tmp("cli_profile_decrypted.json");
    std::fs::write(&profile, profile_json(&cli_deal)).unwrap();
    age_round_trip(&profile, &decrypted);

    let rec = tmp("cli_rec.json");
    let lines = tmp("cli_lines.json");
    let rel = tmp("cli_release.tx.json");
    for p in [&rec, &lines, &rel] { let _ = std::fs::remove_file(p); }

    let watch = tmp("cli_watch.json");
    let deal_id = cli_deal.deal_id.to_string();
    assert_eq!(cli(&["extract", "--profile", decrypted.to_str().unwrap(), "--deal", &deal_id, "--output", rec.to_str().unwrap()]), 0, "extract");
    assert_eq!(cli(&["verify", "--recovery", rec.to_str().unwrap()]), 0, "verify");
    // OFFLINE watch view (no key) → ONLINE prepare from it (no key touches the online machine).
    assert_eq!(cli(&["watch", "--recovery", rec.to_str().unwrap(), "--output", watch.to_str().unwrap()]), 0, "watch");
    assert!(!std::fs::read_to_string(&watch).unwrap().contains("party_sk"), "watch file carries no secret");
    assert_eq!(cli(&["prepare", "--watch", watch.to_str().unwrap(), "--node", RPC, "--output", lines.to_str().unwrap()]), 0, "prepare");

    // Read the exact covenant amount so we can assert the precise payout.
    let (cli_lines, _) = node::covenant_lines(&c, &cli_deal.active_addr, &cli_deal.disputed_addr).await.unwrap();
    let cli_amount = cli_lines.iter().find(|l| l.mode == 0).expect("active line").spend.prev_amount;

    // Sign OFFLINE from the line package (no --node), then submit online through the CLI.
    assert_eq!(cli(&["escrow", "release", "--recovery", rec.to_str().unwrap(), "--line", lines.to_str().unwrap(), "--output", rel.to_str().unwrap()]), 0, "offline release");
    assert!(rel.exists(), "offline release produced a signed file");
    assert_eq!(cli(&["submit", "--tx", rel.to_str().unwrap(), "--node", RPC]), 0, "submit");
    mine(&c, &address(&pk(9)), 3).await;

    let cli_seller_after = total(&c, &address(&seller_pk)).await;
    assert_eq!(cli_seller_after - cli_seller_before, cli_amount - FR - 1_000_000, "CLI recovery paid the seller the exact amount");

    println!("simnet E2E: fund/status/release + dispute/timeout + deposit auto-return + .age→extract→verify→CLI backup recovery — ALL GREEN (hosted-independent)");
}
