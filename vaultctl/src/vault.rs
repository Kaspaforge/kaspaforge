// Vault core: compiling vault.sil, building spend transactions, in-memory execution in the node's VM.
// Tooling gotchas found — in spike/API-NOTES.md (version-prefixed spk, this.age = DAA, etc.).

use kaspa_consensus_core::hashing::covenant_id::covenant_id;
use kaspa_consensus_core::hashing::sighash::SigHashReusedValuesUnsync;
use kaspa_consensus_core::hashing::sighash_type::SIG_HASH_ALL;
use kaspa_consensus_core::sign::sign_input;
use kaspa_consensus_core::subnets::SUBNETWORK_ID_NATIVE;
use kaspa_consensus_core::tx::{
    CovenantBinding, PopulatedTransaction, ScriptPublicKey, Transaction, TransactionId, TransactionInput, TransactionOutpoint,
    TransactionOutput, UtxoEntry, VerifiableTransaction,
};
use kaspa_hashes::Hash;
use kaspa_txscript::caches::Cache;
use kaspa_txscript::covenants::CovenantsContext;
use kaspa_txscript::script_builder::ScriptBuilder;
use kaspa_txscript::{pay_to_script_hash_script, EngineCtx, EngineFlags, TxScriptEngine};
use kaspa_txscript_errors::TxScriptError;
use silverscript_lang::ast::Expr;
use silverscript_lang::compiler::{compile_contract, CompileOptions, CompiledContract};

pub const VAULT_SRC: &str = include_str!("../../contracts/vault.sil");
pub const FEE: u64 = 1_000_000; // default fee budget (was `constant FEE`; now a constructor param feeBudget)
pub const MODE_VAULT: i64 = 0;
pub const MODE_UNVAULTING: i64 = 1;
pub const ZERO_DEST: [u8; 36] = [0u8; 36];
pub const ZERO_HEIR: [u8; 32] = [0u8; 32];
pub const COMPUTE_BUDGET: u16 = 20; // 1 checksig = 100k script units (10 budget units); 20 = headroom for script ops
pub const MIGRATE_BUDGET: u16 = 30; // migrate is the only 2-checksig path: measured minimum = 20 (selftest probe, consensus-faithful limit); 30 = headroom

pub fn compile_vault(hot: &[u8; 32], alarm: &[u8; 32], delay: i64, heir: &[u8; 32], inherit_delay: i64, auto_inherit: i64, mode: i64, dest: &[u8; 36], fee_budget: i64) -> CompiledContract<'static> {
    let args: Vec<Expr<'static>> = vec![
        hot.to_vec().into(), alarm.to_vec().into(), delay.into(),
        heir.to_vec().into(), inherit_delay.into(), auto_inherit.into(),
        mode.into(), dest.to_vec().into(), fee_budget.into(),
    ];
    compile_contract(VAULT_SRC, &args, CompileOptions::default()).expect("compile vault.sil")
}

/// Bare P2PK script: OP_DATA_32 <pk> OP_CHECKSIG (34 bytes).
pub fn p2pk_script(pk: &[u8; 32]) -> Vec<u8> {
    let mut s = Vec::with_capacity(34);
    s.push(0x20);
    s.extend_from_slice(pk);
    s.push(0xac);
    s
}

/// Version-prefixed spk encoding of P2PK (36 bytes) — what the introspection of
/// tx.outputs[i].scriptPubKey sees and what new ScriptPubKeyP2PK generates in the contract.
pub fn p2pk_spk_encoded(pk: &[u8; 32]) -> [u8; 36] {
    let mut s = [0u8; 36];
    s[2..].copy_from_slice(&p2pk_script(pk));
    s
}

pub fn p2sh(script: &[u8]) -> ScriptPublicKey {
    pay_to_script_hash_script(script)
}

fn push_redeem(script: &[u8]) -> Vec<u8> {
    ScriptBuilder::with_flags(engine_flags()).add_data(script).expect("push redeem").drain()
}

pub fn engine_flags() -> EngineFlags {
    EngineFlags { covenants_enabled: true, ..Default::default() }
}

/// Sigscript for calling a covenant entrypoint: arguments (+selector) + push(redeem).
pub fn covenant_sigscript(compiled: &CompiledContract<'_>, function: &str, args: Vec<Expr<'_>>) -> Vec<u8> {
    let mut ss = compiled.build_sig_script(function, args).expect("build sigscript");
    ss.extend_from_slice(&push_redeem(&compiled.script));
    ss
}

/// Input signature (65 bytes: schnorr64 + sighash-type) for an argument of type `sig`.
/// sign_input returns it with the OP_DATA_65 push-opcode prefix — we strip it.
pub fn input_signature(tx: &impl VerifiableTransaction, input_index: usize, privkey: &[u8; 32]) -> Vec<u8> {
    let with_push = sign_input(tx, input_index, privkey, SIG_HASH_ALL);
    with_push[1..].to_vec()
}

/// Genesis covenant_id for the funding transaction (authorizing input, single covenant output out_idx).
pub fn genesis_covenant_id(funding_outpoint: TransactionOutpoint, out_idx: u32, output: &TransactionOutput) -> Hash {
    covenant_id(funding_outpoint, [(out_idx, output)].into_iter())
}

/// Execute input_idx of the transaction in the node's VM (Toccata flags) — as consensus will,
/// INCLUDING the committed compute-budget limit (tx_validation_in_utxo_context.rs derives the
/// script-units limit from input.compute_commit — a plain from_transaction_input would not).
pub fn execute_input(tx: &Transaction, entries: Vec<UtxoEntry>, input_idx: usize) -> Result<(), TxScriptError> {
    let reused = SigHashReusedValuesUnsync::new();
    let sig_cache = Cache::new(10_000);
    let input = tx.inputs[input_idx].clone();
    let populated = PopulatedTransaction::new(tx, entries);
    let cov_ctx = CovenantsContext::from_tx(&populated).map_err(TxScriptError::from)?;
    let utxo = populated.utxo(input_idx).expect("utxo");
    let script_units_limit = input.compute_commit.allowed_script_units();
    let mut vm = TxScriptEngine::from_transaction_input_with_script_units_limit(
        &populated,
        &input,
        input_idx,
        utxo,
        EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx),
        engine_flags(),
        script_units_limit,
    );
    vm.execute()
}

pub struct SpendSpec {
    pub prev_outpoint: TransactionOutpoint,
    pub prev_entry: UtxoEntry,
    pub sequence: u64,
    pub output: TransactionOutput,
}

/// Build a single-input v1 transition transaction (sigscript is set later).
pub fn build_spend_tx(spec: &SpendSpec) -> Transaction {
    build_spend_tx_budget(spec, COMPUTE_BUDGET)
}

/// Same, with an explicit per-input compute budget (migrate needs MIGRATE_BUDGET: two checksigs).
pub fn build_spend_tx_budget(spec: &SpendSpec, budget: u16) -> Transaction {
    Transaction::new(
        1,
        vec![TransactionInput::new_with_compute_budget(spec.prev_outpoint, vec![], spec.sequence, budget)],
        vec![spec.output.clone()],
        0,
        SUBNETWORK_ID_NATIVE,
        0,
        vec![],
    )
}

// ---------- In-memory selftest (Task 4): three paths + negatives, node's VM ----------

pub fn selftest() {
    use secp256k1::{Keypair, Secp256k1, SecretKey};
    let secp = Secp256k1::new();
    let key = |b: u8| {
        let kp = Keypair::from_secret_key(&secp, &SecretKey::from_slice(&[b; 32]).unwrap());
        let (x, _) = kp.x_only_public_key();
        ([b; 32], x.serialize())
    };
    let (hot_sk, hot_pk) = key(1);
    let (alarm_sk, alarm_pk) = key(2);
    let (_, dest_pk) = key(3);
    let (heir_sk, heir_pk) = key(4);

    let delay: i64 = 60;
    let inherit_delay: i64 = 500;
    let cov_id = Hash::from_bytes(*b"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    let vault_c = compile_vault(&hot_pk, &alarm_pk, delay, &heir_pk, inherit_delay, 1, MODE_VAULT, &ZERO_DEST, FEE as i64);
    let dest_spk = p2pk_spk_encoded(&dest_pk);
    let unvault_c = compile_vault(&hot_pk, &alarm_pk, delay, &heir_pk, inherit_delay, 1, MODE_UNVAULTING, &dest_spk, FEE as i64);
    println!("vault script {} B, unvault script {} B", vault_c.script.len(), unvault_c.script.len());

    let amount: u64 = 10_000_000_000; // 100 KAS
    let mut pass = 0;
    let mut fail = 0;
    let mut check = |name: &str, expect_ok: bool, res: Result<(), TxScriptError>| {
        let ok = res.is_ok() == expect_ok;
        println!(
            "  [{}] {name} -> {}",
            if ok { "PASS" } else { "FAIL" },
            res.err().map(|e: TxScriptError| e.to_string()).unwrap_or_else(|| "Ok".into())
        );
        if ok {
            pass += 1
        } else {
            fail += 1
        }
    };

    let vault_utxo = |daa| UtxoEntry::new(amount, p2sh(&vault_c.script), daa, false, Some(cov_id));
    let unvault_utxo = |daa| UtxoEntry::new(amount - FEE, p2sh(&unvault_c.script), daa, false, Some(cov_id));
    let outpoint = |b: u8| TransactionOutpoint::new(TransactionId::from_bytes([b; 32]), 0);

    // --- Path 1: initiate (VAULT -> UNVAULTING) ---
    {
        let spec = SpendSpec {
            prev_outpoint: outpoint(0x11),
            prev_entry: vault_utxo(0),
            sequence: 0,
            output: TransactionOutput::with_covenant(
                amount - FEE,
                p2sh(&unvault_c.script),
                Some(CovenantBinding { authorizing_input: 0, covenant_id: cov_id }),
            ),
        };
        let mut tx = build_spend_tx(&spec);
        let entries = vec![spec.prev_entry.clone()];
        let sig = input_signature(&PopulatedTransaction::new(&tx, entries.clone()), 0, &hot_sk);
        tx.inputs[0].signature_script = covenant_sigscript(&vault_c, "initiate", vec![sig.into(), dest_pk.to_vec().into()]);
        check("initiate: hot key, valid transition", true, execute_input(&tx, entries.clone(), 0));

        // negative: signed with the wrong (alarm) key
        let sig_bad = input_signature(&PopulatedTransaction::new(&build_spend_tx(&spec), entries.clone()), 0, &alarm_sk);
        let mut tx_bad = build_spend_tx(&spec);
        tx_bad.inputs[0].signature_script =
            covenant_sigscript(&vault_c, "initiate", vec![sig_bad.into(), dest_pk.to_vec().into()]);
        check("initiate: foreign key rejected", false, execute_input(&tx_bad, entries.clone(), 0));

        // negative: initiate diverts funds past the covenant (output = bare P2PK of the thief)
        let spec_steal = SpendSpec {
            prev_outpoint: outpoint(0x11),
            prev_entry: vault_utxo(0),
            sequence: 0,
            output: TransactionOutput::new(amount - FEE, ScriptPublicKey::new(0, p2pk_script(&dest_pk).into())),
        };
        let mut tx_steal = build_spend_tx(&spec_steal);
        let sig_s = input_signature(&PopulatedTransaction::new(&build_spend_tx(&spec_steal), vec![vault_utxo(0)]), 0, &hot_sk);
        tx_steal.inputs[0].signature_script =
            covenant_sigscript(&vault_c, "initiate", vec![sig_s.into(), dest_pk.to_vec().into()]);
        check("initiate: diversion past the covenant rejected", false, execute_input(&tx_steal, vec![vault_utxo(0)], 0));
    }

    // --- Path 2: cancel (UNVAULTING -> VAULT, dest reset to zeros), at any time ---
    {
        let spec = SpendSpec {
            prev_outpoint: outpoint(0x22),
            prev_entry: unvault_utxo(0),
            sequence: 0,
            output: TransactionOutput::with_covenant(
                amount - 2 * FEE,
                p2sh(&vault_c.script), // canonical vault: state {0, zeros}
                Some(CovenantBinding { authorizing_input: 0, covenant_id: cov_id }),
            ),
        };
        let mut tx = build_spend_tx(&spec);
        let entries = vec![spec.prev_entry.clone()];
        let sig = input_signature(&PopulatedTransaction::new(&tx, entries.clone()), 0, &alarm_sk);
        tx.inputs[0].signature_script = covenant_sigscript(&unvault_c, "cancel", vec![sig.into()]);
        check("cancel: alarm key returns to the vault", true, execute_input(&tx, entries.clone(), 0));

        // negative: cancel with the hot key (stolen)
        let sig_bad = input_signature(&PopulatedTransaction::new(&build_spend_tx(&spec), entries.clone()), 0, &hot_sk);
        let mut tx_bad = build_spend_tx(&spec);
        tx_bad.inputs[0].signature_script = covenant_sigscript(&unvault_c, "cancel", vec![sig_bad.into()]);
        check("cancel: hot key CANNOT cancel", false, execute_input(&tx_bad, entries.clone(), 0));
    }

    // --- Path 3: complete (UNVAULTING -> dest) after the timelock ---
    {
        let dest_out = TransactionOutput::new(amount - 2 * FEE, ScriptPublicKey::new(0, p2pk_script(&dest_pk).into()));
        let spec = SpendSpec {
            prev_outpoint: outpoint(0x33),
            prev_entry: unvault_utxo(0),
            sequence: delay as u64, // claim age >= delay (consensus checks against the real UTXO age)
            output: dest_out.clone(),
        };
        let mut tx = build_spend_tx(&spec);
        let entries = vec![spec.prev_entry.clone()];
        tx.inputs[0].signature_script = covenant_sigscript(&unvault_c, "complete", vec![]);
        check("complete: after the timelock to dest", true, execute_input(&tx, entries.clone(), 0));

        // negative: complete BEFORE the timelock (sequence < delay)
        let spec_early =
            SpendSpec { prev_outpoint: outpoint(0x33), prev_entry: unvault_utxo(0), sequence: 10, output: dest_out.clone() };
        let mut tx_early = build_spend_tx(&spec_early);
        tx_early.inputs[0].signature_script = covenant_sigscript(&unvault_c, "complete", vec![]);
        check("complete: BEFORE the timelock rejected", false, execute_input(&tx_early, entries.clone(), 0));

        // negative: complete to the WRONG address (not the dest from state)
        let (_, thief_pk) = key(9);
        let spec_thief = SpendSpec {
            prev_outpoint: outpoint(0x33),
            prev_entry: unvault_utxo(0),
            sequence: delay as u64,
            output: TransactionOutput::new(amount - 2 * FEE, ScriptPublicKey::new(0, p2pk_script(&thief_pk).into())),
        };
        let mut tx_thief = build_spend_tx(&spec_thief);
        tx_thief.inputs[0].signature_script = covenant_sigscript(&unvault_c, "complete", vec![]);
        check("complete: to a foreign address rejected", false, execute_input(&tx_thief, entries.clone(), 0));
    }

    // --- Path 4: checkin (VAULT -> VAULT, age reset) ---
    {
        let spec = SpendSpec {
            prev_outpoint: outpoint(0x44),
            prev_entry: vault_utxo(0),
            sequence: 0,
            output: TransactionOutput::with_covenant(
                amount - FEE,
                p2sh(&vault_c.script),
                Some(CovenantBinding { authorizing_input: 0, covenant_id: cov_id }),
            ),
        };
        let mut tx = build_spend_tx(&spec);
        let entries = vec![spec.prev_entry.clone()];
        let sig = input_signature(&PopulatedTransaction::new(&tx, entries.clone()), 0, &hot_sk);
        tx.inputs[0].signature_script = covenant_sigscript(&vault_c, "checkin", vec![sig.into()]);
        check("checkin: hot key recreates the vault", true, execute_input(&tx, entries.clone(), 0));

        let sig_bad = input_signature(&PopulatedTransaction::new(&build_spend_tx(&spec), entries.clone()), 0, &alarm_sk);
        let mut tx_bad = build_spend_tx(&spec);
        tx_bad.inputs[0].signature_script = covenant_sigscript(&vault_c, "checkin", vec![sig_bad.into()]);
        check("checkin: foreign key rejected", false, execute_input(&tx_bad, entries.clone(), 0));
    }

    // --- Path 5a: inheritAuto (VAULT -> heir WITHOUT signature, after inheritDelay; autoInherit=1) ---
    {
        let heir_out = TransactionOutput::new(amount - FEE, ScriptPublicKey::new(0, p2pk_script(&heir_pk).into()));
        let spec = SpendSpec { prev_outpoint: outpoint(0x55), prev_entry: vault_utxo(0), sequence: inherit_delay as u64, output: heir_out.clone() };
        let mut tx = build_spend_tx(&spec);
        let entries = vec![spec.prev_entry.clone()];
        tx.inputs[0].signature_script = covenant_sigscript(&vault_c, "inheritAuto", vec![]);
        check("inheritAuto: heir after the deadline (no signature)", true, execute_input(&tx, entries.clone(), 0));

        // before the deadline
        let spec_early = SpendSpec { prev_outpoint: outpoint(0x55), prev_entry: vault_utxo(0), sequence: 100, output: heir_out.clone() };
        let mut tx_early = build_spend_tx(&spec_early);
        tx_early.inputs[0].signature_script = covenant_sigscript(&vault_c, "inheritAuto", vec![]);
        check("inheritAuto: BEFORE the deadline rejected", false, execute_input(&tx_early, entries.clone(), 0));

        // to the wrong address
        let spec_thief = SpendSpec { prev_outpoint: outpoint(0x55), prev_entry: vault_utxo(0), sequence: inherit_delay as u64,
            output: TransactionOutput::new(amount - FEE, ScriptPublicKey::new(0, p2pk_script(&dest_pk).into())) };
        let mut tx_thief = build_spend_tx(&spec_thief);
        tx_thief.inputs[0].signature_script = covenant_sigscript(&vault_c, "inheritAuto", vec![]);
        check("inheritAuto: to a foreign address rejected", false, execute_input(&tx_thief, entries.clone(), 0));

        // signed path on an auto-vault (autoInherit=1) must be dead
        let sig_s = input_signature(&PopulatedTransaction::new(&build_spend_tx(&spec), entries.clone()), 0, &heir_sk);
        let mut tx_signed = build_spend_tx(&spec);
        tx_signed.inputs[0].signature_script = covenant_sigscript(&vault_c, "inheritSigned", vec![sig_s.into()]);
        check("inheritSigned: on an auto-vault rejected", false, execute_input(&tx_signed, entries.clone(), 0));

        // heir=zeros → auto path is dead
        let vault_noheir = compile_vault(&hot_pk, &alarm_pk, delay, &ZERO_HEIR, inherit_delay, 1, MODE_VAULT, &ZERO_DEST, FEE as i64);
        let spec_off = SpendSpec { prev_outpoint: outpoint(0x66),
            prev_entry: UtxoEntry::new(amount, p2sh(&vault_noheir.script), 0, false, Some(cov_id)),
            sequence: inherit_delay as u64,
            output: TransactionOutput::new(amount - FEE, ScriptPublicKey::new(0, p2pk_script(&ZERO_HEIR).into())) };
        let mut tx_off = build_spend_tx(&spec_off);
        let entries_off = vec![spec_off.prev_entry.clone()];
        tx_off.inputs[0].signature_script = covenant_sigscript(&vault_noheir, "inheritAuto", vec![]);
        check("inheritAuto: heir=zeros — path is dead", false, execute_input(&tx_off, entries_off.clone(), 0));
    }

    // --- Path 5b: inheritSigned (heir's signature required; autoInherit=0) ---
    {
        let vault_signed = compile_vault(&hot_pk, &alarm_pk, delay, &heir_pk, inherit_delay, 0, MODE_VAULT, &ZERO_DEST, FEE as i64);
        let su = |daa| UtxoEntry::new(amount, p2sh(&vault_signed.script), daa, false, Some(cov_id));
        let heir_out = TransactionOutput::new(amount - FEE, ScriptPublicKey::new(0, p2pk_script(&heir_pk).into()));
        let spec = SpendSpec { prev_outpoint: outpoint(0x77), prev_entry: su(0), sequence: inherit_delay as u64, output: heir_out.clone() };
        let entries = vec![spec.prev_entry.clone()];
        let mut tx = build_spend_tx(&spec);
        let sig = input_signature(&PopulatedTransaction::new(&build_spend_tx(&spec), entries.clone()), 0, &heir_sk);
        tx.inputs[0].signature_script = covenant_sigscript(&vault_signed, "inheritSigned", vec![sig.into()]);
        check("inheritSigned: heir by signature after the deadline", true, execute_input(&tx, entries.clone(), 0));

        // wrong signature
        let sig_bad = input_signature(&PopulatedTransaction::new(&build_spend_tx(&spec), entries.clone()), 0, &hot_sk);
        let mut tx_bad = build_spend_tx(&spec);
        tx_bad.inputs[0].signature_script = covenant_sigscript(&vault_signed, "inheritSigned", vec![sig_bad.into()]);
        check("inheritSigned: foreign signature rejected", false, execute_input(&tx_bad, entries.clone(), 0));

        // auto path on a signed-vault (autoInherit=0) must be dead
        let mut tx_auto = build_spend_tx(&spec);
        tx_auto.inputs[0].signature_script = covenant_sigscript(&vault_signed, "inheritAuto", vec![]);
        check("inheritAuto: on a signed-vault rejected", false, execute_input(&tx_auto, entries.clone(), 0));
    }

    // --- Path 6: migrate (both signatures = full owner authority; outputs are FREE; both modes) ---
    {
        // free output: bare P2PK of an arbitrary destination — the contract does not constrain outputs
        let free_out = TransactionOutput::new(amount - FEE, ScriptPublicKey::new(0, p2pk_script(&dest_pk).into()));
        let spec = SpendSpec { prev_outpoint: outpoint(0x88), prev_entry: vault_utxo(0), sequence: 0, output: free_out.clone() };
        let entries = vec![spec.prev_entry.clone()];
        let mut tx = build_spend_tx_budget(&spec, MIGRATE_BUDGET);
        let s_hot = input_signature(&PopulatedTransaction::new(&tx, entries.clone()), 0, &hot_sk);
        let s_alarm = input_signature(&PopulatedTransaction::new(&tx, entries.clone()), 0, &alarm_sk);
        tx.inputs[0].signature_script =
            covenant_sigscript(&vault_c, "migrate", vec![s_hot.clone().into(), s_alarm.clone().into()]);
        check("migrate: both keys, free output from VAULT", true, execute_input(&tx, entries.clone(), 0));

        // from UNVAULTING too — a mid-withdrawal rescue
        let spec_u = SpendSpec {
            prev_outpoint: outpoint(0x89),
            prev_entry: unvault_utxo(0),
            sequence: 0,
            output: TransactionOutput::new(amount - 2 * FEE, ScriptPublicKey::new(0, p2pk_script(&dest_pk).into())),
        };
        let entries_u = vec![spec_u.prev_entry.clone()];
        let mut tx_u = build_spend_tx_budget(&spec_u, MIGRATE_BUDGET);
        let su_hot = input_signature(&PopulatedTransaction::new(&tx_u, entries_u.clone()), 0, &hot_sk);
        let su_alarm = input_signature(&PopulatedTransaction::new(&tx_u, entries_u.clone()), 0, &alarm_sk);
        tx_u.inputs[0].signature_script = covenant_sigscript(&unvault_c, "migrate", vec![su_hot.into(), su_alarm.into()]);
        check("migrate: from UNVAULTING (mid-withdrawal rescue)", true, execute_input(&tx_u, entries_u.clone(), 0));

        // one key alone must not pass (hot in both argument slots / alarm in both)
        let mut tx_hot2 = build_spend_tx_budget(&spec, MIGRATE_BUDGET);
        tx_hot2.inputs[0].signature_script =
            covenant_sigscript(&vault_c, "migrate", vec![s_hot.clone().into(), s_hot.clone().into()]);
        check("migrate: hot key alone rejected", false, execute_input(&tx_hot2, entries.clone(), 0));

        let mut tx_alarm2 = build_spend_tx_budget(&spec, MIGRATE_BUDGET);
        tx_alarm2.inputs[0].signature_script =
            covenant_sigscript(&vault_c, "migrate", vec![s_alarm.clone().into(), s_alarm.clone().into()]);
        check("migrate: alarm key alone rejected", false, execute_input(&tx_alarm2, entries.clone(), 0));

        // foreign second signature (hot + heir instead of alarm)
        let mut tx_foreign = build_spend_tx_budget(&spec, MIGRATE_BUDGET);
        let s_heir = input_signature(&PopulatedTransaction::new(&tx_foreign, entries.clone()), 0, &heir_sk);
        tx_foreign.inputs[0].signature_script =
            covenant_sigscript(&vault_c, "migrate", vec![s_hot.clone().into(), s_heir.into()]);
        check("migrate: foreign second signature rejected", false, execute_input(&tx_foreign, entries.clone(), 0));

        // two inputs rejected (single-input invariant, multi-UTXO anti-siphon)
        let mut tx_two = Transaction::new(
            1,
            vec![
                TransactionInput::new_with_compute_budget(outpoint(0x8A), vec![], 0, MIGRATE_BUDGET),
                TransactionInput::new_with_compute_budget(outpoint(0x8B), vec![], 0, MIGRATE_BUDGET),
            ],
            vec![free_out.clone()],
            0,
            SUBNETWORK_ID_NATIVE,
            0,
            vec![],
        );
        let entries_two = vec![vault_utxo(0), vault_utxo(0)];
        let t_hot = input_signature(&PopulatedTransaction::new(&tx_two, entries_two.clone()), 0, &hot_sk);
        let t_alarm = input_signature(&PopulatedTransaction::new(&tx_two, entries_two.clone()), 0, &alarm_sk);
        tx_two.inputs[0].signature_script = covenant_sigscript(&vault_c, "migrate", vec![t_hot.into(), t_alarm.into()]);
        check("migrate: two inputs rejected (single-input invariant)", false, execute_input(&tx_two, entries_two, 0));

        // committed compute budget is enforced (execute_input carries the consensus limit):
        // measured minimum for 2 checksigs = 20; below it the VM must reject
        let mut tx_low = build_spend_tx_budget(&spec, 19);
        let l_hot = input_signature(&PopulatedTransaction::new(&tx_low, entries.clone()), 0, &hot_sk);
        let l_alarm = input_signature(&PopulatedTransaction::new(&tx_low, entries.clone()), 0, &alarm_sk);
        tx_low.inputs[0].signature_script = covenant_sigscript(&vault_c, "migrate", vec![l_hot.into(), l_alarm.into()]);
        check("migrate: budget below measured minimum (19 < 20) rejected", false, execute_input(&tx_low, entries.clone(), 0));
    }

    println!("selftest: {pass} PASS, {fail} FAIL");
    if fail > 0 {
        std::process::exit(1);
    }
}
