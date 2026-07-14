// Spotlight onboarding for a newly created Desk profile.
// lock-ui.js sets kaspa-just-onboarded only after key creation; restore/import/unlock never set it.
// The cockpit refactor split features into hash-routed views, so every step names its view and the
// Desk passes its own navigate() function. The target is resolved only after that view is rendered.

const DONE_KEY = 'kaspa-tour-done';
const ONBOARD_FLAG = 'kaspa-just-onboarded';
let active = null;

const COPY = {
  en: {
    next: 'Next', back: 'Back', done: 'Start using Desk', skip: 'Skip tour', of: 'of',
    dialog: 'Desk onboarding tour',
    steps: [
      { view: 'overview', sel: '#side-nav, #bottom-nav', title: 'Everything starts here',
        text: 'Use the sidebar on desktop or the bottom bar on mobile to move between your wallet, safes, escrow deals, marketplace listings, chats, and settings.' },
      { view: 'overview', sel: '#view-overview .ov-hero', title: 'Your cockpit',
        text: 'See the active wallet balance, receive KAS, send funds, or move coins into a Safe. The cards below surface anything that needs your attention.' },
      { view: 'overview', sel: '#d-lock', title: 'Quick lock',
        text: 'This locks the whole Desk immediately on a shared or unattended device. It does not change your password, keys, or on-chain funds.' },
      { view: 'wallet', sel: '#wallet-box .addr', title: 'Receive into your wallet',
        text: 'This is your current Kaspa receive address. New address rotates it for privacy, while coins on every address derived from your seed stay in one spendable balance — no collect is needed.' },
      { view: 'wallet', sel: '#w-send-row', title: 'Send, swap, and review activity',
        text: 'Send KAS to an address, use Max, or deposit directly into one of your Safes. The swap block buys KAS with other coins, and Activity records current and previous wallet addresses.' },
      { view: 'safes', sel: '#tab-vaults', title: 'Safes',
        text: 'Safes protect KAS with delayed withdrawals, an alarm path, and recovery rules enforced on-chain. Active withdrawal warnings stay visible from every Desk section.' },
      { view: 'escrow', sel: '#tab-deals', title: 'Escrow',
        text: 'Create or join protected deals, follow who must act next, fund from your wallet, exchange evidence in chat, and open a dispute when an agreement breaks down.' },
      { view: 'market', sel: '#tab-listings', title: 'Market',
        text: 'Publish goods or services and manage their status here. Every sale can open a non-custodial escrow instead of asking either side to trust a custodian.' },
      { view: 'chats', sel: '#tab-chats', title: 'Chats',
        text: 'Talk to buyers and sellers inside the relevant listing or deal. Unread badges bring new messages to the front without exposing your key file.' },
      { view: 'settings', sel: '.desk-utils', title: 'Back up before you leave',
        text: 'Export the encrypted .age key file and keep it apart from your password. Forge Sync connects devices holding copies of the same profile, even copies made before Sync existed; alarm, heir, and arbiter keys stay only on their current device.' },
    ],
  },
  ru: {
    next: 'Дальше', back: 'Назад', done: 'Начать работу', skip: 'Пропустить тур', of: 'из',
    dialog: 'Тур по функциям Деска',
    steps: [
      { view: 'overview', sel: '#side-nav, #bottom-nav', title: 'Всё начинается здесь',
        text: 'Переходи между кошельком, сейфами, эскроу-сделками, объявлениями, чатами и настройками через боковое меню на ПК или нижнюю панель на телефоне.' },
      { view: 'overview', sel: '#view-overview .ov-hero', title: 'Твой пульт',
        text: 'Здесь видны баланс активного кошелька, приём и отправка KAS и перевод монет в сейф. Карточки ниже сразу показывают, где требуется твоё действие.' },
      { view: 'overview', sel: '#d-lock', title: 'Быстрый замок',
        text: 'Эта кнопка мгновенно запирает весь Деск на общем или оставленном устройстве. Пароль, ключи и монеты на блокчейне не меняются.' },
      { view: 'wallet', sel: '#wallet-box .addr', title: 'Получение в кошелёк',
        text: 'Это текущий Kaspa-адрес для приёма. «Новый адрес» меняет его ради приватности, а монеты на всех адресах из твоего seed остаются в одном доступном балансе — собирать их не нужно.' },
      { view: 'wallet', sel: '#w-send-row', title: 'Отправка, обмен и история',
        text: 'Отправляй KAS по адресу, используй «Макс» или клади монеты прямо в сейф. Блок обмена покупает KAS за другие монеты, а «Активность» учитывает текущий и прошлые адреса.' },
      { view: 'safes', sel: '#tab-vaults', title: 'Сейфы',
        text: 'Сейфы защищают KAS задержкой вывода, тревожным путём и правилами восстановления на блокчейне. Активное предупреждение о выводе видно из любого раздела Деска.' },
      { view: 'escrow', sel: '#tab-deals', title: 'Эскроу',
        text: 'Создавай и подключай защищённые сделки, следи за следующим действием, пополняй из кошелька, обменивайся доказательствами в чате и открывай спор при нарушении условий.' },
      { view: 'market', sel: '#tab-listings', title: 'Маркет',
        text: 'Публикуй товары и услуги и управляй их статусом. Каждая продажа может открыть некостодиальное эскроу — доверять хранение монет посреднику не нужно.' },
      { view: 'chats', sel: '#tab-chats', title: 'Чаты',
        text: 'Общайся с покупателями и продавцами внутри объявления или сделки. Бейджи непрочитанных выводят новые сообщения на первый план, не раскрывая файл ключей.' },
      { view: 'settings', sel: '.desk-utils', title: 'Сделай бэкап перед выходом',
        text: 'Экспортируй зашифрованный файл ключей .age и храни его отдельно от пароля. Forge Sync связывает устройства с копиями одного профиля, даже сделанными до появления Sync; alarm, heir и arbiter keys остаются только на своём устройстве.' },
    ],
  },
};

/** Pure tour plan, exported so route/selector parity stays unit-testable. */
export function deskTourPlan(lang = 'en') {
  return COPY[String(lang).toLowerCase().startsWith('ru') ? 'ru' : 'en'];
}

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const visible = (el) => !!(el && (el.offsetParent || el.getClientRects().length));
function findTarget(selectors) {
  for (const selector of selectors.split(',')) {
    const el = [...document.querySelectorAll(selector.trim())].find(visible);
    if (el) return el;
  }
  return null;
}

/** Start explicitly. navigate(view) must synchronously expose the requested cockpit view. */
export function startDeskTour({ navigate = null } = {}) {
  if (active) return false;
  const lang = (document.documentElement.lang || 'en').slice(0, 2);
  const T = deskTourPlan(lang);
  const reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const initialRoute = (location.hash || '#overview').slice(1);
  const previousFocus = document.activeElement;
  const previousOverflowAnchor = document.documentElement.style.overflowAnchor;

  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;inset:0;z-index:9000';
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-modal', 'true');
  wrap.setAttribute('aria-label', T.dialog);
  const trans = reduced ? '' : 'transition:top .35s cubic-bezier(.22,.61,.36,1),left .35s cubic-bezier(.22,.61,.36,1),width .35s cubic-bezier(.22,.61,.36,1),height .35s cubic-bezier(.22,.61,.36,1);';
  const hole = document.createElement('div');
  hole.style.cssText = `position:absolute;border-radius:10px;box-shadow:0 0 0 200vmax rgba(8,10,14,.84);${trans}pointer-events:none`;
  const ring = document.createElement('div');
  ring.style.cssText = 'position:absolute;inset:-1px;border:2px solid var(--kaspa);border-radius:10px;'
    + (reduced ? '' : 'animation:tourPulse 1.6s ease-out infinite;');
  hole.appendChild(ring);
  const style = document.createElement('style');
  style.textContent = '@keyframes tourPulse{0%{box-shadow:0 0 0 0 rgba(0,193,175,.45)}100%{box-shadow:0 0 0 14px rgba(0,193,175,0)}}';
  const card = document.createElement('div');
  card.className = 'plate';
  card.tabIndex = -1;
  card.style.cssText = `position:absolute;max-width:370px;width:calc(100vw - 24px);${reduced ? '' : 'transition:top .35s cubic-bezier(.22,.61,.36,1),left .35s cubic-bezier(.22,.61,.36,1);'}`;
  wrap.append(style, hole, card);
  document.body.appendChild(wrap);
  document.documentElement.style.overflowAnchor = 'none';

  let index = 0;
  let target = null;
  let moving = false;
  let raf = 0;
  active = { wrap };

  const place = () => {
    if (!target || !visible(target)) return;
    const r = target.getBoundingClientRect();
    const pad = 8;
    hole.style.top = `${Math.max(-pad, r.top - pad)}px`;
    hole.style.left = `${Math.max(-pad, r.left - pad)}px`;
    hole.style.width = `${Math.min(innerWidth + pad * 2, r.width + pad * 2)}px`;
    hole.style.height = `${Math.min(innerHeight + pad * 2, r.height + pad * 2)}px`;
    const vw = innerWidth, vh = innerHeight;
    if (vw < 640) {
      card.style.left = '12px';
      card.style.top = `${Math.max(12, vh - card.offsetHeight - 12)}px`;
      return;
    }
    const below = r.bottom + pad + 12;
    card.style.top = `${below + card.offsetHeight + 12 < vh ? below : Math.max(12, r.top - pad - card.offsetHeight - 12)}px`;
    card.style.left = `${Math.min(Math.max(12, r.left), vw - card.offsetWidth - 12)}px`;
  };

  async function showStep(nextIndex, direction = 1) {
    if (moving || !active || active.wrap !== wrap) return;
    moving = true;
    let candidate = nextIndex;
    while (candidate >= 0 && candidate < T.steps.length) {
      const step = T.steps[candidate];
      if (navigate) await Promise.resolve(navigate(step.view));
      await frame(); await frame();
      if (!active || active.wrap !== wrap) return;
      target = findTarget(step.sel);
      if (target) break;
      candidate += direction;
    }
    if (!target || candidate < 0 || candidate >= T.steps.length) { finish(); return; }
    index = candidate;
    const step = T.steps[index];
    card.innerHTML = `
      <div class="hint" aria-live="polite" style="font-family:var(--mono);font-size:11px;letter-spacing:.08em;margin:0 0 6px">${index + 1} ${T.of} ${T.steps.length}</div>
      <h3 style="margin:0 0 8px">${step.title}</h3>
      <p class="hint" style="margin:0">${step.text}</p>
      <div class="row wrap" style="display:flex;gap:8px;margin-top:14px;align-items:center">
        ${index ? `<button id="tour-back" class="btn btn-ghost" style="padding:10px 14px">${T.back}</button>` : ''}
        <button id="tour-next" class="btn btn-kaspa" style="padding:10px 18px">${index === T.steps.length - 1 ? T.done : T.next}</button>
        <button id="tour-skip" class="btn btn-ghost" style="padding:10px 14px">${T.skip}</button>
      </div>`;
    const back = card.querySelector('#tour-back');
    if (back) back.onclick = () => showStep(index - 1, -1);
    card.querySelector('#tour-next').onclick = () => index === T.steps.length - 1 ? finish() : showStep(index + 1, 1);
    card.querySelector('#tour-skip').onclick = finish;
    target.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
    moving = false;
    requestAnimationFrame(place);
    setTimeout(place, reduced ? 0 : 360);
    card.querySelector('#tour-next').focus({ preventScroll: true });
  }

  function finish() {
    if (!active) return;
    try { localStorage.setItem(DONE_KEY, '1'); } catch {}
    window.removeEventListener('resize', place);
    window.removeEventListener('scroll', onScroll, true);
    wrap.removeEventListener('keydown', onKey);
    document.documentElement.style.overflowAnchor = previousOverflowAnchor;
    if (navigate) navigate(initialRoute);
    const remove = () => {
      wrap.remove(); active = null;
      const focus = visible(previousFocus) ? previousFocus : document.getElementById('tb-title');
      if (focus && focus.focus) focus.focus({ preventScroll: true });
    };
    if (reduced) { remove(); return; }
    wrap.style.transition = 'opacity .2s ease-out';
    wrap.style.opacity = '0';
    setTimeout(remove, 210);
  }
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); finish(); return; }
    if (e.key === 'Enter' || e.key === 'ArrowRight') { e.preventDefault(); index === T.steps.length - 1 ? finish() : showStep(index + 1, 1); return; }
    if (e.key === 'ArrowLeft' && index > 0) { e.preventDefault(); showStep(index - 1, -1); return; }
    if (e.key === 'Tab') {
      const buttons = [...card.querySelectorAll('button')];
      if (!buttons.length) return;
      const pos = buttons.indexOf(document.activeElement);
      const next = e.shiftKey ? (pos <= 0 ? buttons.length - 1 : pos - 1) : (pos >= buttons.length - 1 ? 0 : pos + 1);
      e.preventDefault(); buttons[next].focus();
    }
  };
  const onScroll = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(place); };
  wrap.addEventListener('keydown', onKey);
  window.addEventListener('resize', place);
  window.addEventListener('scroll', onScroll, true);
  showStep(0);
  return true;
}

/** Auto-start once after a brand-new profile has been created. */
export function maybeStartDeskTour(options = {}) {
  try {
    if (sessionStorage.getItem(ONBOARD_FLAG) !== '1') return false;
    sessionStorage.removeItem(ONBOARD_FLAG);
    if (localStorage.getItem(DONE_KEY)) return false;
  } catch { return false; }
  setTimeout(() => startDeskTour(options), 800);
  return true;
}
