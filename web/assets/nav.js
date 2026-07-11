/* Kaspa Forge — language policy (decision 2026-07-11, evening; SUPERSEDES the same-day
   locale-based auto-pick): the site and service are international, the primary language is
   English EVERYWHERE — there is NO auto-redirect via navigator.language in either direction
   anymore; the default for any visitor = EN. Russian is just an OPTION: an explicit RU/EN
   switcher in the services bar (kf-nav below) on pages that have a mirror. */
// pages that have a RU mirror (needed by the switcher in kf-nav)
var KF_RU_MIRROR = /^\/(|index\.html|safe\.html|create\.html|manage\.html|desk\.html|escrow-index\.html|escrow\.html|deal\.html|market\.html|listing-new\.html|recover\.html|recover-escrow\.html|privacy\.html|privacy-escrow\.html|kaspa-forge\.html|docs\/([a-z-]+\.html)?|blog\/([a-z0-9-]+\.html)?)$/;

/* Kaspa Forge — single-origin service navigation: a "workbench" bar above the header on EVERY
   page (Forge/Desk/Safe/Escrow/Market/Docs/Recovery). The active tab is a teal "hallmark"
   welded to the bar's edge by its bottom seam (the seam overlaps the bar's border: the tab
   physically "opens" the page beneath it). Injected only on the forge hostnames — SEO landing
   pages on legacy origins are untouched. Styles — own <style> (safe.css is shared by 15+ pages, we don't bump it). */
(function () {
  if (!/^(kaspaforge\.org|kaspa\.officeforge\.co)$/.test(location.hostname)) return;
  var wrap = document.querySelector('.wrap');
  if (!wrap) return;
  var css = document.createElement('style');
  css.textContent =
    '.kf-nav{display:flex;gap:6px;align-items:stretch;margin:0 0 6px;padding:10px 0 0;' +
      'border-bottom:1px solid var(--bd);overflow-x:auto;white-space:nowrap;' +
      'font-family:var(--mono);font-size:12.5px;letter-spacing:.08em;text-transform:uppercase;' +
      'scrollbar-width:none}' +
    '.kf-nav::-webkit-scrollbar{display:none}' +
    '.kf-tab{position:relative;display:flex;align-items:center;padding:9px 13px 11px;' +
      'border:1px solid transparent;border-bottom:none;border-radius:8px 8px 0 0;' +
      'color:var(--ash);text-decoration:none;transition:color .15s,background .15s}' +
    '.kf-tab:hover{color:var(--ingot);background:rgba(255,255,255,.04)}' +
    '.kf-tab:focus-visible{outline:2px solid var(--kaspa);outline-offset:-2px}' +
    '.kf-tab.is-on{color:var(--kaspa);background:rgba(0,193,175,.09);' +
      'border-color:rgba(0,193,175,.35)}' +
    /* seam: overlaps the bar's bottom border — the active tab looks "welded" to the page */
    '.kf-tab.is-on::after{content:"";position:absolute;left:-1px;right:-1px;bottom:-1px;' +
      'height:2px;background:var(--kaspa);border-radius:1px}' +
    '@media (prefers-reduced-motion:reduce){.kf-tab{transition:none}}';
  document.head.appendChild(css);

  var ru = location.pathname.indexOf('/ru/') === 0;
  var p = ru ? '/ru' : '';
  var links = [
    [ru ? '/ru/' : '/', '⚒ Forge'],
    [p + '/desk.html', ru ? 'Деск' : 'Desk'],
    [p + '/safe.html', ru ? 'Сейф' : 'Safe'],
    [p + '/escrow-index.html', ru ? 'Эскроу' : 'Escrow'],
    [p + '/market.html', ru ? 'Маркет' : 'Market'],
    [p + '/blog/', ru ? 'Блог' : 'Blog'],
    [p + '/docs/', ru ? 'Доки' : 'Docs'],
    [p + '/recover.html', ru ? 'Восстановление' : 'Recovery'],
  ];
  var bar = document.createElement('nav');
  bar.className = 'kf-nav';
  bar.setAttribute('aria-label', ru ? 'Сервисы Kaspa Forge' : 'Kaspa Forge services');
  var activeEl = null;
  for (var i = 0; i < links.length; i++) {
    var a = document.createElement('a');
    a.href = links[i][0];
    a.textContent = links[i][1];
    a.className = 'kf-tab';
    // /docs/ and /blog/ stay highlighted on their subpages too (/docs/safe.html, /blog/<slug>.html)
    var active = location.pathname === links[i][0] ||
      ((links[i][0].slice(-6) === '/docs/' || links[i][0].slice(-6) === '/blog/') &&
        location.pathname.indexOf(links[i][0]) === 0);
    if (active) { a.className += ' is-on'; a.setAttribute('aria-current', 'page'); activeEl = a; }
    bar.appendChild(a);
  }
  // language switcher (right side): Russian is an explicit option, the default is always EN (decision 2026-07-11)
  var langHref = null;
  if (ru) {
    langHref = location.pathname.replace(/^\/ru(\/|$)/, '/');
  } else if (KF_RU_MIRROR.test(location.pathname)) {
    langHref = '/ru' + (location.pathname === '/' ? '/' : location.pathname);
  }
  if (langHref) {
    var sw = document.createElement('a');
    sw.href = langHref + location.search + location.hash;
    sw.textContent = ru ? 'EN' : 'RU';
    sw.className = 'kf-tab';
    sw.style.marginLeft = 'auto';
    sw.setAttribute('lang', ru ? 'en' : 'ru');
    sw.setAttribute('hreflang', ru ? 'en' : 'ru');
    sw.setAttribute('aria-label', ru ? 'Switch to English' : 'Русская версия');
    bar.appendChild(sw);
  }
  wrap.insertBefore(bar, wrap.firstChild);
  // on narrow screens the active tab must be visible without manual scrolling
  if (activeEl && bar.scrollWidth > bar.clientWidth) {
    activeEl.scrollIntoView({ block: 'nearest', inline: 'center' });
  }
  // bar edges: fade mask on the sides that can still be scrolled — a tab clipped with no hint
  // ("FE…", "RECOV…") read as a layout bug rather than as scrollability
  function updFade() {
    var canL = bar.scrollLeft > 4;
    var canR = bar.scrollLeft + bar.clientWidth < bar.scrollWidth - 4;
    var m = '';
    if (canL && canR) m = 'linear-gradient(90deg,transparent,#000 28px,#000 calc(100% - 28px),transparent)';
    else if (canL) m = 'linear-gradient(90deg,transparent,#000 28px)';
    else if (canR) m = 'linear-gradient(90deg,#000 calc(100% - 28px),transparent)';
    bar.style.webkitMaskImage = m;
    bar.style.maskImage = m;
  }
  bar.addEventListener('scroll', updFade, { passive: true });
  window.addEventListener('resize', updFade, { passive: true });
  updFade();
})();

/* Kaspa Safe — header burger menu for mobile/PWA. At ≤640px CSS hides the nav links
   (except the CTA); this button reveals them as a dropdown panel. Styles — safe.css (.nav-burger). */
(function () {
  var top = document.querySelector('header.top');
  if (!top || !top.querySelector('nav')) return;
  var btn = document.createElement('button');
  btn.className = 'nav-burger';
  btn.setAttribute('aria-label', 'Menu');
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = '<span></span><span></span><span></span>';
  top.appendChild(btn);
  function set(open) {
    top.classList.toggle('nav-open', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  btn.addEventListener('click', function (e) { e.stopPropagation(); set(!top.classList.contains('nav-open')); });
  document.addEventListener('click', function (e) { if (top.classList.contains('nav-open') && !top.contains(e.target)) set(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') set(false); });
})();
