/* Kaspa Forge unified support widget — Sara. Self-contained chat bubble that talks to /api/support/
   (nginx on every Kaspa origin routes it to the officeforge-support-kaspa instance; canon =
   KASPA-FAQ.md covering Safe + Escrow + Marketplace + Desk). One Sara for all Kaspa services.
   EN/RU via <html lang>. No deps. Captcha (Cloudflare Turnstile) only if backend reports captcha:on. */
(function () {
  // website only: in Tauri-APK/offline copies the widget is not mounted (Turnstile would fail
  // the hostname check and /api/support has no CORS) — support there goes via kaspa@officeforge.co
  if (!/(^|\.)kaspaforge\.org$|(^|\.)officeforge\.co$/.test(location.hostname)) return;
  // On mobile keep Sara ONLY on the umbrella Forge landing page — on the desk/safe/escrow/market
  // pages and the legacy subdomains (safe./escrow.) the floating button gets in the way on
  // narrow screens. Desktop untouched: the widget shows everywhere, as before.
  var __mobile = window.matchMedia && window.matchMedia('(max-width: 640px)').matches;
  var __p = location.pathname;
  var __onForge = /^(kaspaforge\.org|kaspa\.officeforge\.co)$/.test(location.hostname)
    && (__p === '/' || __p === '/ru/' || /(^|\/)kaspa-forge\.html$/.test(__p));
  if (__mobile && !__onForge) return;
  if (window.__kaspaSara) return; window.__kaspaSara = true;
  var API = '/api/support';
  var session = null, history = [], booted = false, captcha = false;

  var RU = (document.documentElement.lang || 'en').slice(0, 2) === 'ru';
  var T = RU ? {
    btn: 'Спросить Сару',
    sub: 'Поддержка Kaspa',
    hello: 'Привет! Я Сара, поддержка Kaspa 🙂 Спрашивай про сейф, сделки-гаранты, маркетплейс и свой деск (профиль, пароль, кошелёк, бэкап). Пароль профиля и приватные ключи я никогда не спрашиваю — и ты их никому не показывай.',
    ph: 'Вопрос про сейф, Гарант, маркет или деск…',
    send: 'Отправить',
    spam: 'Быстрая проверка от спама…',
    capFail: 'Проверка не прошла — попробуй ещё раз.',
    noReach: 'Не удалось связаться с поддержкой — попробуй ещё раз.',
    capErr: 'Ошибка проверки — перезагрузи страницу.',
    passed: '✓ передано команде',
    expired: 'Сессия истекла — открой чат заново.',
    wrong: 'Что-то пошло не так. Попробуй ещё раз.',
    net: 'Сетевой сбой — попробуй ещё раз.'
  } : {
    btn: 'Ask Sara',
    sub: 'Kaspa support',
    hello: "Hi! I'm Sara, Kaspa support 🙂 Ask about the vault (Safe), escrow deals, the marketplace, or your desk (profile, password, wallet, backup). I'll never ask for your profile password or private keys — don't show them to anyone.",
    ph: 'Ask about Safe, Escrow, marketplace or your desk…',
    send: 'Send',
    spam: 'Quick spam check…',
    capFail: 'Check failed — try the box again.',
    noReach: 'Could not reach support — try again.',
    capErr: 'Verification error — reload the page.',
    passed: '✓ passed to the team',
    expired: 'Session expired — reopen the chat.',
    wrong: 'Sorry, something went wrong. Try again.',
    net: 'Network hiccup — please try again.'
  };

  var css = `
  .sara-btn{position:fixed;right:20px;bottom:20px;z-index:9998;display:flex;align-items:center;gap:9px;
    background:linear-gradient(180deg,#33D6C6,#00A796);color:#03302C;border:none;border-radius:30px;
    padding:12px 18px;font:600 14px/1 "Golos Text",system-ui,sans-serif;cursor:pointer;box-shadow:0 8px 28px rgba(0,0,0,.45)}
  .sara-btn:hover{filter:brightness(1.07)}
  .sara-panel{position:fixed;right:20px;bottom:20px;z-index:9999;width:370px;max-width:calc(100vw - 32px);
    height:520px;max-height:calc(100vh - 40px);display:none;flex-direction:column;background:#12161d;
    border:1px solid rgba(255,255,255,.12);border-radius:14px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.55);
    font-family:"Golos Text",system-ui,sans-serif}
  .sara-panel.open{display:flex}
  .sara-head{display:flex;align-items:center;gap:10px;padding:13px 15px;background:#161B22;border-bottom:1px solid rgba(255,255,255,.085)}
  .sara-ava{width:30px;height:30px;border-radius:50%;background:linear-gradient(180deg,#33D6C6,#00A796);
    display:flex;align-items:center;justify-content:center;color:#03302C;font-weight:700;font-size:14px}
  .sara-head b{color:#ECEFF4;font-size:14px}.sara-head span{color:#9AA7BC;font-size:11.5px;display:block;margin-top:1px}
  .sara-x{margin-left:auto;background:none;border:none;color:#9AA7BC;font-size:20px;cursor:pointer;line-height:1}
  .sara-msgs{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px}
  .sara-m{max-width:84%;padding:9px 12px;border-radius:12px;font-size:13.5px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word}
  .sara-m.bot{background:#1B222C;color:#e7ecf5;border:1px solid rgba(255,255,255,.085);align-self:flex-start;border-bottom-left-radius:4px}
  .sara-m.me{background:#0d3f39;color:#e7fffb;align-self:flex-end;border-bottom-right-radius:4px}
  .sara-m.note{align-self:center;background:none;color:#9AA7BC;font-size:11.5px;padding:2px}
  .sara-foot{padding:10px;border-top:1px solid rgba(255,255,255,.085);display:flex;gap:8px}
  .sara-in{flex:1;background:#0E1116;border:1px solid rgba(255,255,255,.12);border-radius:9px;color:#e7ecf5;padding:9px 11px;
    font:14px "Golos Text",system-ui,sans-serif;resize:none;outline:none;max-height:90px}
  .sara-send{background:#00C1AF;border:none;border-radius:9px;color:#03302C;font-weight:700;padding:0 14px;cursor:pointer}
  .sara-send:disabled{opacity:.5;cursor:default}
  .sara-dot{display:inline-block}.sara-dot::after{content:'•••';letter-spacing:2px;animation:saraB 1s infinite}
  @keyframes saraB{0%,100%{opacity:.3}50%{opacity:1}}`;
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  var btn = document.createElement('button'); btn.className = 'sara-btn';
  btn.innerHTML = '<span style="font-size:16px">💬</span> ' + T.btn;
  var panel = document.createElement('div'); panel.className = 'sara-panel';
  panel.innerHTML =
    '<div class="sara-head"><div class="sara-ava">S</div><div><b>Sara</b><span>' + T.sub + '</span></div>'
    + '<button class="sara-x" title="Close">×</button></div>'
    + '<div class="sara-msgs" id="sara-msgs"></div>'
    + '<div class="sara-foot"><textarea class="sara-in" id="sara-in" rows="1" placeholder="' + T.ph + '"></textarea>'
    + '<button class="sara-send" id="sara-send">' + T.send + '</button></div>';
  document.body.appendChild(btn); document.body.appendChild(panel);

  var msgs = panel.querySelector('#sara-msgs'), input = panel.querySelector('#sara-in'), send = panel.querySelector('#sara-send');

  function add(text, who) {
    var d = document.createElement('div'); d.className = 'sara-m ' + who; d.textContent = text;
    msgs.appendChild(d); msgs.scrollTop = msgs.scrollHeight; return d;
  }
  function note(t) { return add(t, 'note'); }

  function loadTurnstile() {
    return new Promise(function (res) {
      if (window.turnstile) return res();
      var s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true; s.defer = true; s.onload = function () { res(); }; s.onerror = function () { res(); };
      document.head.appendChild(s);
    });
  }
  var tsWidgetId = null, capBox = null, capNote = null;
  async function doVerify(token) {
    try {
      var v = await (await fetch(API + '/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ turnstile_token: token }) })).json();
      if (v && v.ok) {
        session = v.session;
        if (capNote) { capNote.remove(); capNote = null; }
        if (capBox) { capBox.remove(); capBox = null; }
        send.disabled = false; input.disabled = false; input.focus();
      } else {
        if (capNote) capNote.textContent = T.capFail;
        if (tsWidgetId !== null && window.turnstile) { try { window.turnstile.reset(tsWidgetId); } catch (e) {} }
      }
    } catch (e) { if (capNote) capNote.textContent = T.noReach; }
  }
  async function boot() {
    if (booted) return; booted = true;
    add(T.hello, 'bot');
    var h = {};
    try { h = await (await fetch(API + '/health')).json(); } catch (e) {}
    captcha = !!h.captcha;
    if (captcha && h.sitekey && window.location.protocol === 'https:') {
      input.disabled = true; send.disabled = true;
      capNote = note(T.spam);
      capBox = document.createElement('div'); capBox.style.alignSelf = 'center'; capBox.style.margin = '4px 0'; msgs.appendChild(capBox);
      await loadTurnstile();
      if (!window.turnstile) { capNote.remove(); capBox.remove(); capNote = capBox = null; return doVerify(null); }
      try {
        tsWidgetId = window.turnstile.render(capBox, {
          sitekey: h.sitekey, theme: 'dark', language: RU ? 'ru' : 'en',
          callback: function (token) { doVerify(token); },
          'error-callback': function () { if (capNote) capNote.textContent = T.capErr; },
          'expired-callback': function () { if (tsWidgetId !== null) try { window.turnstile.reset(tsWidgetId); } catch (e) {} }
        });
      } catch (e) { capNote.remove(); capBox.remove(); capNote = capBox = null; doVerify(null); }
    } else {
      doVerify(null);
    }
  }

  async function sendMsg() {
    var text = (input.value || '').trim(); if (!text || !session) return;
    input.value = ''; input.style.height = 'auto';
    add(text, 'me'); history.push({ role: 'user', content: text });
    send.disabled = true;
    var typing = add('', 'bot'); typing.innerHTML = '<span class="sara-dot"></span>';
    try {
      var r = await (await fetch(API + '/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: session, message: text, history: history.slice(-8) }) })).json();
      typing.remove();
      if (r && r.ok) {
        add(r.reply, 'bot'); history.push({ role: 'assistant', content: r.reply });
        if (r.escalated) note(T.passed);
      } else if (r && r.error && /session/.test(r.error)) { session = null; booted = false; note(T.expired); }
      else { add((r && r.error) || T.wrong, 'bot'); }
    } catch (e) { typing.remove(); add(T.net, 'bot'); }
    send.disabled = false; input.focus();
  }

  btn.onclick = function () { panel.classList.add('open'); btn.style.display = 'none'; boot(); setTimeout(function(){ input.focus(); }, 50); };
  panel.querySelector('.sara-x').onclick = function () { panel.classList.remove('open'); btn.style.display = ''; };
  send.onclick = sendMsg;
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); } });
  input.addEventListener('input', function () { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 90) + 'px'; });
})();
