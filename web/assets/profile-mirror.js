// Forge Profile Mirror protocol v1. DOM-free: browser WebCrypto in production, Node WebCrypto in tests.
// The server sees only signed metadata and an AES-GCM envelope around the already age-encrypted profile.

const te = new TextEncoder();
const td = new TextDecoder();
const BLOB_DOMAIN = 'ForgeMirrorBlob1';
const MANIFEST_DOMAIN = 'ForgeMirrorManifest1';
const CREATE_DOMAIN = 'ForgeMirrorCreate1';
const REQUEST_DOMAIN = 'ForgeMirrorRequest1';

function wc() {
  const c = globalThis.crypto;
  if (!c || !c.subtle) throw new Error('WebCrypto is unavailable');
  return c;
}

function bytes(...parts) {
  const arrays = parts.map((p) => p instanceof Uint8Array ? p : new Uint8Array(p));
  const out = new Uint8Array(arrays.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of arrays) { out.set(p, at); at += p.length; }
  return out;
}

export function b64u(input) {
  const a = input instanceof Uint8Array ? input : new Uint8Array(input);
  let s = '';
  for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000));
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function unb64u(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('invalid base64url');
  const raw = atob(s.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - s.length % 4) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function unhex(s) {
  if (typeof s !== 'string' || s.length % 2 || !/^[0-9a-f]+$/i.test(s)) throw new Error('invalid Forge Sync derivation');
  return Uint8Array.from(s.match(/../g), (x) => parseInt(x, 16));
}

export async function sha256Hex(input) {
  const b = input instanceof Uint8Array ? input : te.encode(String(input));
  return [...new Uint8Array(await wc().subtle.digest('SHA-256', b))]
    .map((x) => x.toString(16).padStart(2, '0')).join('');
}

// Stable across parse/merge and devices. Arrays keep order; object keys are sorted recursively.
export function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  return '{' + Object.keys(value).sort().filter((k) => value[k] !== undefined)
    .map((k) => JSON.stringify(k) + ':' + stableJson(value[k])).join(',') + '}';
}

function random(n) { const a = new Uint8Array(n); wc().getRandomValues(a); return a; }
const dash = (v) => v || '-';

export function blobAad(profileId, version, previousHash, createdAt) {
  return te.encode(`${BLOB_DOMAIN}\n${profileId}\n${version}\n${dash(previousHash)}\n${createdAt}`);
}

export function manifestMessage(m) {
  return te.encode(`${MANIFEST_DOMAIN}\n${m.profile_id}\n${m.version}\n${dash(m.previous_hash)}\n${m.blob_hash}\n${m.profile_hash}\n${m.created_at}`);
}

export function createMessage(r) {
  return te.encode(`${CREATE_DOMAIN}\n${r.profile_id}\n${r.auth_pk}\n${r.created_at}\n${r.nonce}`);
}

export function requestMessage(method, path, time, nonce) {
  return te.encode(`${REQUEST_DOMAIN}\n${method.toUpperCase()}\n${path}\n${time}\n${nonce}`);
}

async function importPrivate(mirror) {
  return wc().subtle.importKey('pkcs8', unb64u(mirror.auth_sk), { name: 'Ed25519' }, false, ['sign']);
}

async function importPublic(mirror) {
  return wc().subtle.importKey('raw', unb64u(mirror.auth_pk), { name: 'Ed25519' }, false, ['verify']);
}

async function sign(mirror, message) {
  return b64u(await wc().subtle.sign('Ed25519', await importPrivate(mirror), message));
}

export async function createMirrorIdentity(now = Math.floor(Date.now() / 1000)) {
  const kp = await wc().subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  return {
    protocol: 1,
    profile_id: b64u(random(16)),
    sync_secret: b64u(random(32)),
    auth_pk: b64u(await wc().subtle.exportKey('raw', kp.publicKey)),
    auth_sk: b64u(await wc().subtle.exportKey('pkcs8', kp.privateKey)),
    created_at: now,
  };
}

// The original Desk wallet (deriv_i absent/0) is the stable intersection of profile copies made
// before Forge Sync existed. Rotated addresses have deriv_i >= 1 and do not change this anchor.
export function mirrorAnchorSecret(profile) {
  const wallets = [profile?.wallet, ...((profile?.walletOld) || [])]
    .filter((w) => w && typeof w.sk === 'string' && /^[0-9a-f]{64}$/i.test(w.sk));
  const originals = wallets.filter((w) => w.deriv_i == null || Number(w.deriv_i) === 0);
  const pool = originals.length ? originals : wallets;
  pool.sort((a, b) => Number(a.deriv_i || 0) - Number(b.deriv_i || 0)
    || Number(a.retired || 0) - Number(b.retired || 0)
    || String(a.pk || a.addr || '').localeCompare(String(b.pk || b.addr || '')));
  if (!pool.length) throw new Error('Forge Sync needs a wallet key in this profile');
  return pool[0].sk;
}

// Convert the deterministic WASM-core output to the existing WebCrypto wire shape. PKCS#8 prefix
// is RFC 8410 PrivateKeyInfo plus the nested 32-byte Ed25519 seed OCTET STRING.
export function derivedMirrorIdentity(profile, deriveIdentity) {
  const raw = JSON.parse(deriveIdentity(mirrorAnchorSecret(profile)));
  const pkcs8 = bytes(unhex('302e020100300506032b657004220420'), unhex(raw.auth_seed));
  return {
    protocol: 1,
    identity_mode: 'wallet-anchor-v1',
    profile_id: b64u(unhex(raw.profile_id)),
    sync_secret: b64u(unhex(raw.sync_secret)),
    auth_pk: b64u(unhex(raw.auth_pk)),
    auth_sk: b64u(pkcs8),
    created_at: 0,
  };
}

export function forbiddenMirrorSecrets(profile) {
  const forbidden = new Set(['alarm_sk', 'heir_sk', 'arbiter_sk']);
  const hits = [];
  const walk = (v, path) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
    for (const [k, x] of Object.entries(v)) {
      const p = path ? `${path}.${k}` : k;
      if (forbidden.has(k) && typeof x === 'string' && x.length) hits.push(p);
      else walk(x, p);
    }
  };
  walk(profile, '');
  return hits;
}

// A mirror is deliberately not a byte-for-byte copy of the local profile. Independent protection
// keys stay on the device that holds them; everything else (including the mirror identity) keeps
// its JSON shape. The source object is never mutated.
export function mirrorProjection(profile) {
  const forbidden = new Set(['alarm_sk', 'heir_sk', 'arbiter_sk']);
  const walk = (value) => {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(walk);
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (forbidden.has(key)) continue;
      out[key] = walk(child);
    }
    return out;
  };
  return walk(profile);
}

export async function profileHash(profile) { return sha256Hex(te.encode(stableJson(profile))); }

export async function createRegistration(mirror, now = Math.floor(Date.now() / 1000)) {
  const out = {
    profile_id: mirror.profile_id,
    auth_pk: mirror.auth_pk,
    created_at: now,
    nonce: b64u(random(16)),
  };
  out.signature = await sign(mirror, createMessage(out));
  return out;
}

export async function createSnapshot(ageArmored, profile, mirror, head = null,
  now = Math.floor(Date.now() / 1000)) {
  if (!mirror || mirror.protocol !== 1) throw new Error('Forge Mirror is not enabled');
  const blocked = forbiddenMirrorSecrets(profile);
  if (blocked.length) throw new Error(`forbidden private key in profile: ${blocked.join(', ')}`);
  const version = head ? Number(head.version) + 1 : 1;
  const previous_hash = head ? head.blob_hash : null;
  const nonce = random(12);
  const key = await wc().subtle.importKey('raw', unb64u(mirror.sync_secret), 'AES-GCM', false, ['encrypt']);
  const encrypted = new Uint8Array(await wc().subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: blobAad(mirror.profile_id, version, previous_hash, now), tagLength: 128 },
    key, te.encode(ageArmored)));
  const blob = bytes(nonce, encrypted);
  const out = {
    protocol: 1,
    profile_id: mirror.profile_id,
    version,
    previous_hash,
    blob_hash: await sha256Hex(blob),
    profile_hash: await profileHash(profile),
    created_at: now,
    ciphertext: b64u(blob),
  };
  out.signature = await sign(mirror, manifestMessage(out));
  return out;
}

export async function verifyManifest(snapshot, mirror) {
  if (!snapshot || snapshot.protocol !== 1 || snapshot.profile_id !== mirror.profile_id)
    throw new Error('wrong Forge Mirror profile');
  const ok = await wc().subtle.verify('Ed25519', await importPublic(mirror),
    unb64u(snapshot.signature), manifestMessage(snapshot));
  if (!ok) throw new Error('Forge Mirror signature mismatch');
  return true;
}

export async function verifySnapshot(snapshot, mirror, checkpoint = null) {
  await verifyManifest(snapshot, mirror);
  const blob = unb64u(snapshot.ciphertext);
  if (blob.length < 12 + 16 || await sha256Hex(blob) !== snapshot.blob_hash)
    throw new Error('Forge Mirror blob hash mismatch');
  if (checkpoint) {
    if (snapshot.version < checkpoint.version) throw new Error('Forge Mirror rollback detected');
    if (snapshot.version === checkpoint.version && snapshot.blob_hash !== checkpoint.blob_hash)
      throw new Error('Forge Mirror fork detected');
    if (snapshot.version === checkpoint.version + 1 && snapshot.previous_hash !== checkpoint.blob_hash)
      throw new Error('Forge Mirror chain mismatch');
    if (snapshot.version > checkpoint.version + 1) throw new Error('Forge Mirror history gap');
  }
  return true;
}

export async function verifyHistoryChain(versions, latest, mirror, checkpoint) {
  if (!checkpoint) { await verifyManifest(latest, mirror); return true; }
  if (latest.version < checkpoint.version) throw new Error('Forge Mirror rollback detected');
  if (latest.version === checkpoint.version) {
    if (latest.blob_hash !== checkpoint.blob_hash) throw new Error('Forge Mirror fork detected');
    return true;
  }
  const chain = (versions || []).filter((v) => v.version > checkpoint.version && v.version <= latest.version)
    .sort((a, b) => a.version - b.version);
  let version = checkpoint.version, hash = checkpoint.blob_hash;
  for (const v of chain) {
    const signed = { protocol: 1, profile_id: mirror.profile_id, ...v };
    if (v.version !== version + 1 || v.previous_hash !== hash) throw new Error('Forge Mirror history gap');
    await verifyManifest(signed, mirror);
    version = v.version; hash = v.blob_hash;
  }
  if (version !== latest.version || hash !== latest.blob_hash) throw new Error('Forge Mirror history gap');
  return true;
}

export function classifyMirrorState(localProfileHash, remote, checkpoint) {
  if (!remote) return { action: 'upload_initial' };
  if (!checkpoint) return localProfileHash === remote.profile_hash
    ? { action: 'adopt_checkpoint' } : { action: 'merge_remote', conflict: true };
  if (remote.version < checkpoint.version) return { action: 'security_warning', reason: 'rollback' };
  if (remote.version === checkpoint.version && remote.blob_hash !== checkpoint.blob_hash)
    return { action: 'security_warning', reason: 'fork' };
  const localChanged = localProfileHash !== checkpoint.profile_hash;
  const remoteChanged = remote.version !== checkpoint.version || remote.blob_hash !== checkpoint.blob_hash;
  if (!localChanged && !remoteChanged) return { action: 'up_to_date' };
  if (localChanged && !remoteChanged) return { action: 'upload' };
  if (!localChanged && remoteChanged) return { action: 'merge_remote', conflict: false };
  return { action: 'merge_remote', conflict: true };
}

export async function decryptSnapshot(snapshot, mirror, checkpoint = null) {
  await verifySnapshot(snapshot, mirror, checkpoint);
  const blob = unb64u(snapshot.ciphertext);
  const key = await wc().subtle.importKey('raw', unb64u(mirror.sync_secret), 'AES-GCM', false, ['decrypt']);
  let plain;
  try {
    plain = await wc().subtle.decrypt({
      name: 'AES-GCM', iv: blob.subarray(0, 12),
      additionalData: blobAad(snapshot.profile_id, snapshot.version, snapshot.previous_hash, snapshot.created_at),
      tagLength: 128,
    }, key, blob.subarray(12));
  } catch { throw new Error('Forge Mirror ciphertext authentication failed'); }
  return td.decode(plain);
}

export async function requestHeaders(mirror, method, path, now = Date.now()) {
  const nonce = b64u(random(16));
  return {
    'X-Forge-Time': String(now),
    'X-Forge-Nonce': nonce,
    'X-Forge-Signature': await sign(mirror, requestMessage(method, path, now, nonce)),
  };
}

export class MirrorApi {
  constructor(base = 'https://sync.kaspaforge.org/v1', fetchImpl = fetch) {
    this.base = base.replace(/\/$/, '');
    // Window.fetch is a Web-IDL method: calling it as this.fetch(...) would bind `this` to
    // MirrorApi and Chromium rejects it with "Illegal invocation". Keep the real global receiver;
    // injected test functions are harmlessly bound too.
    this.fetch = fetchImpl.bind(globalThis);
  }
  async _json(r) {
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(body.error || `Forge Mirror HTTP ${r.status}`); e.status = r.status; e.body = body; throw e; }
    return body;
  }
  async health() {
    return this._json(await this.fetch(`${this.base}/health`));
  }
  async register(mirror, turnstileToken = null) {
    const registration = await createRegistration(mirror);
    if (turnstileToken) registration.turnstile_token = turnstileToken;
    return this._json(await this.fetch(`${this.base}/profiles`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(registration),
    }));
  }
  async latest(mirror) {
    const path = `/v1/profiles/${mirror.profile_id}/latest`;
    return this._json(await this.fetch(`${this.base}/profiles/${mirror.profile_id}/latest`, {
      headers: await requestHeaders(mirror, 'GET', path),
    }));
  }
  async versions(mirror) {
    const path = `/v1/profiles/${mirror.profile_id}/versions`;
    return this._json(await this.fetch(`${this.base}/profiles/${mirror.profile_id}/versions`, {
      headers: await requestHeaders(mirror, 'GET', path),
    }));
  }
  async upload(snapshot) {
    return this._json(await this.fetch(`${this.base}/profiles/${snapshot.profile_id}/snapshots`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snapshot),
    }));
  }
}
