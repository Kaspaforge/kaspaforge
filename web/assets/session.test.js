import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as session from './session.js';

// Fake crypto: "cipher" = 'AGE:' + reversible; genKeys/addr are deterministic.
const fakeCrypto = {
  encrypt: (json, pw) => 'AGE:' + pw.length + ':' + Buffer.from(json).toString('base64'),
  decrypt: (armored, pw) => {
    const [, plen, b64] = armored.split(':');
    if (Number(plen) !== pw.length) throw new Error('bad passphrase');
    return Buffer.from(b64, 'base64').toString();
  },
  genKeys: () => ({ funding_sk: 'f'.repeat(64), funding_pk: 'p'.repeat(64) }),
  addr: (pk, net) => `kaspa:${net}:${pk.slice(0, 6)}`,
  genSeed: () => 'seed01'.repeat(8) + 'seedXXXX'.slice(0, 16),
  deriveKeys: (seed, domain, i) => ({ sk: `dsk-${domain}-${i}`, pk: `dpk-${domain}-${i}` }),
};
function mkStore(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), _m: m };
}
function spyStore(init = {}) {
  const m = new Map(Object.entries(init)); const calls = [];
  return { calls,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { calls.push('set:' + k); m.set(k, v); },
    removeItem: (k) => { calls.push('rm:' + k); m.delete(k); } };
}
function fresh() { session.lock(); session.setCrypto(fakeCrypto); }

test('onboard mints seed + derived wallet, encrypts, unlocks', () => {
  fresh(); const s = mkStore();
  const p = session.onboard('pw-goodenough', 'mainnet', s);
  assert.equal(p.version, 3);
  assert.ok(p.seed);                                        // the master seed is born together with the profile
  assert.equal(p.wallet.sk, 'dsk-wallet-0');                // wallet derived from the seed, not random
  assert.equal(p.wallet.addr, 'kaspa:mainnet:dpk-wa');
  assert.ok(s.getItem('kaspa-office-profile').startsWith('AGE:'));
  assert.equal(session.isUnlocked(), true);
});

test('getProfile throws when locked', () => {
  fresh(); assert.throws(() => session.getProfile(), /locked/);
});

test('unlock: right password ok, wrong password false, no state change', () => {
  fresh(); const s = mkStore();
  session.onboard('pw-goodenough', 'mainnet', s); session.lock();
  assert.equal(session.unlock('nope', s), false);
  assert.equal(session.isUnlocked(), false);
  assert.equal(session.unlock('pw-goodenough', s), true);
  assert.equal(session.getProfile().wallet.pk, 'dpk-wallet-0');
});

test('commit re-encrypts and persists', () => {
  fresh(); const s = mkStore();
  session.onboard('pw-goodenough', 'mainnet', s);
  const p = session.getProfile(); p.vaults.push({ vault_addr: 'kaspa:q1', hot_sk: 'h' });
  session.commit(p, s);
  session.lock(); session.unlock('pw-goodenough', s);
  assert.equal(session.getProfile().vaults[0].hot_sk, 'h');
});

test('confirm is a presence check against in-memory password', () => {
  fresh(); const s = mkStore(); session.onboard('pw-goodenough', 'mainnet', s);
  assert.equal(session.confirm('pw-goodenough'), true);
  assert.equal(session.confirm('wrong'), false);
});

test('decryptArmoredCurrent reads a candidate without mutating local profile', () => {
  fresh(); const local = mkStore(); const remote = mkStore();
  session.onboard('same-password', 'mainnet', remote);
  const rp = session.getProfile(); rp.deals.push({ id: 77 }); session.commit(rp, remote);
  const candidate = remote.getItem('kaspa-office-profile');
  session.lock(); session.onboard('same-password', 'mainnet', local);
  const before = session.getProfile();
  assert.equal(session.decryptArmoredCurrent(candidate).deals[0].id, 77);
  assert.equal(session.getProfile(), before);
  assert.equal(session.getProfile().deals.length, 0);
});

test('decryptArmoredCurrent fails closed for a different password', () => {
  fresh(); const local = mkStore(); const remote = mkStore();
  session.onboard('remote-password', 'mainnet', remote);
  const candidate = remote.getItem('kaspa-office-profile');
  session.lock(); session.onboard('local-password', 'mainnet', local);
  assert.throws(() => session.decryptArmoredCurrent(candidate), /bad passphrase/);
  assert.equal(session.getProfile().deals.length, 0);
});

test('hasEncryptedProfile / hasLegacyPlaintext detection', () => {
  fresh();
  assert.equal(session.hasEncryptedProfile(mkStore({ 'kaspa-office-profile': '-----BEGIN AGE ENCRYPTED FILE-----\n…' })), true);
  assert.equal(session.hasLegacyPlaintext(mkStore({ 'kaspa-office-profile': '{"vaults":[]}' })), true);
  assert.equal(session.hasLegacyPlaintext(mkStore({ 'kaspa-safe-vaults': '[]' })), true);
  assert.equal(session.hasLegacyPlaintext(mkStore({})), false);
});

test('migrateAndEncrypt folds legacy, writes cipher FIRST then wipes plaintext', () => {
  fresh();
  const s = mkStore({
    'kaspa-safe-vaults': JSON.stringify([{ vault_addr: 'kaspa:qA', hot_pk: 'x' }]),
    'kaspa-escrow-deals': JSON.stringify([{ id: 7, sk: 'd' }]),
    'kaspa-safe-vault': '{"vault_addr":"kaspa:qA"}',
  });
  const p = session.migrateAndEncrypt('pw-goodenough', 'mainnet', s);
  assert.equal(p.vaults[0].vault_addr, 'kaspa:qA');
  assert.equal(p.deals[0].id, 7);
  assert.ok(p.wallet.addr.startsWith('kaspa:mainnet:'));
  assert.ok(s.getItem('kaspa-office-profile').startsWith('AGE:'));   // cipher written
  assert.equal(s.getItem('kaspa-safe-vaults'), null);               // plaintext wiped
  assert.equal(s.getItem('kaspa-escrow-deals'), null);
  assert.equal(s.getItem('kaspa-safe-vault'), null);
});

test('migrateAndEncrypt writes cipher BEFORE any plaintext wipe (write-order, not just end state)', () => {
  fresh();
  const s = spyStore({ 'kaspa-safe-vaults': JSON.stringify([{ vault_addr: 'kaspa:qA' }]) });
  session.migrateAndEncrypt('pw-goodenough', 'mainnet', s);
  const cipherIdx = s.calls.indexOf('set:kaspa-office-profile');
  const firstWipeIdx = s.calls.findIndex((c) => c.startsWith('rm:'));
  assert.ok(cipherIdx >= 0, 'cipher must be written');
  assert.ok(firstWipeIdx >= 0, 'a wipe must occur');
  assert.ok(cipherIdx < firstWipeIdx, 'cipher write must precede every removal');
});

test('migrateAndEncrypt prefers unified profile over stale standalone mirror', () => {
  fresh();
  const s = mkStore({
    'kaspa-office-profile': JSON.stringify({ version: 1, vaults: [{ vault_addr: 'kaspa:qU' }], deals: [{ id: 1, sk: 'x' }], listings: [] }),
    'kaspa-escrow-deals': JSON.stringify([{ id: 99, sk: 'stale' }]),
  });
  const p = session.migrateAndEncrypt('pw-goodenough', 'mainnet', s);
  assert.equal(p.version, 3);
  assert.equal(p.vaults[0].vault_addr, 'kaspa:qU');
  assert.equal(p.deals.length, 1);
  assert.equal(p.deals[0].id, 1);   // from unified profile, NOT stale mirror id 99
  assert.equal(s.getItem('kaspa-escrow-deals'), null);   // stale mirror wiped
});

test('exportArmored uses encrypt (no exportEncrypt) and throws when locked', () => {
  fresh(); const s = mkStore();
  session.onboard('pw-goodenough', 'mainnet', s);
  const armored = session.exportArmored('pw-goodenough');
  assert.ok(armored.startsWith('AGE:'));
  assert.equal(armored, fakeCrypto.encrypt(JSON.stringify(session.getProfile()), 'pw-goodenough'));
  session.lock();
  assert.throws(() => session.exportArmored('pw-goodenough'), /locked/);
});

test('adoptProfile persists+unlocks a given profile wholesale', () => {
  fresh(); const s = mkStore();
  const p = { version: 2, wallet: { sk: 'w', pk: 'wp', addr: 'kaspa:qADOPT' }, vaults: [{ vault_addr: 'V' }], deals: [], listings: [] };
  session.adoptProfile(p, 'pw-goodenough', s);
  assert.ok(s.getItem('kaspa-office-profile').startsWith('AGE:'));
  session.lock(); session.unlock('pw-goodenough', s);
  assert.equal(session.getProfile().wallet.addr, 'kaspa:qADOPT');
  assert.equal(session.getProfile().vaults[0].vault_addr, 'V');
});
test('exportCurrent returns armored of the current profile under the session password', () => {
  fresh(); const s = mkStore(); session.onboard('pw-goodenough', 'mainnet', s);
  assert.ok(session.exportCurrent().startsWith('AGE:'));
});

test('exportProfile encrypts a projection without changing the unlocked profile', () => {
  fresh(); const s = mkStore(); session.onboard('pw-goodenough', 'mainnet', s);
  const local = session.getProfile(); local.vaults.push({ vault_addr: 'v', alarm_sk: 'alarm' });
  const projected = { ...local, vaults: [{ vault_addr: 'v' }] };
  const decoded = JSON.parse(fakeCrypto.decrypt(session.exportProfile(projected), 'pw-goodenough'));
  assert.equal(decoded.vaults[0].alarm_sk, undefined);
  assert.equal(session.getProfile().vaults[0].alarm_sk, 'alarm');
});

test('tryResume unlocks silently from the tab session store', () => {
  fresh(); const s = mkStore(); const ss = mkStore();
  session.onboard('pw-goodenough', 'mainnet', s);
  // navigation: page memory is lost, but the per-tab store survives
  const savedSession = ss; // onboard wrote to globalThis.sessionStorage (absent in node) — seed it manually
  savedSession.setItem('kaspa-office-session', 'pw-goodenough');
  session.lock();                                   // lock clears memory (node: no sessionStorage — no-op)
  assert.equal(session.isUnlocked(), false);
  assert.equal(session.tryResume(s, savedSession), true);
  assert.equal(session.isUnlocked(), true);
  assert.equal(session.getProfile().version, 3);
});

test('unlock backfills the seed into a pre-v3 profile and persists it', () => {
  fresh(); const s = mkStore();
  // a v2 profile without a seed, encrypted with the same fake cipher
  const legacy = { version: 2, wallet: { sk: 'w', pk: 'wp', addr: 'kaspa:qOld' }, vaults: [], deals: [], listings: [] };
  s.setItem('kaspa-office-profile', fakeCrypto.encrypt(JSON.stringify(legacy), 'pw-goodenough'));
  assert.equal(session.unlock('pw-goodenough', s), true);
  const p = session.getProfile();
  assert.ok(p.seed);
  assert.equal(p.version, 3);
  assert.equal(p.wallet.addr, 'kaspa:qOld');                // old wallet untouched
  session.lock();                                           // did the backfill survive persist?
  session.unlock('pw-goodenough', s);
  assert.ok(session.getProfile().seed);
});

test('takeDeriv hands out sequential per-domain indices and null without a seed', () => {
  fresh(); const s = mkStore();
  session.onboard('pw-goodenough', 'mainnet', s);
  assert.deepEqual(session.takeDeriv('vault'), { seed: session.getProfile().seed, index: 0 });
  assert.equal(session.takeDeriv('vault').index, 1);
  assert.equal(session.takeDeriv('deal').index, 0);         // domains are independent
  const p = session.getProfile();
  assert.deepEqual(p.deriv, { vault: 2, deal: 1 });
  p.seed = null;                                            // profile without a seed → fallback signal
  assert.equal(session.takeDeriv('vault'), null);
});

test('tryResume with stale password cleans the session store and stays locked', () => {
  fresh(); const s = mkStore(); const ss = mkStore({ 'kaspa-office-session': 'wrong-password' });
  session.onboard('pw-goodenough', 'mainnet', s);
  session.lock();
  assert.equal(session.tryResume(s, ss), false);
  assert.equal(session.isUnlocked(), false);
  assert.equal(ss.getItem('kaspa-office-session'), null); // stale password cleaned out
});
