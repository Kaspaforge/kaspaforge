/* Kaspa Forge legacy service worker — stage 6 cutover: self-destroying, and no page registers it.
   The React Desk's worker owns this origin now (ships under /desk-app/, registered with scope '/'
   from the desk routes, navigation strictly allowlisted to those routes so the landings, the SSR'd
   market.html and the docs are never answered from its shell). This file stays served only so
   browsers still holding the pre-cutover registration drop it — and its stale precache of the old
   desk.html — on their next update check.
   Two registrations cannot share scope '/', so a browser that opens the desk gets the new worker in
   place of this one automatically; this path is for visitors who only ever see the landings. */
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Only this worker's own caches (kforge-vNN): caches is origin-wide, so a blind wipe here would
    // also delete the React desk's workbox precache.
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith('kforge-')).map((key) => caches.delete(key)));
    await self.registration.unregister();
  })());
});
