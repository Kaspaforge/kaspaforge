/* Kaspa Safe PWA service worker.
   Strategy: network-first with cache fallback — this is a financial app, code freshness matters
   more than speed; the cache exists only so the panel/guide open offline or during a site outage.
   /api/ and non-GET requests are never touched (never cached, always go straight to the network). */
const CACHE = 'ksafe-v21';
const PRECACHE = [
  '/', '/create.html', '/manage.html', '/recover.html',
  '/ru/', '/ru/create.html', '/ru/manage.html', '/ru/recover.html',
  '/assets/safe.css?v=14', '/assets/netstat.js?v=1', '/assets/app.js?v=15', '/assets/identity.js', '/assets/safe-widget.js?v=2',
  '/assets/nav.js?v=5', '/assets/qrcode.min.js', '/assets/favicon.svg', '/manifest.json',
  '/assets/icons/icon-192.png?v=2', '/assets/icons/icon-512.png?v=2',
  '/assets/vault-core-v3/kaspa_safe_core.js', '/assets/vault-core-v3/kaspa_safe_core_bg.wasm',
  '/assets/vault-core-v6/kaspa_safe_core.js', '/assets/vault-core-v6/kaspa_safe_core_bg.wasm',
  // desk encryption: session model + personal wallet (shared by Safe/Escrow pages)
  '/assets/session.js', '/assets/core6.js', '/assets/lock-ui.js', '/assets/wallet.js',
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
