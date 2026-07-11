// SimpleSwap fund-in widget — shared by deal.html (Escrow) and create.html (Safe).
// "Don't have KAS?" → swap form → deposit address + status stepper.
// Never touches private keys: address_to (fundAddr) is supplied by the host page —
// it already displays it for manual funding (see the KASPA-SIMPLESWAP-BRIDGE spec, §4/§5).

// Status-stepper CSS — own classes (sw-tl*), injected once per page (id guard), never
// dependent on escrow.css/safe.css: the widget is shared by Escrow (deal.html) and Safe (create.html, Task 3),
// while .tl/.tl-dot/.tl-bar/.timeline exist ONLY in escrow.css. The variables --kaspa/--bd-soft/
// --mono/--ash2/--ingot are defined in :root of safe.css (loaded by BOTH pages) — safe to use.
function injectStyles() {
  if (document.getElementById('sw-widget-styles')) return;
  const style = document.createElement('style');
  style.id = 'sw-widget-styles';
  style.textContent = `
    .sw-timeline { display: flex; align-items: center; gap: 0; }
    .sw-tl { display: flex; flex-direction: column; align-items: center; gap: 6px; flex: none; }
    .sw-tl-dot { width: 13px; height: 13px; border-radius: 50%; background: var(--bd-soft); border: 2px solid var(--bd-soft); }
    .sw-tl.sw-on .sw-tl-dot { background: var(--kaspa); border-color: var(--kaspa); }
    .sw-tl.sw-on.sw-warn .sw-tl-dot { background: #E0A93E; border-color: #E0A93E; }
    .sw-tl-lbl { font-family: var(--mono); font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--ash2); }
    .sw-tl.sw-on .sw-tl-lbl { color: var(--ingot); }
    .sw-tl-bar { flex: 1; height: 2px; background: var(--bd-soft); margin: 0 4px; margin-bottom: 18px; }
  `;
  document.head.appendChild(style);
}

// onCreated (optional) — callback after a swap is created successfully: {swap_id, simpleswap_id,
// ticker_from, network_from, amount_from, amount_to, status, ts}. Desk stores it in the
// profile ("My swaps"); create/deal don't pass the callback — nothing changes for them.
// minKas (optional, v4) — minimum KAS the swap must deliver: if the estimate is lower, swap
// creation is blocked with a warning (deal.html passes the deal funding price —
// owner feedback 2026-07-09: the swap must cover the whole deal, any surplus goes to the wallet).
export async function mountSwapWidget({ container, api, kas, kind, target, token, fundAddr, lang, onCreated, minKas }) {
  const ru = (lang || 'en').slice(0, 2) === 'ru';
  const t = ru ? {
    toggle: 'Нет KAS? Обменять через SimpleSwap',
    currency: 'Отправляете', amount: 'Сумма', quote: 'Узнать курс', est: '≈ придёт KAS',
    disclaimer: 'SimpleSwap — сторонний сервис. На время обмена средства у него в кастодии; это отдельно от non-custodial гарантии, которая начинается с момента прихода KAS.',
    refund: 'Ваш адрес возврата (та же валюта, на случай сбоя обмена)',
    create: 'Создать обмен', sendTo: 'Отправьте на этот адрес', memo: 'Memo/тег — ОБЯЗАТЕЛЬНО указать при отправке:',
    needAmount: 'Введите сумму', needRefund: 'Укажите адрес возврата',
    minSwap: (est, min) => `Обмен даст ${est} — этого мало: для финансирования нужно не меньше ${min}. Увеличьте сумму обмена (излишек вернётся на ваш кошелёк).`,
    status: { waiting: 'Ждём ваш платёж', confirming: 'Подтверждаем', exchanging: 'Меняем', sending: 'Отправляем KAS', finished: 'Готово — KAS отправлен', failed: 'Ошибка обмена', refunded: 'Возвращено на ваш адрес' },
  } : {
    toggle: "Don't have KAS? Swap via SimpleSwap",
    currency: 'You send', amount: 'Amount', quote: 'Get quote', est: '≈ KAS to arrive',
    disclaimer: 'SimpleSwap is a third-party service. During the swap your funds are in its custody — separate from the non-custodial guarantee, which starts once KAS arrives.',
    refund: 'Your refund address (same currency, in case the swap fails)',
    create: 'Create swap', sendTo: 'Send to this address', memo: 'Memo/tag — REQUIRED when sending:',
    needAmount: 'Enter an amount', needRefund: 'Enter a refund address',
    minSwap: (est, min) => `This swap delivers ${est} — not enough: at least ${min} is required to fund. Increase the swap amount (any surplus goes back to your wallet).`,
    status: { waiting: 'Waiting for your payment', confirming: 'Confirming', exchanging: 'Exchanging', sending: 'Sending KAS', finished: 'Done — KAS sent', failed: 'Swap failed', refunded: 'Refunded to your address' },
  };

  // Kill-switch (spec §9 "Rollback"): empty SIMPLESWAP_API_KEY on the server → /currencies
  // returns [] → the widget renders nothing at all (not even the toggle button). Rollback =
  // unset the environment variable, no frontend changes needed.
  let currencies;
  try {
    currencies = await api('/api/safe/swap/currencies');
  } catch { currencies = []; }
  if (!currencies.length) { container.innerHTML = ''; return; }

  // Markup is deliberately flat (no new bordered-card wrappers) — it visually continues
  // the adjacent #fund-body inside the same panel: same .label/.kv/.addr/.qr as the manual
  // funding block right above it, only amount+currency collapsed into one row (the usual
  // swap-widget idiom). Status is a stepper in the same visual language renderTimeline()
  // uses for joined→…→closed, but with its OWN classes (sw-tl*) and OWN injected styles
  // (injectStyles() below) — the widget is shared by Escrow (deal.html loads escrow.css)
  // and Safe (create.html loads only safe.css), so it must draw the stepper itself,
  // without relying on any external stylesheet.
  injectStyles();
  container.innerHTML = `
    <button class="btn btn-ghost" id="sw-toggle" type="button">⇄ ${t.toggle}</button>
    <div id="sw-body" style="display:none;margin-top:14px">
      <div class="note">${t.disclaimer}</div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:4px">
        <div style="flex:1 1 170px">
          <label style="margin-top:16px">${t.currency}</label>
          <select id="sw-cur"></select>
        </div>
        <div style="flex:1 1 120px">
          <label style="margin-top:16px">${t.amount}</label>
          <input type="text" id="sw-amt" inputmode="decimal" autocomplete="off">
        </div>
      </div>
      <p class="hint" id="sw-range" style="margin-top:6px"></p>
      <button class="btn btn-kaspa" id="sw-quote" type="button" style="margin-top:10px">${t.quote}</button>
      <div class="kv" style="margin-top:10px"><span class="k">${t.est}</span><span class="v ok" id="sw-est">—</span></div>
      <div id="sw-step2" style="display:none;margin-top:14px">
        <label style="margin-top:0">${t.refund}</label>
        <input type="text" id="sw-refund" autocomplete="off">
        <button class="btn btn-kaspa" id="sw-create" type="button" style="margin-top:10px">${t.create}</button>
      </div>
      <div id="sw-step3" style="display:none;margin-top:16px">
        <label style="margin-top:0">${t.sendTo}</label>
        <div class="addr"><code id="sw-depaddr"></code><button id="sw-depcopy" type="button" aria-label="Copy deposit address">copy</button></div>
        <div class="qr" id="sw-qr"></div>
        <div class="note alarm" id="sw-memo" style="display:none;margin-top:10px"></div>
        <div class="sw-timeline" id="sw-timeline" style="margin-top:16px"></div>
      </div>
      <div class="note alarm" id="sw-err" style="display:none;margin-top:10px"></div>
    </div>`;

  const $ = (id) => container.querySelector('#' + id);
  $('sw-toggle').onclick = () => {
    const open = $('sw-body').style.display !== 'none';
    $('sw-body').style.display = open ? 'none' : 'block';
  };
  const showErr = (msg) => { $('sw-err').textContent = '⚠ ' + msg; $('sw-err').style.display = 'block'; };
  const hideErr = () => { $('sw-err').style.display = 'none'; };
  $('sw-depcopy').onclick = async () => { await navigator.clipboard.writeText($('sw-depaddr').textContent); };

  for (const c of currencies) {
    $('sw-cur').insertAdjacentHTML('beforeend', `<option value="${c.ticker}:${c.network}">${c.label}</option>`);
  }

  // min/max range for the selected currency — refreshed on currency change and once on mount
  async function refreshRange() {
    const [ticker_from, network_from] = $('sw-cur').value.split(':');
    try {
      const r = await api(`/api/safe/swap/ranges?ticker_from=${ticker_from}&network_from=${network_from}`);
      $('sw-range').textContent = ru
        ? `Диапазон: ${r.min} – ${r.max ?? '∞'} ${ticker_from.toUpperCase()}`
        : `Range: ${r.min} – ${r.max ?? '∞'} ${ticker_from.toUpperCase()}`;
    } catch { $('sw-range').textContent = ''; }
  }
  $('sw-cur').onchange = refreshRange;
  refreshRange();

  let quote = null; // {ticker_from, network_from, amount_from, rate_id}
  $('sw-quote').onclick = async () => {
    hideErr();
    const [ticker_from, network_from] = $('sw-cur').value.split(':');
    const amount_from = Number($('sw-amt').value);
    if (!(amount_from > 0)) { showErr(t.needAmount); return; }
    try {
      const r = await api('/api/safe/swap/estimate', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticker_from, network_from, amount_from }) });
      const estKas = Number(r.estimated_kas);
      $('sw-est').textContent = kas(Math.round(estKas * 1e8));
      // minKas gate: don't create a swap below the funding price (owner feedback 2026-07-09) —
      // an underdelivering swap would leave the deal hanging underfunded
      if (minKas && !(estKas >= minKas)) {
        quote = null;
        $('sw-step2').style.display = 'none';
        showErr(t.minSwap(kas(Math.round(estKas * 1e8)), kas(Math.round(minKas * 1e8))));
        return;
      }
      quote = { ticker_from, network_from, amount_from, rate_id: r.rate_id, estimated_kas: estKas };
      $('sw-step2').style.display = 'block';
    } catch (e) { showErr(e.message); }
  };

  $('sw-create').onclick = async () => {
    hideErr();
    if (!quote) return;
    // re-check the gate at creation time — the estimate may be stale / the quote may belong to another amount
    if (minKas && !(quote.estimated_kas >= minKas)) {
      showErr(t.minSwap(kas(Math.round((quote.estimated_kas || 0) * 1e8)), kas(Math.round(minKas * 1e8))));
      return;
    }
    const user_refund_address = $('sw-refund').value.trim();
    if (!user_refund_address) { showErr(t.needRefund); return; }
    try {
      const r = await api('/api/safe/swap/create', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, target, token, ticker_from: quote.ticker_from, network_from: quote.network_from,
          amount_from: quote.amount_from, rate_id: quote.rate_id, address_to: fundAddr, user_refund_address }) });
      $('sw-depaddr').textContent = r.address_from;
      qrIntoLocal($('sw-qr'), r.address_from);
      if (r.extra_id_from) { $('sw-memo').style.display = 'block'; $('sw-memo').textContent = t.memo + ' ' + r.extra_id_from; }
      $('sw-step3').style.display = 'block';
      renderSwapTimeline('waiting'); // show the first stepper step immediately, don't wait for the first poll tick
      if (typeof onCreated === 'function') {
        try { onCreated({ swap_id: r.swap_id, simpleswap_id: r.simpleswap_id, ticker_from: quote.ticker_from,
          network_from: quote.network_from, amount_from: quote.amount_from, amount_to: r.amount_to || '',
          status: r.status || 'waiting', ts: Date.now() }); } catch {}
      }
      pollStatus(r.swap_id);
    } catch (e) { showErr(e.message); }
  };

  // Deposit-address QR — own mini-helper (don't pull qrInto from escrow.js/app.js: the widget
  // is shared by Escrow and Safe and must not depend on either). qrcode.min.js is loaded by the
  // host page as a plain <script> (global), the same trick f-qr above already uses.
  function qrIntoLocal(el, data) {
    if (typeof qrcode === 'undefined') return;
    if (el.dataset.qr === data) return;
    const q = qrcode(0, 'M'); q.addData(data); q.make();
    el.innerHTML = q.createImgTag(4, 8);
    el.dataset.qr = data;
  }

  // Status stepper — visually like renderTimeline() (joined→funded→closed), but with its OWN
  // sw-tl*/sw-on/sw-warn classes (see injectStyles() above) — .tl/.tl-dot/.tl-bar/.timeline
  // exist ONLY in escrow.css, which the Safe page (create.html, Task 3) does not load;
  // failed/refunded is the alternative ending (like renderTimeline's "disputed"), highlighted
  // with sw-warn (yellow) instead of teal.
  const SW_STEPS = ['waiting', 'confirming', 'exchanging', 'sending', 'finished'];
  const SW_ORDER = { waiting: 0, confirming: 1, exchanging: 2, sending: 3, finished: 4, failed: 4, refunded: 4 };
  function renderSwapTimeline(status) {
    const cur = SW_ORDER[status] ?? 0;
    const alt = status === 'failed' || status === 'refunded';
    const steps = alt ? [...SW_STEPS.slice(0, 4), status] : SW_STEPS;
    $('sw-timeline').innerHTML = steps
      .map((s, i) => `<div class="sw-tl ${i <= cur ? 'sw-on' : ''} ${alt && i === 4 ? 'sw-warn' : ''}"><span class="sw-tl-dot"></span><span class="sw-tl-lbl">${t.status[s] || s}</span></div>`)
      .join('<div class="sw-tl-bar"></div>');
  }

  let statusTimer = null;
  function pollStatus(swapId) {
    clearInterval(statusTimer);
    const tick = async () => {
      try {
        const r = await api(`/api/safe/swap/status?id=${swapId}&token=${encodeURIComponent(token)}`);
        renderSwapTimeline(r.status);
        if (['finished', 'failed', 'refunded'].includes(r.status)) clearInterval(statusTimer);
      } catch { /* transient */ }
    };
    tick();
    statusTimer = setInterval(tick, 6000);
  }
}
