// kaspa-safe/web/assets/wallet.js — unified HD balance and multi-address P2PK transfers (WASM v7).
import { core, ready } from './core7.js';
import { api, utxosRaw, utxosSum, submitTx } from './app.js?v=17';   // same ?v the pages import — otherwise a second app.js instance
// namespace import (not destructuring): identity.js without ?v may sit in the browser cache
// as an OLD version — missing getTxs/setTxs must not break the whole wallet import
import * as identity from './identity.js';
import { restoreWalletAddresses } from './restore.js';

let discoveryAt = 0;
let discoveryPromise = null;

async function discoverFundedAddresses(profile, network, force = false) {
  if (!profile || !profile.seed || !network) return 0;
  if (!force && discoveryAt && Date.now() - discoveryAt < 120000) return 0;
  if (!discoveryPromise) discoveryPromise = (async () => {
    const added = await restoreWalletAddresses(profile.seed, profile, network);
    discoveryAt = Date.now();
    if (added && identity.saveProfile) identity.saveProfile(profile);
    return added;
  })().finally(() => { discoveryPromise = null; });
  return discoveryPromise;
}

// Address discovery can take noticeably longer than a normal balance lookup. UI callers use this
// separately so a reload can paint the already-known portfolio first, then add addresses restored
// from the seed without blanking the balance while the gap scan is in flight.
export async function syncWalletAddresses(profile = identity.loadProfile(), network = null, force = false) {
  return discoverFundedAddresses(profile, network, force);
}

export async function walletBalance(addr) {
  try { return utxosSum(await utxosRaw(addr)); } catch { return 0; }
}

// The receiving address is only the current alias of one HD wallet. Funds can remain on any
// address derived from the same seed (including an address selected on another device), so every
// money operation works with this de-duplicated account set rather than profile.wallet alone.
export function walletAccounts(profile) {
  const out = [], seen = new Set();
  for (const account of [profile && profile.wallet, ...((profile && profile.walletOld) || [])]) {
    if (!account || !account.addr || !account.sk || seen.has(account.addr)) continue;
    seen.add(account.addr); out.push(account);
  }
  return out;
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

async function walletRows(profile) {
  const accounts = walletAccounts(profile);
  return Promise.all(accounts.map(async (account) => {
    const raw = await utxosRaw(account.addr);
    return { account, raw, balance: utxosSum(raw) };
  }));
}

// One plan for all derived addresses. Each source keeps its UTXO response as an opaque string so
// 64-bit sompi values reach Rust without a JSON parse/stringify round trip in JavaScript.
export async function walletPlan(profile = identity.loadProfile(), network = null, { forceDiscovery = false } = {}) {
  await ready;
  await discoverFundedAddresses(profile, network, forceDiscovery);
  const rows = await walletRows(profile);
  const funded = rows.filter((row) => row.balance > 0);
  const combined = '[' + funded.map((row) => row.raw.trim().replace(/^\[/, '').replace(/\]$/, '')).filter(Boolean).join(',') + ']';
  const fr = await feerate();
  const fee = Number(core.p2pk_fee(combined, fr));
  return {
    balance: rows.reduce((sum, row) => sum + row.balance, 0),
    fee,
    sources: funded.map((row) => ({ sk: row.account.sk, utxos_json: row.raw })),
  };
}

export async function walletPortfolioBalance(profile = identity.loadProfile(), network = null, { forceDiscovery = false, discover = true } = {}) {
  if (discover) await discoverFundedAddresses(profile, network, forceDiscovery);
  const rows = await walletRows(profile);
  return rows.reduce((sum, row) => sum + row.balance, 0);
}

// Send from the logical wallet to toAddr; every derived address signs its inputs and change returns
// to the current receiving address. wallet = the active profile wallet, used as the change target.
export async function sendFromWallet(wallet, toAddr, amountSompi, net) {
  await ready;
  let profile;
  try { profile = identity.loadProfile(); } catch { profile = { wallet, walletOld: [] }; }
  // A detached funding wallet (if one is ever passed here) must not silently spend another profile.
  if (!walletAccounts(profile).some((x) => x.addr === wallet.addr)) profile = { wallet, walletOld: [] };
  const plan = await walletPlan(profile, net);
  const built = core.build_wallet_split(JSON.stringify(plan.sources), toAddr, wallet.addr, String(amountSompi), String(plan.fee));
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
