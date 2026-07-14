import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as session from './session.js';
import { getVaults, setVaults, getDeals, setDeals, mergeProfile, parseProfileFile, passphraseStrength,
  tombstoneProfileRecord, reviveProfileRecords } from './identity.js';
import { mirrorProjection } from './profile-mirror.js';

const fakeCrypto = { encrypt: (j) => 'AGE:' + Buffer.from(j).toString('base64'),
  decrypt: (a) => Buffer.from(a.slice(4), 'base64').toString(),
  genKeys: () => ({ funding_sk: 'f'.repeat(64), funding_pk: 'p'.repeat(64) }), addr: () => 'kaspa:q' };

test('facade accessors round-trip through the unlocked session', () => {
  const m = new Map();
  global.localStorage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
  try {
    session.lock(); session.setCrypto(fakeCrypto);
    session.onboard('pw-goodenough', 'mainnet');            // uses global.localStorage
    setVaults([{ vault_addr: 'kaspa:qX', hot_sk: 'h' }]);   // identity -> session.commit
    assert.equal(getVaults()[0].vault_addr, 'kaspa:qX');    // identity -> session.getProfile (round-trip)
    setDeals([{ id: 5, sk: 'd' }]);
    assert.equal(getDeals()[0].id, 5);
    session.lock();
    assert.throws(() => getVaults(), /locked/);             // delegates lock-state to session
  } finally {
    delete global.localStorage;                             // don't leak into other test files
  }
});

test('mergeProfile: import wins on conflict, carries version 3 + wallet', () => {
  const importedWallet = { sk: 'iw-sk', pk: 'iw-pk', addr: 'kaspa:qImportedWallet' };
  const local = { version: 2, wallet: null, vaults: [{ vault_addr: 'A', hot_sk: '1' }], deals: [], listings: [], wallets: [] };
  const imported = parseProfileFile(JSON.stringify({ wallet: importedWallet, vaults: [{ vault_addr: 'A', hot_sk: '2' }, { vault_addr: 'B' }], deals: [] }));
  const merged = mergeProfile(local, imported);
  assert.equal(merged.vaults.find((v) => v.vault_addr === 'A').hot_sk, '2'); // import wins
  assert.ok(merged.vaults.find((v) => v.vault_addr === 'B'));                // local-only kept
  assert.equal(merged.version, 3);                                          // new shape (was 1/2)
  assert.deepEqual(merged.wallet, importedWallet);                          // wallet carried (local null -> imported)
});

test('mergeProfile: seed — local wins; deriv=max only when seeds match', () => {
  const base = { wallet: null, vaults: [], deals: [], listings: [], swaps: [], chats: [], txs: [] };
  // no local seed — take the imported one together with its counters
  let m = mergeProfile({ ...base }, { ...base, seed: 'S1', deriv: { vault: 2 } });
  assert.equal(m.seed, 'S1');
  assert.deepEqual(m.deriv, { vault: 2 });
  // different seeds — local wins, foreign counters are not mixed in
  m = mergeProfile({ ...base, seed: 'S1', deriv: { vault: 1 } }, { ...base, seed: 'S2', deriv: { vault: 9 } });
  assert.equal(m.seed, 'S1');
  assert.deepEqual(m.deriv, { vault: 1 });
  // same seed (older export of the same profile) — max per domain
  m = mergeProfile({ ...base, seed: 'S1', deriv: { vault: 3, deal: 1 } }, { ...base, seed: 'S1', deriv: { vault: 1, listing: 4 } });
  assert.deepEqual(m.deriv, { vault: 3, deal: 1, listing: 4 });
});

test('mergeProfile: vaults — the record with alarm_sk beats the one without (alarm card)', () => {
  const base = { wallet: null, vaults: [], deals: [], listings: [], swaps: [], chats: [], txs: [] };
  // importing a card record (no alarm_sk) must NOT clobber the key from the local legacy record
  let m = mergeProfile(
    { ...base, vaults: [{ vault_addr: 'A', hot_sk: 'h1', alarm_sk: 'ALARM' }] },
    { ...base, vaults: [{ vault_addr: 'A', hot_sk: 'h2', alarm_card: true }] });
  let v = m.vaults.find((x) => x.vault_addr === 'A');
  assert.equal(v.hot_sk, 'h2');            // other fields — import wins, as before
  assert.equal(v.alarm_sk, 'ALARM');       // but the key survived
  assert.equal(v.alarm_card, undefined);   // and the card flag is cleared — key is present
  // reverse direction: an import WITH the key enriches the local card record
  m = mergeProfile(
    { ...base, vaults: [{ vault_addr: 'A', alarm_card: true }] },
    { ...base, vaults: [{ vault_addr: 'A', alarm_sk: 'ALARM' }] });
  v = m.vaults.find((x) => x.vault_addr === 'A');
  assert.equal(v.alarm_sk, 'ALARM');
  assert.equal(v.alarm_card, undefined);
  // an unmatched card record stays a card record
  m = mergeProfile({ ...base }, { ...base, vaults: [{ vault_addr: 'B', alarm_card: true }] });
  assert.equal(m.vaults.find((x) => x.vault_addr === 'B').alarm_card, true);
});

test('mergeProfile: a mirrored projection cannot erase two local alarm keys', () => {
  const base = { wallet: null, vaults: [], deals: [], listings: [], swaps: [], chats: [], txs: [] };
  const local = { ...base, vaults: [
    { vault_addr: 'A', hot_sk: 'hot-a', alarm_sk: 'ALARM-A' },
    { vault_addr: 'B', hot_sk: 'hot-b', alarm_sk: 'ALARM-B' },
  ] };
  const remote = mirrorProjection(local);
  assert.deepEqual(remote.vaults.map((v) => v.alarm_sk), [undefined, undefined]);
  const merged = mergeProfile(local, remote);
  assert.deepEqual(merged.vaults.map((v) => v.alarm_sk), ['ALARM-A', 'ALARM-B']);
});

// walletOld: previous wallet addresses must survive a key-file import (owner-reported bug,
// 2026-07-11: mergeProfile rebuilt the profile from scratch and lost the list — "Previous
// addresses" vanished, and with them the onboarding wallet's sk if it sat in walletOld with coins).
test('mergeProfile: walletOld merges from both sides, deduped by addr', () => {
  const base = { seed: null, deriv: {}, wallet: null, vaults: [], deals: [], listings: [], swaps: [], chats: [], txs: [] };
  const w = (n) => ({ sk: `sk-${n}`, pk: `pk-${n}`, addr: `kaspa:q${n}` });
  const m = mergeProfile(
    { ...base, wallet: w('act'), walletOld: [w('a'), w('b')] },
    { ...base, wallet: w('act'), walletOld: [w('b'), w('c')] });
  assert.deepEqual(m.walletOld.map((x) => x.addr).sort(), ['kaspa:qa', 'kaspa:qb', 'kaspa:qc']);
});

test('mergeProfile: the losing wallet is not lost — it moves into walletOld', () => {
  const base = { seed: null, deriv: {}, wallet: null, vaults: [], deals: [], listings: [], swaps: [], chats: [], txs: [] };
  const localW = { sk: 'l-sk', pk: 'l-pk', addr: 'kaspa:qLocal' };
  const importedW = { sk: 'i-sk', pk: 'i-pk', addr: 'kaspa:qImported' };
  // local wins (wallet: local || imported) — the imported one must survive in walletOld
  const m = mergeProfile({ ...base, wallet: localW }, { ...base, wallet: importedW });
  assert.equal(m.wallet.addr, 'kaspa:qLocal');
  const old = m.walletOld.find((x) => x.addr === 'kaspa:qImported');
  assert.ok(old, 'imported wallet was lost');
  assert.equal(old.sk, 'i-sk');
});

test('mergeProfile: the active wallet is not duplicated into walletOld', () => {
  const base = { seed: null, deriv: {}, wallet: null, vaults: [], deals: [], listings: [], swaps: [], chats: [], txs: [] };
  const w = { sk: 's', pk: 'p', addr: 'kaspa:qSame' };
  // same wallet on both sides + also present in the file's walletOld — it must not end up in walletOld
  const m = mergeProfile({ ...base, wallet: w }, { ...base, wallet: { ...w }, walletOld: [{ ...w }] });
  assert.equal(m.wallet.addr, 'kaspa:qSame');
  assert.deepEqual(m.walletOld, []);
});

test('mergeProfile: on duplicate addr in walletOld the record with sk wins', () => {
  const base = { seed: null, deriv: {}, wallet: null, vaults: [], deals: [], listings: [], swaps: [], chats: [], txs: [] };
  const m = mergeProfile(
    { ...base, walletOld: [{ pk: 'p', addr: 'kaspa:qOld' }] },              // local record without sk
    { ...base, walletOld: [{ sk: 'SK', pk: 'p', addr: 'kaspa:qOld' }] });
  assert.equal(m.walletOld.length, 1);
  assert.equal(m.walletOld[0].sk, 'SK');
});

test('mergeProfile: the address book merges by addr, import refreshes the name', () => {
  const base = { seed: null, deriv: {}, wallet: null, vaults: [], deals: [], listings: [], swaps: [], chats: [], txs: [] };
  const m = mergeProfile(
    { ...base, contacts: [{ addr: 'kaspa:qa', name: 'Old A' }, { addr: 'kaspa:qb', name: 'B' }] },
    { ...base, contacts: [{ addr: 'kaspa:qa', name: 'New A' }, { addr: 'kaspa:qc', name: 'C' }] });
  assert.equal(m.contacts.length, 3);
  assert.equal(m.contacts.find((c) => c.addr === 'kaspa:qa').name, 'New A');
  assert.equal(m.contacts.find((c) => c.addr === 'kaspa:qc').name, 'C');
});

test('mergeProfile: a deal note survives importing an older file without the note field', () => {
  const base = { seed: null, deriv: {}, wallet: null, vaults: [], deals: [], listings: [], swaps: [], chats: [], txs: [] };
  const m = mergeProfile(
    { ...base, deals: [{ id: 7, token: 't-local', note: 'invoice 12 payment' }] },
    { ...base, deals: [{ id: 7, token: 't-imported' }, { id: 8, note: 'from the file' }] });
  const d7 = m.deals.find((x) => x.id === 7);
  assert.equal(d7.token, 't-imported');            // whole record — import wins
  assert.equal(d7.note, 'invoice 12 payment');     // but the local note survived
  assert.equal(m.deals.find((x) => x.id === 8).note, 'from the file');
  // vault note — via field-level merge (regression anchor)
  const mv = mergeProfile(
    { ...base, vaults: [{ vault_addr: 'A', note: 'vacation vault' }] },
    { ...base, vaults: [{ vault_addr: 'A', hot_pk: 'p' }] });
  assert.equal(mv.vaults[0].note, 'vacation vault');
});

test('mergeProfile: prefs travel in the file, local ones take precedence', () => {
  const base = { seed: null, deriv: {}, wallet: null, vaults: [], deals: [], listings: [], swaps: [], chats: [], txs: [] };
  const m = mergeProfile(
    { ...base, prefs: { activeVault: 'kaspa:qLocal' } },
    { ...base, prefs: { activeVault: 'kaspa:qImported', txsHide: true } });
  assert.equal(m.prefs.activeVault, 'kaspa:qLocal');   // local preference is not overridden
  assert.equal(m.prefs.txsHide, true);                 // new value from the file arrived
});

test('mergeProfile carries one mirror identity but never combines two', () => {
  const base = { version: 3, seed: 's', deriv: {}, wallet: null, vaults: [], deals: [], listings: [], swaps: [], chats: [], txs: [] };
  assert.equal(mergeProfile(base, { ...base, mirror: { profile_id: 'remote' } }).mirror.profile_id, 'remote');
  assert.equal(mergeProfile({ ...base, mirror: { profile_id: 'local' } },
    { ...base, mirror: { profile_id: 'remote' } }).mirror.profile_id, 'local');
});

test('mergeProfile: synced tombstones prevent stale vault and deal resurrection in both merge orders', () => {
  const stale = parseProfileFile(JSON.stringify({
    vaults: [{ vault_addr: 'kaspa:vault-a', hot_sk: 'hot' }],
    deals: [{ id: 17, sk: 'deal' }],
  }));
  const deleted = structuredClone(stale);
  tombstoneProfileRecord(deleted, 'vaults', 'kaspa:vault-a');
  tombstoneProfileRecord(deleted, 'deals', 17);
  const mirroredDeletion = mirrorProjection(deleted);
  assert.equal(mirroredDeletion.tombstones.vaults['kaspa:vault-a'], deleted.tombstones.vaults['kaspa:vault-a']);
  assert.equal(mirroredDeletion.tombstones.deals['17'], deleted.tombstones.deals['17']); // encrypted sync payload

  for (const merged of [mergeProfile(mirroredDeletion, stale), mergeProfile(stale, mirroredDeletion)]) {
    assert.deepEqual(merged.vaults, []);
    assert.deepEqual(merged.deals, []);
    assert.ok(merged.tombstones.vaults['kaspa:vault-a'] > 0);
    assert.ok(merged.tombstones.deals['17'] > 0);
  }
});

test('reviveProfileRecords: explicit key-file import outranks an older tombstone', () => {
  const original = parseProfileFile(JSON.stringify({
    vaults: [{ vault_addr: 'kaspa:vault-a', hot_sk: 'hot' }],
    deals: [{ id: 17, sk: 'deal' }],
  }));
  const deleted = structuredClone(original);
  tombstoneProfileRecord(deleted, 'vaults', 'kaspa:vault-a');
  tombstoneProfileRecord(deleted, 'deals', 17);

  const restored = reviveProfileRecords(mergeProfile(deleted, original), original);
  assert.equal(restored.vaults[0].vault_addr, 'kaspa:vault-a');
  assert.equal(restored.deals[0].id, 17);
  assert.equal(restored.tombstones.vaults['kaspa:vault-a'], undefined);
  assert.equal(restored.tombstones.deals['17'], undefined);

  // A device that still holds the old deletion cannot delete the explicit restore again.
  for (const merged of [mergeProfile(restored, deleted), mergeProfile(deleted, restored)]) {
    assert.equal(merged.vaults.length, 1);
    assert.equal(merged.deals.length, 1);
  }
});

test('passphraseStrength: strong ok, weak not ok', () => {
  assert.equal(passphraseStrength('aB3!xxxx').ok, true);
  assert.equal(passphraseStrength('abc').ok, false);
});
