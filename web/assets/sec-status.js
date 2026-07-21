/* Shared "Live security status" telemetry rail — used by index.html, escrow-index.html
   and kaspa-forge.html (+ ru/). Fed by /assets/sec-status.json, a static file rebuilt
   by kaspa-safe/tools/refresh-sec-status.sh at release time (same facts security.html's
   Security Center reports — see that page for full context and how to verify them).
   Graceful degradation: on any fetch/parse failure the block just stays hidden — it
   never blocks or breaks the page. */
(function () {
  var root = document.getElementById('secstat');
  if (!root) return;
  var ru = (document.documentElement.lang || '').toLowerCase().indexOf('ru') === 0;
  // Audit chip removed from the strip per Mike's decision 12.07.2026 — audit status lives on /security.html.

  function set(id, text) {
    var el = root.querySelector('#' + id);
    if (el) el.textContent = text;
  }
  function fmtDate(iso) {
    var d = iso ? new Date(iso + 'T00:00:00Z') : null;
    if (!d || isNaN(d.getTime())) return iso || '?';
    return d.toLocaleDateString(ru ? 'ru-RU' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  }

  fetch('/assets/sec-status.json', {cache: 'no-cache'}).then(function (r) {
    if (!r.ok) throw new Error('bad status');
    return r.json();
  }).then(function (s) {
    set('sec-contracts', 'vault ' + s.versions.vault.version + ' · escrow ' + s.versions.escrow.version);
    set('sec-tests', s.tests.total.passed + (ru ? ' пройдено' : ' passed'));
    set('sec-verified', fmtDate(s.updated));

    var secLink = root.querySelector('#sec-link');
    if (secLink) secLink.href = ru ? s.links.security_ru : s.links.security_en;
    var ghLink = root.querySelector('#sec-github');
    if (ghLink) ghLink.href = s.links.github;

    root.style.display = '';
  }).catch(function () {
    /* leave root hidden — degrade silently, never break the page */
  });
})();
