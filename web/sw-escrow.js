/* Kaspa Escrow PWA service worker (separate from the Safe's sw.js — shared doc-root, different origins).
   Strategy: network-first with cache fallback — financial app, code freshness matters more than speed;
   the cache exists only so the landing/panel open offline or during a site outage.
   /api/ and non-GET are never touched (always go to the network). The deal.html panel is cached at runtime on visit. */
const CACHE = 'kescrow-v45';
const PRECACHE = [
  '/', '/escrow-index.html', '/escrow.html', '/deal.html',
  '/ru/', '/ru/escrow-index.html', '/ru/escrow.html', '/ru/deal.html',
  '/assets/safe.css?v=14', '/assets/netstat.js?v=1', '/assets/escrow.css?v=7', '/assets/escrow.js?v=40', '/assets/identity.js', '/assets/swap-widget.js?v=5',
  '/assets/qrcode.min.js', '/assets/favicon.svg', '/assets/of-wordmark.png', '/assets/logo.png',
  '/manifest-escrow.json',
  '/assets/icons-escrow/icon-192.png?v=2', '/assets/icons-escrow/icon-512.png?v=2',
  '/assets/vault-core-v5/kaspa_safe_core.js', '/assets/vault-core-v5/kaspa_safe_core_bg.wasm',
  // desk encryption: session model + unified HD wallet; core7 and app.js are pulled via lock-ui/wallet
  '/assets/session.js', '/assets/core7.js', '/assets/lock-ui.js', '/assets/wallet.js?v=2', '/assets/app.js?v=18',
  '/assets/vault-core-v7/kaspa_safe_core.js', '/assets/vault-core-v7/kaspa_safe_core_bg.wasm',
  '/assets/contracts.js', '/assets/contracts-catalog.json',   // Forge Contracts catalog (escrow.html/deal.html template prefill)
];

self.addEventListener('install', (e) => {
  // best-effort: one unavailable entry must not fail the whole install step
  e.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(PRECACHE.map((u) => c.add(u)))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then((resp) => {
        if (resp && resp.ok && resp.type === 'basic') {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return resp;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/')))
  );
});
