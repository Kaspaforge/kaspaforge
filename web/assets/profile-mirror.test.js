import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMirrorIdentity, createRegistration, createSnapshot, decryptSnapshot,
  classifyMirrorState, derivedMirrorIdentity, forbiddenMirrorSecrets, manifestMessage,
  mirrorAnchorSecret, mirrorProjection, profileHash,
  requestHeaders, stableJson, unb64u, verifyHistoryChain, verifySnapshot,
} from './profile-mirror.js';

const profile = () => ({ version: 3, seed: 's'.repeat(64), wallet: { sk: 'w', addr: 'kaspa:q' }, vaults: [], deals: [] });

test('stable JSON and profile hash ignore object insertion order', async () => {
  assert.equal(stableJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
  assert.equal(await profileHash({ b: 1, a: 2 }), await profileHash({ a: 2, b: 1 }));
});

test('identity, registration and signed double-encrypted snapshot round-trip', async () => {
  const mirror = await createMirrorIdentity(100);
  assert.equal(unb64u(mirror.sync_secret).length, 32);
  assert.equal(unb64u(mirror.auth_pk).length, 32);
  const reg = await createRegistration(mirror, 101);
  assert.equal(reg.profile_id, mirror.profile_id);
  assert.equal(unb64u(reg.signature).length, 64);

  const p = { ...profile(), mirror };
  const one = await createSnapshot('-----BEGIN AGE ENCRYPTED FILE-----\none', p, mirror, null, 102);
  assert.equal(one.version, 1);
  assert.equal(one.previous_hash, null);
  assert.equal(unb64u(one.signature).length, 64);
  assert.ok(manifestMessage(one).length > 100);
  assert.equal(await decryptSnapshot(one, mirror), '-----BEGIN AGE ENCRYPTED FILE-----\none');

  const two = await createSnapshot('-----BEGIN AGE ENCRYPTED FILE-----\ntwo', p, mirror, one, 103);
  assert.equal(two.version, 2);
  assert.equal(two.previous_hash, one.blob_hash);
  assert.equal(await decryptSnapshot(two, mirror, { version: 1, blob_hash: one.blob_hash }),
    '-----BEGIN AGE ENCRYPTED FILE-----\ntwo');
});

test('tampering, rollback, fork and history gap are rejected', async () => {
  const mirror = await createMirrorIdentity(100);
  const p = { ...profile(), mirror };
  const one = await createSnapshot('AGE one', p, mirror, null, 102);
  const tampered = { ...one, ciphertext: one.ciphertext.slice(0, -1) + (one.ciphertext.endsWith('A') ? 'B' : 'A') };
  await assert.rejects(() => verifySnapshot(tampered, mirror), /hash mismatch/);
  await assert.rejects(() => verifySnapshot(one, mirror, { version: 2, blob_hash: 'f'.repeat(64) }), /rollback/);
  await assert.rejects(() => verifySnapshot(one, mirror, { version: 1, blob_hash: 'f'.repeat(64) }), /fork/);
  const four = { ...one, version: 4 };
  // Re-signing isn't available to an attacker; gap check is covered with a valid later snapshot chain.
  const two = await createSnapshot('AGE two', p, mirror, one, 103);
  const three = await createSnapshot('AGE three', p, mirror, two, 104);
  await assert.rejects(() => verifySnapshot(three, mirror, { version: 1, blob_hash: one.blob_hash }), /history gap/);
  assert.equal(four.version, 4);
});

test('alarm, heir and arbiter private fields fail closed at any depth', async () => {
  assert.deepEqual(forbiddenMirrorSecrets({ vaults: [{ alarm_sk: 'secret' }] }), ['vaults[0].alarm_sk']);
  assert.deepEqual(forbiddenMirrorSecrets({ x: { heir_sk: 'h', nested: { arbiter_sk: 'a' } } }),
    ['x.heir_sk', 'x.nested.arbiter_sk']);
  const mirror = await createMirrorIdentity();
  await assert.rejects(() => createSnapshot('AGE', { ...profile(), vaults: [{ alarm_sk: 'x' }], mirror }, mirror),
    /forbidden private key/);
});

test('mirror projection strips independent keys and then passes the fail-closed snapshot gate', async () => {
  const local = {
    seed: 'seed',
    vaults: [{ vault_addr: 'v1', hot_sk: 'hot', alarm_sk: 'alarm', nested: { heir_sk: 'heir' } }],
    deals: [{ id: 1, arbiter_sk: 'arbiter', sk: 'deal' }],
  };
  const projected = mirrorProjection(local);
  assert.equal(local.vaults[0].alarm_sk, 'alarm');
  assert.equal(projected.vaults[0].alarm_sk, undefined);
  assert.equal(projected.vaults[0].nested.heir_sk, undefined);
  assert.equal(projected.deals[0].arbiter_sk, undefined);
  assert.equal(projected.vaults[0].hot_sk, 'hot');
  assert.equal(projected.deals[0].sk, 'deal');
  const mirror = await createMirrorIdentity();
  const snapshot = await createSnapshot('AGE:projected-profile', projected, mirror);
  assert.equal(await decryptSnapshot(snapshot, mirror), 'AGE:projected-profile');
});

test('two diverged copies keep the same original-wallet Sync anchor after address rotation', () => {
  const original = { sk: '11'.repeat(32), pk: '01', addr: 'kaspa:original' };
  const pc = { wallet: original, walletOld: [] };
  const phone = {
    wallet: { sk: '22'.repeat(32), pk: '02', addr: 'kaspa:new', deriv_i: 1 },
    walletOld: [{ ...original, retired: 123 }],
  };
  assert.equal(mirrorAnchorSecret(pc), original.sk);
  assert.equal(mirrorAnchorSecret(phone), original.sk);
});

test('core-derived credentials become a deterministic WebCrypto mirror identity', async () => {
  const derive = () => JSON.stringify({
    profile_id: '01'.repeat(16), sync_secret: '02'.repeat(32),
    auth_pk: '03'.repeat(32), auth_seed: '04'.repeat(32),
  });
  const p = { wallet: { sk: '11'.repeat(32), pk: 'p', addr: 'a' }, walletOld: [] };
  const a = derivedMirrorIdentity(p, derive);
  const b = derivedMirrorIdentity(structuredClone(p), derive);
  assert.deepEqual(a, b);
  assert.equal(a.identity_mode, 'wallet-anchor-v1');
  assert.equal(unb64u(a.profile_id).length, 16);
  assert.equal(unb64u(a.sync_secret).length, 32);
  assert.equal(unb64u(a.auth_pk).length, 32);
  assert.equal(unb64u(a.auth_sk).length, 48);
  const reg = await createRegistration(a, 10);
  assert.equal(reg.profile_id, a.profile_id);
});

test('signed GET request headers are fresh and domain-separated', async () => {
  const mirror = await createMirrorIdentity();
  const h = await requestHeaders(mirror, 'GET', `/v1/profiles/${mirror.profile_id}/latest`, 1234);
  assert.equal(h['X-Forge-Time'], '1234');
  assert.equal(unb64u(h['X-Forge-Nonce']).length, 16);
  assert.equal(unb64u(h['X-Forge-Signature']).length, 64);
});

test('API sends a Turnstile token only with registration', async () => {
  const mirror = await createMirrorIdentity();
  const calls = [];
  const fetchMock = async (url, options = {}) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const { MirrorApi } = await import('./profile-mirror.js');
  const api = new MirrorApi('https://sync.test/v1', fetchMock);
  await api.register(mirror, 'captcha-token');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.turnstile_token, 'captcha-token');
  assert.equal(body.profile_id, mirror.profile_id);
});

test('API calls fetch with the browser global receiver', async () => {
  let receiver;
  function fetchMock() {
    receiver = this;
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  }
  const { MirrorApi } = await import('./profile-mirror.js');
  await new MirrorApi('https://sync.test/v1', fetchMock).health();
  assert.equal(receiver, globalThis);
});

test('state classifier never silently overwrites divergent local and remote heads', () => {
  const cp = { version: 2, blob_hash: 'b', profile_hash: 'local-old' };
  assert.equal(classifyMirrorState('local-old', { version: 2, blob_hash: 'b', profile_hash: 'local-old' }, cp).action, 'up_to_date');
  assert.equal(classifyMirrorState('local-new', { version: 2, blob_hash: 'b' }, cp).action, 'upload');
  assert.deepEqual(classifyMirrorState('local-old', { version: 3, blob_hash: 'c' }, cp), { action: 'merge_remote', conflict: false });
  assert.deepEqual(classifyMirrorState('local-new', { version: 3, blob_hash: 'c' }, cp), { action: 'merge_remote', conflict: true });
  assert.equal(classifyMirrorState('x', { version: 1, blob_hash: 'a' }, cp).action, 'security_warning');
});

test('signed metadata bridges a skipped-version checkpoint', async () => {
  const mirror = await createMirrorIdentity();
  const p = { ...profile(), mirror };
  const one = await createSnapshot('one', p, mirror, null, 1);
  const two = await createSnapshot('two', p, mirror, one, 2);
  const three = await createSnapshot('three', p, mirror, two, 3);
  const meta = (x) => ({ version: x.version, previous_hash: x.previous_hash, blob_hash: x.blob_hash,
    profile_hash: x.profile_hash, created_at: x.created_at, signature: x.signature });
  assert.equal(await verifyHistoryChain([meta(three), meta(two)], three, mirror,
    { version: 1, blob_hash: one.blob_hash }), true);
  await assert.rejects(() => verifyHistoryChain([meta(three)], three, mirror,
    { version: 1, blob_hash: one.blob_hash }), /history gap/);
});
