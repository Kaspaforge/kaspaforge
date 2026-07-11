// kaspa-safe/web/assets/wallet.js — personal wallet: balance and P2PK transfers (build_split on v6).
import { core, ready } from './core6.js';
import { api, utxosRaw, utxosSum, submitTx } from './app.js?v=14';   // same ?v the pages import — otherwise a second app.js instance + double WASM
// namespace import (not destructuring): identity.js without ?v may sit in the browser cache
// as an OLD version — missing getTxs/setTxs must not break the whole wallet import
import * as identity from './identity.js';

export async function walletBalance(addr) {
  try { return utxosSum(await utxosRaw(addr)); } catch { return 0; }
}

// node feerate (sompi/gram, getFeeEstimate via /api/safe/fee-estimate). Failure or garbage → 1
// (network minimum): the fund_fee floor inside p2pk_fee still covers a calm network with margin.
async function feerate() {
  try {
    const f = Number((await api('/api/safe/fee-estimate')).normal);
    if (f >= 1 && f < 1e6) return f;
  } catch { /* node/backend silent — work from the floor */ }
  return 1;
}

// Send plan for an address: UTXO set + balance + the EXACT fee that build_split/build_sweep
// will take for this set (single source of truth — wasm p2pk_fee).
// raw is passed on to build_*: the estimate and the build see the very same set.
export async function sendPlan(addr) {
  await ready;
  const raw = await utxosRaw(addr);
  const fr = await feerate();
  const fee = Number(core.p2pk_fee(raw, fr));
  return { raw, balance: utxosSum(raw), fee };
}

// Send amountSompi (string/number of sompi) from the wallet to toAddr; change returns to the wallet (build_split).
// wallet = {sk, addr} — the address comes from the profile (session.getProfile().wallet), NOT derived from sk client-side.
export async function sendFromWallet(wallet, toAddr, amountSompi, net) {
  await ready;
  const plan = await sendPlan(wallet.addr);
  const built = core.build_split(wallet.sk, toAddr, String(amountSompi), plan.raw, net, String(plan.fee));
  const r = await submitTx(built);
  // send journal — kept in the encrypted profile (history survives reloads — owner feedback
  // 2026-07-09); written HERE to cover all wallet spends (desk send, chat funding, funding of
  // deals/safes). Capped at 50 entries; a journal error must not fail the already-submitted transaction.
  try {
    if (identity.setTxs) identity.setTxs([{ txid: r && r.txid, to: toAddr, amount: Number(amountSompi), ts: Math.floor(Date.now() / 1000) }, ...identity.getTxs()].slice(0, 50));
  } catch { /* profile locked — skip the journal */ }
  return r;
}
export const fundTargetFromWallet = sendFromWallet; // semantic alias for creation flows
