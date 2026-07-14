/* Kaspa Forge PWA service worker (canonical origin kaspaforge.org).
   Strategy: network-first with cache fallback — this is a financial app, code freshness matters
   more than speed; the cache exists only so the desk/landing pages open offline or during a site outage.
   /api/ and non-GET requests are never touched (never cached, always go straight to the network). */
const CACHE = 'kforge-v48';
const PRECACHE = [
  '/', '/desk.html', '/safe.html', '/escrow-index.html', '/market.html',
  '/contracts.html', '/ru/contracts.html',
  '/assets/safe.css?v=14', '/assets/app.js?v=18', '/assets/identity.js',
  '/assets/nav.js?v=7', '/assets/netstat.js?v=1', '/assets/desk.css?v=11', '/assets/desk-routes.js?v=1', '/assets/desk-overview.js?v=1', '/assets/desk-tour.js?v=4', '/assets/swap-widget.js?v=5', '/assets/favicon.svg', '/manifest-forge.json',
  '/assets/kaspa-widget.js?v=4',   // shared Sara widget on all pages
  '/assets/icons/icon-192.png?v=2', '/assets/icons/icon-512.png?v=2',
  // desk encryption: session model + unified HD wallet (shared by Safe/Escrow pages)
  '/assets/session.js', '/assets/core7.js', '/assets/lock-ui.js', '/assets/wallet.js?v=2',
  '/assets/profile-mirror.js', '/assets/profile-mirror-ui.js?v=1',
  '/assets/listing-chat.js?v=1',   // desk Chats tab (listing chat)
  '/assets/contracts.js', '/assets/contracts-catalog.json',   // Forge Contracts catalog
  '/assets/vault-core-v7/kaspa_safe_core.js', '/assets/vault-core-v7/kaspa_safe_core_bg.wasm',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
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
      .then((r) => {
        if (r.ok) {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return r;
      })
      .catch(() =>
        caches.match(e.request).then((m) => m || (e.request.mode === 'navigate' ? caches.match('/') : Response.error()))
      )
  );
});
