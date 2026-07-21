/* Kaspa Escrow legacy service worker — stage 6 cutover: self-destroying, and no page registers it.
   The React Desk's worker owns this origin now (ships under /desk-app/, registered with scope '/'
   from the desk routes, navigation strictly allowlisted to those routes so the landings, the SSR'd
   market.html and the docs are never answered from its shell). Only one registration can hold
   scope '/', so vanilla pages re-registering their own worker would ping-pong it on every
   navigation between a landing and the desk. This file stays served only so browsers still holding
   the pre-cutover registration drop it — and its stale precache — on their next update check. */
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Only this worker's own caches (kescrow-*): caches is origin-wide, so a blind wipe here would
    // also delete the React desk's workbox precache.
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith('kescrow-')).map((key) => caches.delete(key)));
    await self.registration.unregister();
  })());
});
