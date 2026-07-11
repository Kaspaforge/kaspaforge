// kaspa-safe/web/assets/identity.js
// Thin facade over session.js: same accessor names as before, but data flows through the
// unlocked crypto session (session owns the decrypted profile in memory).
import * as session from './session.js';

export function loadProfile() { return session.getProfile(); }
export function saveProfile(p) { session.commit(p); }

export function getVaults() { return loadProfile().vaults; }
export function setVaults(arr) { const p = loadProfile(); p.vaults = arr; saveProfile(p); }
export function getDeals() { return loadProfile().deals; }
export function setDeals(arr) { const p = loadProfile(); p.deals = arr; saveProfile(p); }
export function getListings() { return loadProfile().listings; }
export function setListings(arr) { const p = loadProfile(); p.listings = arr; saveProfile(p); }
// SimpleSwap swaps of the desk wallet; `|| []` — profiles created before the swaps field existed
export function getSwaps() { return loadProfile().swaps || []; }
export function setSwaps(arr) { const p = loadProfile(); p.swaps = arr; saveProfile(p); }
// listing chats (pre-deal, spec 2026-07-09-listing-chat-design.md); `|| []` — legacy profiles
export function getChats() { return loadProfile().chats || []; }
export function setChats(arr) { const p = loadProfile(); p.chats = arr; saveProfile(p); }
// wallet send journal {txid,to,amount,ts} — written by wallet.js:sendFromWallet (owner feedback
// 2026-07-09: history did not survive a page reload); rendered by desk; cap of 50 enforced by the writer
export function getTxs() { return loadProfile().txs || []; }
export function setTxs(arr) { const p = loadProfile(); p.txs = arr; saveProfile(p); }
// address book {addr, name} — recipient labels in desk history/send (decision 2026-07-11);
// `|| []` — profiles created before the contacts field existed
export function getContacts() { return loadProfile().contacts || []; }
export function setContacts(arr) { const p = loadProfile(); p.contacts = arr; saveProfile(p); }

// ── pure helpers (no state/DOM) ──
export function isEncryptedProfile(text) {
  return typeof text === 'string' && text.trimStart().startsWith('-----BEGIN AGE ENCRYPTED FILE-----');
}
export function passphraseStrength(pw) {
  pw = pw || ''; let score = 0;
  if (pw.length >= 8) score++; if (pw.length >= 16) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++; if (/\d/.test(pw)) score++;
  if (/[^\w\s]/.test(pw) || /\s/.test(pw)) score++;
  return { score, ok: score >= 3 };
}
function emptyProfile() { return { version: 3, seed: null, deriv: {}, wallet: null, vaults: [], deals: [], listings: [], swaps: [], chats: [], txs: [] }; }
export function parseProfileFile(text) {
  let p; try { p = JSON.parse(text); } catch { throw new Error('Не похоже на profile-файл (сломанный JSON)'); }
  if (!p || typeof p !== 'object' || !Array.isArray(p.vaults) || !Array.isArray(p.deals)) {
    throw new Error('Не похоже на profile-файл панели (нет vaults/deals)');
  }
  return { ...emptyProfile(), ...p };
}
function mergeByKey(local, imported, key) {
  const map = new Map();
  for (const x of local || []) if (x && x[key] != null) map.set(x[key], x);
  for (const x of imported || []) if (x && x[key] != null) map.set(x[key], x);
  return [...map.values()];
}
// Vaults merge FIELD BY FIELD (not whole-record): the "alarm card" keeps alarm_sk outside
// the profile, and a record without the key must not clobber the key from the other file —
// whoever holds alarm_sk wins; the alarm_card flag is cleared once a live key is present.
function mergeVaults(local, imported) {
  const map = new Map();
  for (const x of local || []) if (x && x.vault_addr != null) map.set(x.vault_addr, x);
  for (const x of imported || []) {
    if (!x || x.vault_addr == null) continue;
    const prev = map.get(x.vault_addr);
    const merged = prev ? { ...prev, ...x } : { ...x };
    if (!merged.alarm_sk && (prev || {}).alarm_sk) merged.alarm_sk = prev.alarm_sk;
    if (merged.alarm_sk) delete merged.alarm_card;
    map.set(x.vault_addr, merged);
  }
  return [...map.values()];
}
// Previous wallet addresses (walletOld) when merging profiles: collect BOTH lists + both
// active-wallet candidates, drop the winner (it is active, not "previous"), dedupe by
// addr — on a duplicate, the record with sk wins. Before 2026-07-11 mergeProfile rebuilt
// the profile from scratch and walletOld was lost entirely (owner-reported bug: after a
// key-file import "Previous addresses" vanished, and with them the sk of wallets not
// derived from the seed).
function mergeWalletOld(local, imported, active) {
  const map = new Map();
  for (const x of [...(local.walletOld || []), ...(imported.walletOld || []), local.wallet, imported.wallet]) {
    if (!x || !x.addr) continue;
    if (active && x.addr === active.addr) continue;
    const prev = map.get(x.addr);
    map.set(x.addr, prev && prev.sk && !x.sk ? prev : x);
  }
  return [...map.values()];
}
// Notes (the note field) must survive importing an OLD file: deals merge as whole
// records (import wins), so a record lacking the note key would clobber the local note.
// Vaults don't need this — mergeVaults merges field by field ({...prev, ...x}).
function keepNotes(merged, local, key) {
  const lm = new Map((local || []).filter((x) => x && x.note != null).map((x) => [x[key], x.note]));
  for (const m of merged) if (m.note == null && lm.has(m[key])) m.note = lm.get(m[key]);
  return merged;
}
export function mergeProfile(local, imported) {
  // seed: local wins (local entities are derived from it; imported ones arrive as
  // explicit records with their own sk — they don't need a live seed). deriv counters
  // are only meaningful relative to the chosen seed; when seeds match — max per domain.
  const seed = local.seed || imported.seed || null;
  const deriv = { ...((local.seed ? local.deriv : imported.deriv) || {}) };
  if (local.seed && imported.seed === local.seed) {
    for (const [k, v] of Object.entries(imported.deriv || {})) deriv[k] = Math.max(deriv[k] || 0, v);
  }
  const wallet = local.wallet || imported.wallet || null;
  return {
    version: 3, seed, deriv, wallet,
    walletOld: mergeWalletOld(local, imported, wallet),
    vaults: mergeVaults(local.vaults, imported.vaults),
    deals: keepNotes(mergeByKey(local.deals, imported.deals, 'id'), local.deals, 'id'),
    listings: mergeByKey(local.listings, imported.listings, 'id'),
    swaps: mergeByKey(local.swaps, imported.swaps, 'simpleswap_id'),
    chats: mergeByKey(local.chats, imported.chats, 'thread_id'),
    txs: mergeByKey(local.txs, imported.txs, 'txid'),
    contacts: mergeByKey(local.contacts, imported.contacts, 'addr'),
    // UI prefs (selected vault, history visibility): local wins — the file only
    // seeds a fresh device, it must not reshape one already in use
    prefs: { ...(imported.prefs || {}), ...(local.prefs || {}) },
  };
}
