// boards.js — KaspaForge Boards read-only landing (catalog + thread view). No WASM core here:
// like market.html's storefront, this page only reads the public /api/safe/board/* endpoints
// (Task 7) — nothing to sign, nothing to unlock.
import { $ } from '/assets/app.js?v=18';

// Local esc() — same one-liner as market.html/app.js's private esc(): board subjects and post
// bodies come from ANYONE who can post a transaction (untrusted on-chain data), and land in
// innerHTML below — without escaping that's XSS on a public page.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const boardOf = () => new URLSearchParams(location.search).get('board') || 'b';
const txUrl = (txid) => `https://explorer.kaspa.org/txs/${encodeURIComponent(txid)}`;

// tombstone card — honest display filter: hidden from OUR feed, still on-chain (spec 2026-07-20:
// hidden/op_hidden is viewer-side state, never a chain rewrite — the transaction is right there).
function renderTombstone(txid) {
  return `<div class="mk-card mk-tomb"><span class="mk-body">
    <span class="mk-title">🚫 Message hidden — violates <a href="/boards/rules">publication rules</a>.</span>
    <span class="hint">Available in the public BlockDAG. <a href="${txUrl(txid)}" target="_blank" rel="noopener">Transaction ↗</a></span>
  </span></div>`;
}
function renderPost(p) {
  if (p.hidden) return renderTombstone(p.txid);
  return `<div class="mk-card"><span class="mk-body">
    <span class="mk-meta"><span class="mk-id">#${p.idx}</span> <a class="hint" href="${txUrl(p.txid)}" target="_blank" rel="noopener">tx ↗</a></span>
    <span class="mk-title" style="white-space:pre-wrap">${esc(p.body)}</span></span></div>`;
}
async function renderCatalog() {
  const box = $('catalog');
  try {
    const res = await fetch(`/api/safe/board/catalog?board=${encodeURIComponent(boardOf())}`);
    const rows = await res.json();
    if (!rows.length) { box.innerHTML = '<p class="hint">No threads yet — be the first to post from your Desk.</p>'; return; }
    box.innerHTML = `<div id="list">${rows.map((t) => t.op_hidden
      ? renderTombstone(t.op_txid)
      : `<a class="mk-card" href="?board=${encodeURIComponent(boardOf())}&t=${t.op_txid}"><span class="mk-body">
           <span class="mk-title">${esc(t.subject || '(no subject)')}</span>
           <span class="hint">${t.post_count} posts</span></span></a>`).join('')}</div>`;
  } catch { box.innerHTML = '<p class="note alarm">Couldn\'t load this board right now.</p>'; }
}
async function fetchThread(t, { limit, offset } = {}) {
  let url = `/api/safe/board/thread?t=${encodeURIComponent(t)}`;
  if (limit !== undefined) url += `&limit=${limit}`;
  if (offset !== undefined) url += `&offset=${offset}`;
  const res = await fetch(url);
  return res.json();
}
async function renderThread(t) {
  const box = $('thread'); $('catalog').style.display = 'none'; box.style.display = 'block';
  try {
    const data = await fetchThread(t, {});
    const head = data.thread;
    const total = head ? head.post_count : 0;
    const skipped = Math.max(0, total - data.posts.length);
    // default view = OP + server-side tail; the notice offers the offset-paged full thread
    const notice = skipped > 0
      ? `<p class="hint skipped-note">Skipped ${skipped} posts — <a href="#" id="load-full">show full thread</a></p>`
      : '';
    const [op, ...tail] = data.posts;
    box.innerHTML = `<p><a href="?board=${encodeURIComponent(boardOf())}" class="back-link">&larr; Back to /${esc(boardOf())}/</a></p>
      <h1>${head && !head.op_hidden ? esc(head.subject || '(no subject)') : 'Hidden thread'}</h1>
      ${op ? renderPost(op) : ''}${notice}<div id="tail">${tail.map(renderPost).join('')}</div>`;
    const link = document.getElementById('load-full');
    if (link) link.addEventListener('click', async (e) => {
      e.preventDefault();
      if (link.dataset.busy) return;
      link.dataset.busy = '1';
      link.textContent = 'loading…';
      const page = 200; // matches the server's default cap; server clamps anyway
      try {
        let all = [];
        let offset = 0;
        while (offset < total) {
          const chunk = await fetchThread(t, { limit: page, offset });
          if (!chunk.posts.length) break; // defensive: server said fewer posts than head claimed
          all = all.concat(chunk.posts);
          offset += chunk.posts.length;   // advance by what actually came back — server may clamp below `page`
        }
        document.querySelector('.skipped-note')?.remove();
        document.getElementById('tail').innerHTML = all.slice(1).map(renderPost).join('');
      } catch {
        link.textContent = 'failed — retry';
        delete link.dataset.busy;
        return;
      }
    });
  } catch { box.innerHTML = '<p class="note alarm">Couldn\'t load this thread right now.</p>'; }
}
const t = new URLSearchParams(location.search).get('t');
if (t) renderThread(t); else renderCatalog();
