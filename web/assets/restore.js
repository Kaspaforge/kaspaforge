// kaspa-safe/web/assets/restore.js
// Restore profile records from the master seed (profile v3): when importing an old backup the
// desk derives candidates (pk, owner token) per index in each domain and asks the server which
// of them exist (POST /api/safe/restore/scan + token endpoints). Private keys do NOT leave the
// browser — the server only sees pk's and owner tokens (which it already has anyway).
// Gap-scan: a domain is finished once GAP consecutive indices are empty (holes come from regen/cancelled flows).
import { core, ready as coreReady } from './core7.js';

const GAP = 12;      // consecutive empty indices = end of domain
const BATCH = 16;    // candidates per request (server caps at 64)
const MAX_IDX = 512; // hard ceiling per domain — guards against an endless loop

const dk = (seed, dom, i) => JSON.parse(core.derive_keys(seed, dom, i));
const dt = (seed, dom, i) => core.derive_token(seed, dom, i);
const dchat = (seed, dom, i) => JSON.parse(core.derive_chat_keys(seed, dom, i));

/** Generic gap-scan: probe(indices) -> Map(index -> found item). Exported for unit tests. */
export async function scanDomain(probe, { gap = GAP, batch = BATCH, max = MAX_IDX } = {}) {
  const found = new Map();
  let from = 0, silent = 0;
  while (from < max && silent < gap) {
    const idx = Array.from({ length: batch }, (_, k) => from + k);
    const hits = await probe(idx);
    for (const i of idx) {
      if (hits.has(i)) { found.set(i, hits.get(i)); silent = 0; }
      else silent++;
    }
    from += batch;
  }
  return found;
}

async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('restore: HTTP ' + r.status);
  return r.json();
}

/**
 * Scan a single seed: what exists on the server among the derived candidates.
 * Returns {vaults, deals, listings, chats, maxIdx} — "raw" findings with their indices.
 */
async function scanSeed(seed) {
  await coreReady;
  const maxIdx = { vault: -1, deal: -1, listing: -1, chat: -1 };

  // vault + deal + chat — via a single scan endpoint (responses are matched back to indices by pk)
  const scanKind = (kind, mkCand, matchKey) => scanDomain(async (idx) => {
    const cands = idx.map((i) => mkCand(i));
    const resp = await post('/api/safe/restore/scan', { [kind]: cands.map(({ i, ...c }) => c) });
    const hits = new Map();
    for (const row of resp[kind] || []) {
      const c = cands.find((x) => matchKey(x) === matchKey(row));
      if (c) hits.set(c.i, { ...row, deriv_i: c.i, token: c.token });
    }
    return hits;
  });

  const vaults = await scanKind('vaults',
    (i) => ({ i, pk: dk(seed, 'vault/hot', i).pk, token: dt(seed, 'vault', i) }),
    (x) => x.pk || x.hot_pk);
  const deals = await scanKind('deals',
    (i) => ({ i, pk: dk(seed, 'deal/key', i).pk, token: dt(seed, 'deal', i) }),
    (x) => x.pk);
  // chats: the server accepts an array of TOKENS (looks up by hash); match responses by buyer_chat_pk
  const chats = await scanDomain(async (idx) => {
    const cands = idx.map((i) => ({ i, pk: dchat(seed, 'chat/key', i).pk, token: dt(seed, 'chat', i) }));
    const resp = await post('/api/safe/restore/scan', { chats: cands.map((c) => c.token) });
    const hits = new Map();
    for (const row of resp.chats || []) {
      const c = cands.find((x) => x.pk === row.buyer_chat_pk);
      if (c) hits.set(c.i, { ...row, deriv_i: c.i, token: c.token });
    }
    return hits;
  });

  // listings — via the existing /mine token endpoint (returns the full listing_json)
  const listings = await scanDomain(async (idx) => {
    const hits = new Map();
    await Promise.all(idx.map(async (i) => {
      const token = dt(seed, 'listing', i);
      const r = await fetch('/api/safe/listings/mine?token=' + encodeURIComponent(token));
      if (!r.ok) return;
      const rows = await r.json();
      if (Array.isArray(rows) && rows.length) hits.set(i, rows.map((x) => ({ ...x, deriv_i: i, token })));
    }));
    return hits;
  });

  for (const [i] of vaults) maxIdx.vault = Math.max(maxIdx.vault, i);
  for (const [i] of deals) maxIdx.deal = Math.max(maxIdx.deal, i);
  for (const [i] of chats) maxIdx.chat = Math.max(maxIdx.chat, i);
  for (const [i] of listings) maxIdx.listing = Math.max(maxIdx.listing, i);
  return { seed, vaults, deals, listings, chats, maxIdx };
}

/**
 * Scan wallet addresses (wallet/0..N from the seed): an address holding coins that is missing
 * from the profile is returned as a walletOld candidate. The server knows only addresses; keys are derived locally.
 * Gap is shorter than the general one: an address without UTXOs is indistinguishable from an unused one, so we only catch funds.
 */
async function scanWalletAddrs(seed, network, knownPks) {
  const found = await scanDomain(async (idx) => {
    const hits = new Map();
    await Promise.all(idx.map(async (i) => {
      const k = dk(seed, 'wallet', i);
      // Known derived indices are not "empty gaps": count them as occupied so scanning continues
      // beyond this device's last address and can find a newer address selected on another device.
      if (knownPks.has(k.pk)) { hits.set(i, { known: true, deriv_i: i }); return; }
      const addr = core.pubkey_to_address(k.pk, network);
      const r = await fetch('/api/safe/utxos?address=' + encodeURIComponent(addr));
      if (!r.ok) return;
      const utxos = await r.json();
      if (Array.isArray(utxos) && utxos.length) hits.set(i, { sk: k.sk, pk: k.pk, addr, deriv_i: i });
    }));
    return hits;
  }, { gap: 8, batch: 8, max: 128 });
  return found;
}

/** Discover funded wallet addresses derived from seed and merge them into the logical wallet. */
export async function restoreWalletAddresses(seed, profile, network) {
  await coreReady;
  const knownPks = new Set([profile.wallet && profile.wallet.pk,
    ...(profile.walletOld || []).map((x) => x.pk)].filter(Boolean));
  let added = 0;
  for (const [i, w] of await scanWalletAddrs(seed, network, knownPks)) {
    if (w.known) continue;
    profile.walletOld = profile.walletOld || [];
    profile.walletOld.push({ ...w, restored: true });
    knownPks.add(w.pk);
    profile.deriv = profile.deriv || {};
    profile.deriv.wallet = Math.max(profile.deriv.wallet || 0, i + 1);
    added++;
  }
  return added;
}

/**
 * Restore missing profile records from the server for the given seeds (usually [seed of the
 * imported file]). MUTATES profile (adds records + bumps deriv counters upward), does NOT commit —
 * the caller does that. Returns a report {vaults, deals, listings, chats, addresses}.
 * Synced tombstone ids and legacy device-local skipDealIds are treated as already seen, so an
 * automatic seed scan never resurrects them. Explicit recovery/import clears the tombstone first.
 */
export async function restoreFromSeeds(seeds, profile, network, skipDealIds = []) {
  const report = { vaults: 0, deals: 0, listings: 0, chats: 0, addresses: 0 };
  const seen = {
    vault: new Set([...(profile.vaults || []).map((v) => v.vault_addr), ...Object.keys(profile.tombstones?.vaults || {})]),
    deal: new Set([...(profile.deals || []).map((d) => Number(d.id)), ...skipDealIds.map(Number),
      ...Object.keys(profile.tombstones?.deals || {}).map(Number)]),
    listing: new Set((profile.listings || []).map((l) => l.id)),
    chat: new Set((profile.chats || []).map((c) => c.thread_id)),
  };
  for (const seed of [...new Set(seeds.filter(Boolean))]) {
    const scan = await scanSeed(seed);

    for (const [i, v] of scan.vaults) {
      if (seen.vault.has(v.vault_addr)) continue;
      const hot = dk(seed, 'vault/hot', i), alarm = dk(seed, 'vault/alarm', i), fund = dk(seed, 'vault/funding', i);
      // The alarm key does NOT have to derive: card safes (default since 2026-07-11) keep alarm_sk
      // OUTSIDE the profile — on the owner's card. An alarm_pk mismatch means a card safe (or a
      // legacy desync), not a reason to lose the whole safe: restore without alarm_sk, take the
      // pubkey from the server; cancel/migrate will ask for the card key manually.
      const isCard = alarm.pk !== v.alarm_pk;
      profile.vaults.push({
        network, vault_addr: v.vault_addr, hot_pk: hot.pk, alarm_pk: v.alarm_pk,
        hot_sk: hot.sk, ...(isCard ? { alarm_card: true } : { alarm_sk: alarm.sk }),
        funding_sk: fund.sk, funding_pk: fund.pk,
        delay: v.delay, heir_pk: v.heir_pk || '', inherit_delay: v.inherit_delay || 0,
        auto_inherit: !!v.auto_inherit, auto_complete: v.auto_complete !== false,
        fee_budget: v.fee_budget || 1000000,
        token: v.token, deriv_i: i, restored: true,
      });
      seen.vault.add(v.vault_addr); report.vaults++;
    }

    for (const [i, d] of scan.deals) {
      if (seen.deal.has(d.id)) continue;
      const st = await (await fetch(`/api/safe/escrow/state?id=${d.id}&token=${encodeURIComponent(d.token)}`)).json();
      if (!st || st.error) continue;
      const key = dk(seed, 'deal/key', i), fund = dk(seed, 'deal/funding', i), chat = dchat(seed, 'deal/chat', i);
      // store the chat key only if the pk in the deal DB is ours (otherwise the thread used another key)
      const chatMine = (d.role === 'buyer' ? st.buyer_chat_pk : st.seller_chat_pk) === chat.pk;
      profile.deals.push({
        id: d.id, role: d.role, token: d.token, network, amount: st.amount, template: st.template,
        descr: st.descr, sk: key.sk, pk: key.pk,
        funding_sk: d.role === 'buyer' ? fund.sk : null, funding_pk: d.role === 'buyer' ? fund.pk : null,
        cfg: st.cfg || null, escrow_addr: st.escrow_addr || null, disputed_addr: st.disputed_addr || null,
        chat_sk: chatMine ? chat.sk : null, chat_pk: chatMine ? chat.pk : null,
        deriv_i: i, restored: true,
      });
      seen.deal.add(d.id); report.deals++;
    }

    for (const [i, rows] of scan.listings) {
      for (const l of rows) {
        if (!seen.listing.has(l.id)) {
          profile.listings.push({
            id: l.id, title: l.title, price_sompi: l.price_sompi, status: l.status,
            deal_id: l.deal_id, join_code: l.join_code, listing_type: l.listing_type,
            deriv_i: i, restored: true,
          });
          seen.listing.add(l.id); report.listings++;
        }
        // the listing's carrier deal lives under the listing token and the listing/key key —
        // the deal domain does not find it, so restore it from here (as listing-new does on publish)
        if (l.deal_id && !seen.deal.has(l.deal_id)) {
          const key = dk(seed, 'listing/key', i), chat = dchat(seed, 'listing/chat', i);
          profile.deals.push({
            id: l.deal_id, role: 'seller', token: l.token, network, amount: l.price_sompi,
            template: l.category, descr: l.description, sk: key.sk,
            chat_sk: chat.sk, chat_pk: chat.pk, deriv_i: i, restored: true,
          });
          seen.deal.add(l.deal_id); report.deals++;
        }
      }
    }

    for (const [i, c] of scan.chats) {
      if (seen.chat.has(c.thread_id)) continue;
      const chat = dchat(seed, 'chat/key', i);
      profile.chats = profile.chats || [];
      profile.chats.push({
        thread_id: c.thread_id, listing_id: c.listing_id, title: c.title || `Listing #${c.listing_id}`,
        role: 'buyer', token: c.token, chat_sk: chat.sk, chat_pk: chat.pk,
        peer_chat_pk: c.seller_chat_pk || null, lastRead: 0, deriv_i: i, restored: true,
      });
      seen.chat.add(c.thread_id); report.chats++;
    }

    // wallet addresses holding coins created after the export → walletOld (the active one is untouched)
    report.addresses += await restoreWalletAddresses(seed, profile, network);

    // counters move up only: the indices of found items are already taken
    profile.deriv = profile.deriv || {};
    for (const [dom, m] of Object.entries(scan.maxIdx)) {
      if (m >= 0) profile.deriv[dom] = Math.max(profile.deriv[dom] || 0, m + 1);
    }
  }
  return report;
}
