// kaspa-safe/web/assets/desk-tour.js — spotlight desk tour for NEW users (added 2026-07-11).
// Runs once right after onboarding (lock-ui.js sets a sessionStorage flag on key creation;
// restore/import/unlock do NOT set it — experienced users are not nagged). Skippable at any
// moment (button/Esc); never shown again (localStorage kaspa-tour-done). Mechanics: a full-page
// shade with a "hole" over the target element (200vmax box-shadow), the hole glides smoothly
// between steps, a pulse ring on the target; prefers-reduced-motion — no animations. Card — .plate
// in house-modal style; pinned to the bottom on narrow screens. Language — from <html lang>, as in escrow.js.

const RU = (document.documentElement.lang || 'en').slice(0, 2) === 'ru';
const T = RU ? {
  next: 'Дальше', done: 'Понятно!', skip: 'Пропустить тур', of: 'из',
  steps: [
    { sel: '#wallet-box .addr', title: 'Твой адрес',
      text: 'Личный Kaspa-адрес этого профиля. Поделись им или покажи QR, чтобы принять монеты; copy копирует. Ключ адреса живёт только в этом браузере — в твоём шифрованном профиле.' },
    { sel: '#w-refresh', title: 'Баланс',
      text: 'Живой баланс кошелька с оценкой в долларах. Кнопка ↻ освежает баланс, свопы и историю; раз в 30 секунд всё обновляется и само.' },
    { sel: '#w-send', title: 'Отправка',
      text: 'Отправляй KAS на любой адрес (поле подсказывает из твоей адресной книги). «Макс» подставит весь баланс за вычетом комиссии, «В сейф» — депозит прямо в твой сейф.' },
    { sel: '#w-swap', title: 'Нет KAS?',
      text: 'Обменяй BTC, USDT и другие монеты на KAS прямо здесь через SimpleSwap — придут на твой адрес выше.' },
    { sel: '#backup-nudge, #d-export', title: 'Самое важное: бэкап',
      text: 'Кошелёк, сейфы и сделки живут только в этом браузере, пока ты не экспортируешь файл ключей (.age). Файл + пароль = доступ к средствам: храни их раздельно. Деск сам напомнит, когда бэкап устареет.' },
    { sel: '.desk-utils', title: 'Управление профилем',
      text: '«Экспорт ключей» сохраняет .age-бэкап. «Импорт / объединить» подтягивает файл ключей с другого устройства — всё сливается, ничего не теряется. «Запереть» мгновенно запирает деск (через 15 минут простоя он запирается и сам). «Стереть с устройства» убирает профиль из этого браузера — безопасно, когда бэкап-файл на руках.' },
    { sel: '#tab-bar', title: 'Вкладки',
      text: 'Остальное — во вкладках: Сейфы (некостодиальное хранение), Эскроу-сделки, твои объявления на Маркете и Чаты. Непрочитанные сообщения подсвечиваются бейджами. Готово — пользуйся!' },
  ],
} : {
  next: 'Next', done: 'Got it!', skip: 'Skip tour', of: 'of',
  steps: [
    { sel: '#wallet-box .addr', title: 'Your address',
      text: 'This profile\'s personal Kaspa address. Share it or show the QR to receive coins; copy copies it. The address key lives only in this browser — inside your encrypted profile.' },
    { sel: '#w-refresh', title: 'Balance',
      text: 'Your live wallet balance with a USD estimate. ↻ refreshes the balance, swaps and history; everything also updates itself every 30 seconds.' },
    { sel: '#w-send', title: 'Sending',
      text: 'Send KAS to any address (the field autocompletes from your address book). Max fills the whole balance minus the fee, and To safe deposits straight into your vault.' },
    { sel: '#w-swap', title: 'No KAS yet?',
      text: 'Swap BTC, USDT and other coins into KAS right here via SimpleSwap — it lands on your address above.' },
    { sel: '#backup-nudge, #d-export', title: 'The important one: backup',
      text: 'Your wallet, safes and deals live only in this browser until you export the key file (.age). File + password = access to the funds — keep them apart. The desk will remind you whenever the backup goes stale.' },
    { sel: '.desk-utils', title: 'Profile controls',
      text: 'Export key saves the .age backup. Import / merge brings a key file from another device — everything merges, nothing is lost. Lock locks the desk instantly (it also auto-locks after 15 idle minutes). Erase from device wipes the profile from this browser — safe once your backup file is in hand.' },
    { sel: '#tab-bar', title: 'The tabs',
      text: 'Everything else lives in the tabs: Safes (non-custodial storage), Escrow deals, your Market listings and Chats. Unread messages light up as badges. That\'s it — you\'re all set!' },
  ],
};

const DONE_KEY = 'kaspa-tour-done';
const ONBOARD_FLAG = 'kaspa-just-onboarded';   // set by lock-ui.js:onboardFlow, cleared here
const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let active = null;   // latch: one tour at a time

/** Explicit tour start (can also be triggered manually, e.g. from a future "?" button). */
export function startDeskTour() {
  if (active) return;
  // step target = first VISIBLE selector from the list; a step with no live target is silently dropped
  const steps = T.steps
    .map((s) => ({ ...s, el: [...document.querySelectorAll(s.sel)].find((e) => e.offsetParent) }))
    .filter((s) => s.el);
  if (!steps.length) return;

  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;inset:0;z-index:9000';
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-modal', 'true');
  wrap.setAttribute('aria-label', RU ? 'Тур по деску' : 'Desk tour');
  const trans = reduced ? '' : 'transition:top .45s cubic-bezier(.22,.61,.36,1),left .45s cubic-bezier(.22,.61,.36,1),width .45s cubic-bezier(.22,.61,.36,1),height .45s cubic-bezier(.22,.61,.36,1);';
  const hole = document.createElement('div');
  hole.style.cssText = `position:absolute;border-radius:10px;box-shadow:0 0 0 200vmax rgba(8,10,14,.82);${trans}pointer-events:none`;
  const ring = document.createElement('div');   // pulse as a separate ring — does not fight the hole's shadow
  ring.style.cssText = 'position:absolute;inset:-1px;border:2px solid var(--kaspa);border-radius:10px;'
    + (reduced ? '' : 'animation:tourPulse 1.6s ease-out infinite;');
  hole.appendChild(ring);
  const style = document.createElement('style');
  style.textContent = '@keyframes tourPulse{0%{box-shadow:0 0 0 0 rgba(0,193,175,.45)}100%{box-shadow:0 0 0 14px rgba(0,193,175,0)}}';
  const card = document.createElement('div');
  card.className = 'plate';
  card.tabIndex = -1;
  card.style.cssText = `position:absolute;max-width:340px;width:calc(100vw - 24px);${reduced ? '' : 'transition:top .45s cubic-bezier(.22,.61,.36,1),left .45s cubic-bezier(.22,.61,.36,1);'}`;
  wrap.append(style, hole, card);
  document.body.appendChild(wrap);
  document.documentElement.style.overflowAnchor = 'none';   // scroll anchoring jerked the hole during step transitions

  let i = 0;
  active = { wrap };

  const place = () => {
    const s = steps[i];
    const r = s.el.getBoundingClientRect();
    const pad = 8;
    hole.style.top = `${r.top - pad}px`;
    hole.style.left = `${r.left - pad}px`;
    hole.style.width = `${r.width + pad * 2}px`;
    hole.style.height = `${r.height + pad * 2}px`;
    const vw = window.innerWidth, vh = window.innerHeight;
    if (vw < 640) {   // mobile: card always pinned to the bottom — no placement guessing
      card.style.left = '12px';
      card.style.top = `${vh - card.offsetHeight - 12}px`;
      return;
    }
    const below = r.bottom + pad + 12;
    const top = below + card.offsetHeight + 12 < vh ? below : Math.max(12, r.top - pad - card.offsetHeight - 12);
    card.style.top = `${top}px`;
    card.style.left = `${Math.min(Math.max(12, r.left), vw - card.offsetWidth - 12)}px`;
  };

  const render = () => {
    const s = steps[i];
    card.innerHTML = `
      <div class="hint" style="font-family:var(--mono);font-size:11px;letter-spacing:.08em;margin:0 0 6px">${i + 1} ${T.of} ${steps.length}</div>
      <h3 style="margin:0 0 8px">${s.title}</h3>
      <p class="hint" style="margin:0">${s.text}</p>
      <div class="row wrap" style="display:flex;gap:8px;margin-top:14px;align-items:center">
        <button id="tour-next" class="btn btn-kaspa" style="padding:10px 18px">${i === steps.length - 1 ? T.done : T.next}</button>
        <button id="tour-skip" class="btn btn-ghost" style="padding:10px 14px">${T.skip}</button>
      </div>`;
    card.querySelector('#tour-next').onclick = next;
    card.querySelector('#tour-skip').onclick = finish;
    s.el.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
    // position after scrolling: a couple of frames + a timer follow-up (smooth scroll outlasts a frame)
    requestAnimationFrame(place);
    setTimeout(place, reduced ? 0 : 380);
    card.focus({ preventScroll: true });
  };

  const next = () => { if (i >= steps.length - 1) { finish(); return; } i++; render(); };
  const prev = () => { if (i > 0) { i--; render(); } };
  function finish() {
    localStorage.setItem(DONE_KEY, '1');
    window.removeEventListener('resize', place);
    window.removeEventListener('scroll', onScroll, true);
    wrap.removeEventListener('keydown', onKey);
    if (reduced) { wrap.remove(); active = null; return; }
    wrap.style.transition = 'opacity .25s ease-out';
    wrap.style.opacity = '0';
    setTimeout(() => { wrap.remove(); active = null; }, 260);
  }
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); finish(); }
    if (e.key === 'Enter' || e.key === 'ArrowRight') { e.preventDefault(); next(); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
  };
  let raf = 0;
  const onScroll = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(place); };
  wrap.addEventListener('keydown', onKey);
  window.addEventListener('resize', place);
  window.addEventListener('scroll', onScroll, true);

  render();
}

/** Auto-start after onboarding: lock-ui sets the flag on key creation, it is cleared here. */
export function maybeStartDeskTour() {
  try {
    if (localStorage.getItem(DONE_KEY)) return;
    if (sessionStorage.getItem(ONBOARD_FLAG) !== '1') return;
    sessionStorage.removeItem(ONBOARD_FLAG);
  } catch { return; }
  // let the first render (balance/swap widget/backup nudge) settle so the targets are in place
  setTimeout(startDeskTour, 700);
}
