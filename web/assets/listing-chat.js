// Listing chat (pre-deal questions about a listing) — shared logic for the EN/RU desks.
// Spec: docs/superpowers/specs/2026-07-09-listing-chat-design.md. Same Kasia loop as the
// deal chat (escrow.js): E2E encryption via core.chat_build_send/chat_decrypt, on-chain anchor
// from the sender's chat key, the server relays ciphertext only (/api/safe/listings/chat/*).
//
// IMPORTANT: import escrow.js at EXACTLY the version (?v=30) the desk loads — a different query
// string would create a SECOND module instance and a second WASM init. Bumping escrow.js in desk.html — bump it here too.
import { core, net, api, submitTx, utxosRaw, chatSupported, chatAddress, boot as bootEscrow } from '/assets/escrow.js?v=30';

export { chatSupported, chatAddress };

// The desk boots app.js/core6, NOT escrow.js — without this its WASM core (chat_*) is not
// initialized. One-shot gate: every desk chat path calls ensureChatReady() first.
let ready = null;
export function ensureChatReady() { return (ready ||= bootEscrow()); }

/** Generate the buyer's chat key. → {sk, pk} */
export function genChatKeys() { return JSON.parse(core.chat_gen_keys()); }

/** Create/find a thread for a listing (idempotent per token). → {thread_id, seller_chat_pk, title} */
export async function startThread(listingId, token, chatPk) {
  return api('/api/safe/listings/chat/start', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ listing_id: listingId, token, chat_pk: chatPk }),
  });
}

/** Threads of my listing (seller, owner token). → {threads:[...]} */
export async function myThreads(listingId, ownerToken) {
  return api(`/api/safe/listings/chat/mine?listing_id=${listingId}&token=${encodeURIComponent(ownerToken)}`);
}

/** Thread messages (+role and both chat_pk). → {role, buyer_chat_pk, seller_chat_pk, msgs:[...]} */
export async function fetchThread(threadId, token, since = 0) {
  return api(`/api/safe/listings/chat/thread?thread_id=${threadId}&token=${encodeURIComponent(token)}&since=${since}`);
}

/** Whether the chat key is funded (its address has UTXOs). */
export async function chatKeyFunded(chatPk) {
  try { return JSON.parse(await utxosRaw(chatAddress(chatPk, net()))).length > 0; } catch { return false; }
}

/**
 * Send a message: comm-tx from the chat key (on-chain anchor) → relay ciphertexts to the server.
 * Submit built.tx once — a second submit of the same tx would be a double-spend (see escrow.js::sendChat).
 * me: {role: 'buyer'|'seller', chat_sk, chat_pk, token}. Throws if the key is not funded.
 */
export async function sendThreadMsg(threadId, me, peerChatPk, text) {
  const u = await utxosRaw(chatAddress(me.chat_pk, net()));
  const built = JSON.parse(core.chat_build_send(me.chat_sk, peerChatPk, me.role, text, u, net()));
  const res = await submitTx(JSON.stringify({ tx: built.tx }));
  const txid = res.txid || res.id || '';
  await api('/api/safe/listings/chat/send', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ thread_id: threadId, token: me.token, dir: me.role, txid, ciphertext_hex: built.comm_hex, self_hex: built.self_hex }),
  });
  return txid;
}

/**
 * Decrypt a batch of thread messages for our side. Own messages — from self_hex, the peer's — from
 * ciphertext_hex (like escrow.js::pollChat). Undecryptable → text:null (e.g. messages to the buyer
 * sent from ANOTHER of the seller's devices before the profile merge).
 */
export function decryptMsgs(msgs, role, chatSk) {
  return (msgs || []).map((m) => {
    const mine = m.dir === role;
    let text = null;
    try { text = core.chat_decrypt(mine ? m.self_hex : m.ciphertext_hex, chatSk); } catch { /* not ours */ }
    return { id: m.id, mine, text, ts: m.ts, txid: m.txid };
  });
}
