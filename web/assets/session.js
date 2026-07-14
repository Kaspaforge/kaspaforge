// kaspa-safe/web/assets/session.js
// Sole owner of the decrypted profile and the password in memory. DOM-free → unit-testable.
// Crypto is injected (setCrypto) — WASM v6 in the browser, a fake in tests.
const KEY = 'kaspa-office-profile';
const LEGACY_WIPE = ['kaspa-safe-vaults', 'kaspa-escrow-deals', 'kaspa-safe-vault'];
const ARMOR = '-----BEGIN AGE ENCRYPTED FILE-----';
const IDLE_MS = 15 * 60 * 1000;
// Tab session (owner feedback 2026-07-09: "asked for the password too often"): the password is
// duplicated into sessionStorage so unlock survives NAVIGATION between pages of the same tab.
// Risk boundary is the same as for the decrypted profile in an open tab's memory: per-tab
// (not shared across tabs), cleared by closing the tab, by auto-lock (IDLE_MS) and by lock().
const SKEY = 'kaspa-office-session';

let _profile = null, _password = null, _crypto = null, _idleTimer = null;
const _lockCbs = [];

// sessionStorage is optional: absent in node tests — all paths silently no-op (or it is injected as a parameter)
function _sstore(s) {
  if (s !== undefined) return s;
  try { return globalThis.sessionStorage || null; } catch { return null; }
}

export function setCrypto(c) { _crypto = c; }
export function onLock(cb) { _lockCbs.push(cb); }
export function isUnlocked() { return _profile !== null; }

// v3: seed — master seed for deterministic derivation (keys of all future entities are derived
// from it, so the very first backup export also covers what is created afterwards); deriv —
// counters of the next index per domain ("vault", "deal", "listing", "chat").
function emptyProfile() { return { version: 3, seed: null, deriv: {}, wallet: null, vaults: [], deals: [], listings: [], swaps: [], chats: [], txs: [], tombstones: { clock: 0, vaults: {}, deals: {} } }; }

export function hasEncryptedProfile(storage = localStorage) {
  const v = storage.getItem(KEY);
  return typeof v === 'string' && v.trimStart().startsWith(ARMOR);
}
export function hasLegacyPlaintext(storage = localStorage) {
  const v = storage.getItem(KEY);
  if (typeof v === 'string' && v.trimStart().startsWith('{')) return true;
  return LEGACY_WIPE.some((k) => storage.getItem(k) != null);
}

function _mkWallet(net, seed) {
  if (seed && _crypto.deriveKeys) {
    const k = _crypto.deriveKeys(seed, 'wallet', 0);
    return { sk: k.sk, pk: k.pk, addr: _crypto.addr(k.pk, net) };
  }
  const k = _crypto.genKeys();
  return { sk: k.funding_sk, pk: k.funding_pk, addr: _crypto.addr(k.funding_pk, net) };
}
// Backfill a seed into profiles created before derivation existed: new entities become
// deterministic, old ones stay on their random keys (covered only by an export already made).
function _seedIfMissing(p) {
  if (!p.seed && _crypto.genSeed) {
    const s = _crypto.genSeed();   // null — a cached old core without gen_seed
    if (s) { p.seed = s; p.deriv = p.deriv || {}; p.version = 3; return true; }
  }
  if (p.seed && !p.deriv) p.deriv = {};
  return false;
}
function _persist(p, pw, storage) { storage.setItem(KEY, _crypto.encrypt(JSON.stringify(p), pw)); }
function _open(p, pw, sess) {
  _profile = p; _password = pw; _arm();
  const ss = _sstore(sess);
  if (ss) { try { ss.setItem(SKEY, pw); } catch {} }
}
function _arm() {
  if (typeof setTimeout !== 'function') return;
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(() => { lock(); _lockCbs.forEach((f) => { try { f(); } catch {} }); }, IDLE_MS);
  if (_idleTimer && typeof _idleTimer.unref === 'function') _idleTimer.unref();
}

export function onboard(password, net, storage = localStorage) {
  const seed = _crypto.genSeed ? _crypto.genSeed() : null;
  const p = { ...emptyProfile(), seed, wallet: _mkWallet(net, seed) };
  _persist(p, password, storage); _open(p, password); return p;
}
export function unlock(password, storage = localStorage) {
  const armored = storage.getItem(KEY);
  let json; try { json = _crypto.decrypt(armored, password); } catch { return false; }
  let p; try { p = JSON.parse(json); } catch { return false; }
  if (_seedIfMissing(p)) _persist(p, password, storage);   // one-time seed backfill for a pre-v3 profile
  _open(p, password); return true;
}
/// Derivation index for a domain ("vault", "deal", …) + counter bump. null = profile without a
/// seed (pre-v3, backfill not done yet) — the caller falls back to the old random-key path.
/// Does NOT persist: the counter reaches storage together with the commit() of the entity being created.
export function takeDeriv(domain) {
  const p = getProfile();
  if (!p.seed) return null;
  p.deriv = p.deriv || {};
  const index = p.deriv[domain] || 0;
  p.deriv[domain] = index + 1;
  return { seed: p.seed, index };
}
export function migrateAndEncrypt(password, net, storage = localStorage) {
  const p = { ...emptyProfile() };
  let hadUnified = false;
  try { const u = JSON.parse(storage.getItem(KEY)); if (u && Array.isArray(u.vaults)) { Object.assign(p, u, { version: 2 }); hadUnified = true; } } catch {}
  if (!hadUnified) {   // standalone legacy mirrors — only when there is NO unified profile (otherwise stale data would overwrite current)
    try { const v = JSON.parse(storage.getItem('kaspa-safe-vaults')); if (Array.isArray(v)) p.vaults = v.filter((x) => x && x.vault_addr); } catch {}
    try { const d = JSON.parse(storage.getItem('kaspa-escrow-deals')); if (Array.isArray(d)) p.deals = d.filter((x) => x && x.id != null); } catch {}
  }
  _seedIfMissing(p);
  if (!p.wallet) p.wallet = _mkWallet(net, p.seed);
  _persist(p, password, storage);                       // cipher FIRST (overwrites plaintext under KEY)
  for (const k of LEGACY_WIPE) storage.removeItem(k);   // then wipe standalone plaintext mirrors
  _open(p, password); return p;
}
export function getProfile() { if (_profile === null) throw new Error('locked'); _arm(); return _profile; }
export function commit(profile, storage = localStorage) {
  if (_password === null) throw new Error('locked');
  _profile = profile; _persist(profile, _password, storage); _arm();
}
export function confirm(password) { return _password !== null && password === _password; }
/// Silent unlock resume from the tab's sessionStorage (after navigation/reload).
/// A stale/foreign password (changed in another tab) — clean it up and honestly return false.
export function tryResume(storage = localStorage, sess) {
  const ss = _sstore(sess);
  if (!ss) return false;
  let pw = null;
  try { pw = ss.getItem(SKEY); } catch {}
  if (!pw) return false;
  if (unlock(pw, storage)) return true;
  try { ss.removeItem(SKEY); } catch {}
  return false;
}
export function exportArmored(password) {
  if (_profile === null) throw new Error('locked');
  const fn = _crypto.exportEncrypt || _crypto.encrypt;
  return fn(JSON.stringify(_profile), password);
}
// Decrypt a remote age snapshot with THIS device's in-memory password without mutating session or
// localStorage. Profile Mirror uses this before an explicit merge; a different device password
// fails closed and leaves the local profile untouched.
export function decryptArmoredCurrent(armored) {
  if (_password === null) throw new Error('locked');
  const json = _crypto.decrypt(armored, _password);
  return JSON.parse(json);
}
// Encrypt a non-mutating projection under this device's current password. Profile Mirror uses
// this to exclude independent protection keys without ever committing the redacted copy locally.
export function exportProfile(profile) {
  if (_password === null) throw new Error('locked');
  const fn = _crypto.exportEncrypt || _crypto.encrypt;
  return fn(JSON.stringify(profile), _password);
}
export function lock() {
  _profile = null; _password = null;
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
  const ss = _sstore();
  if (ss) { try { ss.removeItem(SKEY); } catch {} } // auto-lock also kills the tab session
}
export function exportCurrent() { return exportProfile(_profile); }   // export under the current session password
// Restore: adopt a decrypted profile WHOLESALE (its wallet+data) under `password`. Mirrors onboard, but the profile is given.
export function adoptProfile(profile, password, storage = localStorage) {
  _seedIfMissing(profile);   // a pre-v3 backup gets a seed right away — otherwise the profile would live without derivation until the next unlock
  _persist(profile, password, storage); _open(profile, password); return profile;
}
