/* Node telemetry under the header: Network / DAA score / Node status.
   Fed by /api/safe/info (network, synced, virtual_daa). DAA is an "odometer":
   between polls it ticks at the real network rate (~10/s, calibrated from the
   two latest samples). Reduced-motion / hidden tab — no ticking. */
(function () {
  var root = document.getElementById('netstat');
  if (!root) return;
  var ru = (document.documentElement.lang || '').toLowerCase().indexOf('ru') === 0;
  var loc = ru ? 'ru-RU' : 'en-US';
  var T = ru
    ? { alive: 'в строю', sync: 'догоняет сеть', off: 'недоступна', wait: '…' }
    : { alive: 'alive', sync: 'syncing', off: 'offline', wait: '…' };
  var netEl = document.getElementById('ns-net');
  var daaEl = document.getElementById('ns-daa');
  var dotEl = document.getElementById('ns-dot');
  var stEl = document.getElementById('ns-status');
  var reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  var daa = 0, t0 = 0, rate = 10, ok = false; // rate — blocks/sec, start from the Kaspa canonical value

  function fmt(n) { return Math.floor(n).toLocaleString(loc); }
  function render() {
    if (!ok || !daa) return;
    var drift = reduced ? 0 : (Date.now() - t0) / 1000 * rate;
    if (drift > 120 * rate) drift = 120 * rate; // the odometer must not run away if polling stalls
    daaEl.textContent = fmt(daa + drift);
  }
  function poll() {
    fetch('/api/safe/info').then(function (r) {
      if (!r.ok) throw 0;
      return r.json();
    }).then(function (i) {
      var now = Date.now();
      var v = i.virtual_daa || 0;
      if (ok && daa && v > daa && now > t0) { // calibrate the rate from the real delta
        var r2 = (v - daa) / ((now - t0) / 1000);
        if (r2 > 0 && r2 < 50) rate = r2;
      }
      daa = v; t0 = now; ok = true;
      var n = (i.network || '').toLowerCase();
      netEl.textContent = n.indexOf('mainnet') >= 0 ? 'mainnet' : (n || '?');
      root.classList.remove('ns-off');
      dotEl.className = 'ns-dot ' + (i.synced ? 'ns-ok' : 'ns-warn');
      stEl.textContent = i.synced ? T.alive : T.sync;
      render();
    }).catch(function () {
      ok = false;
      root.classList.add('ns-off');
      dotEl.className = 'ns-dot ns-bad';
      stEl.textContent = T.off;
      daaEl.textContent = daa ? fmt(daa) : T.wait;
    });
  }
  poll();
  setInterval(poll, 30000);
  if (!reduced) setInterval(function () { if (!document.hidden) render(); }, 100);
})();
