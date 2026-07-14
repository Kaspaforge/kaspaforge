// Kaspa Safe — shared page module: wasm core, API, coin indicator, local store.
// INVARIANT: private keys never leave the browser; only addresses, pubkeys and
// already-signed transactions go to the server.

import init, * as core from './vault-core-v3/kaspa_safe_core.js';
import { getVaults, setVaults, loadProfile, saveProfile,
  isProfileRecordTombstoned, tombstoneProfileRecord } from './identity.js';

export { core };

// API base: on the site itself (and its PWA) — same-origin (''); in any other context
// (Tauri APK on tauri.localhost, a local offline copy) — the absolute production origin.
// Site hosts: canonical kaspaforge.org + legacy *.officeforge.co (safe./escrow. still carry
// SEO landings, recover and the arbiter console). Forgetting a host here = silently going cross-origin.
// NOTE: older APKs carry a baked-in fallback to safe.officeforge.co — its /api/safe/ stays alive.
const SITE_HOSTS = /(^|\.)kaspaforge\.org$|(^|\.)officeforge\.co$/;
const API_ORIGIN = SITE_HOSTS.test(location.hostname) ? '' : 'https://kaspaforge.org';

let network = null; // "mainnet" | "simnet" | "testnet"

export async function boot() {
  await init();
  // wasm-core smoke test outside the site (APK/offline copy): logcat/CI marker, before any network call
  if (API_ORIGIN) {
    try { JSON.parse(core.gen_keys()); console.log('[ksafe-core] ok'); }
    catch (e) { console.log('[ksafe-core] FAIL ' + e); }
  }
  const info = await api('/api/safe/info');
  const n = (info.network || '').toLowerCase();
  network = n.includes('mainnet') ? 'mainnet' : n.includes('testnet') ? 'testnet' : 'simnet';
  return { ...info, network };
}

export function net() { return network; }

// Explorer (mainnet only — test nets have no public one). Same pattern as escrow.js —
// not imported from there, to avoid pulling an Escrow asset into Safe pages for 2 lines.
export function explorerTx(txid) {
  return net() === 'mainnet' && txid ? `https://kaspa.stream/transactions/${encodeURIComponent(txid)}` : null;
}

// ── i18n: language from <html lang>; dictionary only for dynamic JS strings ──
export function lang() { return (document.documentElement.lang || 'en').slice(0, 2); }
const DICT = {
  en: {
    node_down: 'node unavailable', server: 'server', vault_empty: 'vault empty',
    delay_6h: '6 hours', delay_24h: '24 hours (recommended)', delay_48h: '48 hours',
    delay_7d: '7 days', delay_14d: '14 days', delay_custom: 'Custom…',
    delay_will: 'No delay — will mode (~1 min)',
    will_warn: '<b>⚠ THIS MODE DOES NOT PROTECT AGAINST THEFT.</b> A thief with your hot key takes the funds at once — the cancel window is seconds, the alarm key is useless. What remains is inheritance: the vault still works as a will, so inheritance is <b>required</b> in this mode. TG alerts will still tell you about any withdrawal (after the fact). Withdrawals feel near-instant: auto-complete delivers them in ~10–30 s.',
    will_inherit_req: 'Will mode requires inheritance — without an heir this vault protects nothing at all. Pick a check-in period.',
    inh_off: 'No heir (disabled)', inh_6m: '6 months', inh_12m: '12 months', inh_24m: '24 months',
    hours: 'hours', minutes: 'min', days: 'days', months: 'months',
    u_hours: 'hours', u_days: 'days',
    // delay picker UX
    frozen_for: (h) => `Funds will be frozen for <b>${h}</b> after you start a withdrawal.`,
    rec_general: 'For amounts over 10,000 KAS we recommend at least 24 hours.',
    warn_short: 'Short window — little time to react to a theft.',
    warn_long: 'Very long — your own withdrawals will wait this long too.',
    delay_min_err: 'Minimum cancel window is 1 hour.',
    delay_max_err: 'Maximum cancel window is 90 days.',
    fund_high_delay: 'Large amount with a short window — a longer cancel window would be safer.',
    // inheritance picker UX
    u_months: 'months',
    inh_default_hint: 'If you stop checking in for this long, your heir can claim the funds. Requires an heir address on the next step. Leave off to disable.',
    inh_info: (h) => `Your heir can claim the funds after <b>${h}</b> without a check-in. Any spend or check-in resets this timer.`,
    inh_min_err: 'Minimum inheritance period is 1 day.',
    inh_max_err: 'Maximum inheritance period is 5 years.',
    // auto-complete
    autocomplete_label: 'Auto-complete the withdrawal when the cancel window closes (recommended). If off, you finish it yourself.',
    inh_mode_auto_info: 'Funds are delivered to the heir automatically after the period — the heir needs no key or software.',
    inh_mode_signed_info: 'The heir must actively claim the funds with their own key. Nothing moves on its own.',
    // create
    forging: 'forging…', lock_btn: 'Lock into vault', heir_err: 'Enter a valid heir address or turn inheritance off',
    over_cap: '<b>Over 5,000 KAS.</b> That is above the beta cap — send less or continue at your own risk.',
    bot_soon: 'the bot (soon)', in_vault: 'in vault',
    // manage
    confirm_wd: (a) => `Withdraw to ${a}\nThe address is locked forever. Continue?`,
    st_coins: 'coins in vault', st_wd: 'withdrawal (cancel window)', st_empty: 'empty', withdrawing: 'withdrawing',
    win_left: (h) => `${h} left`, win_closed: 'window closed', claim_now: 'window closed — claim now', empty_lbl: 'empty',
    wd_tx_link: 'View the withdrawal transaction →',
    no_token_sub: 'no service token — alerts unavailable', sub_active: (d) => `active until ${d}`, sub_inactive: 'inactive',
    no_token_tg: 'no service token (it is on your recovery sheet) — alerts unavailable', bot_soon2: '(bot soon)',
    forget_confirm: 'Remove this vault from your Desk? With Forge Sync enabled, the removal also reaches your other devices. An explicit key-file import can restore it.',
    inh_left: (t) => `the heir can claim in ${t}`, inh_ripe: 'period expired — the vault is open to the heir',
    sheet_bad: "This doesn't look like a Kaspa Safe recovery sheet (no pubkeys / delay found)",
    sheet_mismatch: 'Opened, but the vault address differs from the one printed on the sheet — double-check the sheet file.',
    // vault portfolio
    vb_total: (s) => `Total in vaults: ${s}`, vb_rename: 'Vault label:', vb_unnamed: 'Vault',
    // heir contact
    hc_saved: 'Saved. We will email your heir when the inheritance window opens.',
    hc_cleared: 'Cleared — the heir will not be notified.',
  },
  ru: {
    node_down: 'нода недоступна', server: 'сервер', vault_empty: 'сейф пуст',
    delay_6h: '6 часов', delay_24h: '24 часа (рекомендуем)', delay_48h: '48 часов',
    delay_7d: '7 дней', delay_14d: '14 дней', delay_custom: 'Своё значение…',
    delay_will: 'Без задержки — режим завещания (~1 мин)',
    will_warn: '<b>⚠ ЭТОТ РЕЖИМ НЕ ЗАЩИЩАЕТ ОТ КРАЖИ.</b> Вор с горячим ключом уведёт средства сразу — окно отмены секундное, тревожный ключ бесполезен. Остаётся наследование: сейф продолжает работать как завещание, поэтому наследование в этом режиме <b>обязательно</b>. TG-алерты по-прежнему сообщат о любом выводе (постфактум). Вывод почти мгновенный: авто-завершение довозит средства за ~10–30 с.',
    will_inherit_req: 'В режиме завещания наследование обязательно — без наследника такой сейф не защищает вообще ничего. Выбери срок чекина.',
    inh_off: 'Без наследника (выкл)', inh_6m: '6 месяцев', inh_12m: '12 месяцев', inh_24m: '24 месяца',
    hours: 'ч', minutes: 'мин', days: 'дн', months: 'мес',
    u_hours: 'часы', u_days: 'дни',
    frozen_for: (h) => `Деньги будут заморожены на <b>${h}</b> после инициирования вывода.`,
    rec_general: 'Для сумм больше 10 000 KAS рекомендуем минимум 24 часа.',
    warn_short: 'Короткое окно — мало времени среагировать на кражу.',
    warn_long: 'Очень долго — свои выводы ты тоже будешь ждать столько же.',
    delay_min_err: 'Минимальное окно отмены — 1 час.',
    delay_max_err: 'Максимальное окно отмены — 90 дней.',
    fund_high_delay: 'Крупная сумма при коротком окне — длиннее окно отмены было бы безопаснее.',
    u_months: 'месяцы',
    inh_default_hint: 'Если перестанешь отмечаться на этот срок — наследник сможет забрать средства. Нужен адрес наследника на след. шаге. Выкл — отключить.',
    inh_info: (h) => `Наследник сможет забрать средства после <b>${h}</b> без чекина. Любая трата или чекин сбрасывают этот таймер.`,
    inh_min_err: 'Минимальный срок наследования — 1 день.',
    inh_max_err: 'Максимальный срок наследования — 5 лет.',
    autocomplete_label: 'Автоматически завершать вывод по окончании окна отмены (рекомендуем). Если выкл — завершаешь вручную.',
    inh_mode_auto_info: 'Средства уйдут наследнику автоматически после срока — наследнику не нужен ни ключ, ни софт.',
    inh_mode_signed_info: 'Наследник должен сам забрать средства своим ключом. Само ничего не переведётся.',
    forging: 'куём…', lock_btn: 'Заложить в сейф', heir_err: 'Введите корректный адрес наследника или выключите наследование',
    over_cap: '<b>Больше 5 000 KAS.</b> Это выше бета-лимита — уменьшите сумму или продолжайте на свой риск.',
    bot_soon: 'бота (скоро)', in_vault: 'в сейфе',
    confirm_wd: (a) => `Вывод на ${a}\nАдрес фиксируется навсегда. Продолжить?`,
    st_coins: 'монеты в сейфе', st_wd: 'идёт вывод (окно отмены)', st_empty: 'пусто', withdrawing: 'идёт вывод',
    win_left: (h) => `ещё ${h}`, win_closed: 'окно закрыто', claim_now: 'окно закрыто — можно забирать', empty_lbl: 'пусто',
    wd_tx_link: 'Транзакция вывода на эксплорере →',
    no_token_sub: 'нет сервисного токена — алерты недоступны', sub_active: (d) => `активна до ${d}`, sub_inactive: 'неактивна',
    no_token_tg: 'нет сервисного токена (он в recovery-листе) — алерты недоступны', bot_soon2: '(бот скоро)',
    forget_confirm: 'Удалить сейф из Desk? При включённом Forge Sync удаление придёт и на другие устройства. Явный импорт файла ключей сможет восстановить его.',
    inh_left: (t) => `наследник сможет забрать через ${t}`, inh_ripe: 'срок истёк — сейф открыт наследнику',
    sheet_bad: 'Не похоже на recovery-лист Kaspa Safe (не нашёл pubkey-ключи / задержку)',
    sheet_mismatch: 'Сейф открыт, но адрес не совпал с напечатанным в листе — перепроверь файл листа.',
    // vault portfolio
    vb_total: (s) => `Всего в сейфах: ${s}`, vb_rename: 'Название сейфа:', vb_unnamed: 'Сейф',
    // heir contact
    hc_saved: 'Сохранено. Уведомим наследника по email, когда откроется окно наследования.',
    hc_cleared: 'Очищено — наследник уведомляться не будет.',
  },
};
export function L(key) { return (DICT[lang()] || DICT.en)[key] || key; }

// Printable recovery sheet (the only copy of the keys) — bilingual.
export function recoverySheet(d) {
  const ru = lang() === 'ru';
  const mode = d.autoInherit ? (ru ? 'авто' : 'automatic') : (ru ? 'ручной (подпись наследника)' : 'manual (heir signs)');
  const inh = d.inheritDelay > 0 ? `${d.inheritDelay} DAA (${d.inheritHuman}), ${ru ? 'режим' : 'mode'}: ${mode}` : (ru ? 'выключено' : 'disabled');
  // Delay below the UI minimum (1 hour) = will mode: state honestly on the sheet that
  // theft protection is off — so the owner doesn't believe they're protected a year later.
  // A "Key: value" line with an UNKNOWN key is ignored by both sheet parsers (manage, vaultctl).
  const will = d.delay < H;
  return (ru ? [
    'KASPA SAFE — RECOVERY-ЛИСТ (ЕДИНСТВЕННАЯ КОПИЯ КЛЮЧЕЙ)',
    '='.repeat(60),
    `Дата: ${d.date}`, `Сеть: ${d.network}`,
    `Задержка вывода: ${d.delay} DAA (${d.delayHuman})`,
    ...(will ? ['Режим завещания: АНТИ-КРАЖА ВЫКЛЮЧЕНА (окно отмены ~минута — вора не остановить). Работает только наследование.'] : []),
    `Наследование: ${inh}`,
    `Бюджет комиссии: ${d.feeBudget || 1000000} sompi`, '',
    `Адрес сейфа:      ${d.vaultAddr}`,
    `Горячий ключ:     ${d.hot_sk}`, `Горячий pubkey:   ${d.hot_pk}`,
    `Тревожный ключ:   ${d.alarm_sk || 'НА ТРЕВОЖНОЙ КАРТОЧКЕ (в профиле только pubkey — так задумано)'}`, `Тревожный pubkey: ${d.alarm_pk}`,
    `Ключ закладки:    ${d.funding_sk}`,
    d.inheritDelay > 0 ? `Pubkey наследника:${d.heirPk}` : 'Наследник:        выключен',
    `Сервисный токен:  ${d.token}`, '',
    'ВОССТАНОВЛЕНИЕ БЕЗ САЙТА: сейф — ончейн-контракт Kaspa, не зависит',
    'от kaspaforge.org. Инструкция: https://kaspaforge.org/ru/recover.html',
    'Открытый код и офлайн-тулза vaultctl (лист подаётся как есть):',
    'https://github.com/Kaspaforge/kaspaforge', '',
    'ХРАНИ ТРЕВОЖНЫЙ КЛЮЧ ОТДЕЛЬНО ОТ ГОРЯЧЕГО.',
    'Бета. Лимит здравого смысла — 5 000 KAS.',
  ] : [
    'KASPA SAFE — RECOVERY SHEET (THE ONLY COPY OF YOUR KEYS)',
    '='.repeat(60),
    `Date: ${d.date}`, `Network: ${d.network}`,
    `Withdrawal delay: ${d.delay} DAA (${d.delayHuman})`,
    ...(will ? ['Will mode: THEFT PROTECTION IS OFF (cancel window ~a minute — a thief cannot be stopped). Only inheritance applies.'] : []),
    `Inheritance: ${inh}`,
    `Fee budget: ${d.feeBudget || 1000000} sompi`, '',
    `Vault address:  ${d.vaultAddr}`,
    `Hot key:        ${d.hot_sk}`, `Hot pubkey:     ${d.hot_pk}`,
    `Alarm key:      ${d.alarm_sk || 'ON YOUR ALARM CARD (profile keeps only the pubkey — by design)'}`, `Alarm pubkey:   ${d.alarm_pk}`,
    `Funding key:    ${d.funding_sk}`,
    d.inheritDelay > 0 ? `Heir pubkey:    ${d.heirPk}` : 'Heir:           disabled',
    `Service token:  ${d.token}`, '',
    'RECOVERY WITHOUT THIS SITE: your vault is an on-chain Kaspa contract,',
    'independent of kaspaforge.org. Guide: https://kaspaforge.org/recover.html',
    'Open source and the offline vaultctl tool (feed this sheet as is):',
    'https://github.com/Kaspaforge/kaspaforge', '',
    'KEEP THE ALARM KEY SEPARATE FROM THE HOT KEY.',
    'Beta. Common-sense cap — 5,000 KAS.',
  ]).join('\n');
}

// mainnet: 10 blocks/s → 1 hour = 36,000 DAA
export const H = 36000, D = 24 * H, MO = 30 * D;
export const DELAY_MIN = H;        // 1 hour — UI minimum for REGULAR vaults (server/contract accept any ≥1 DAA)
export const WILL_DELAY = 600;     // ~1 minute — the "will mode" preset: theft protection off, only inheritance remains
export const DELAY_MAX = 90 * D;   // 90 days
export const INHERIT_MIN = D;      // 1 day
export const INHERIT_MAX = 1825 * D; // 5 years

// DAA presets for the cancel window
export function delayOptions() {
  if (network === 'mainnet') return [
    { daa: WILL_DELAY, label: L('delay_will') },
    { daa: 6 * H, label: L('delay_6h') },
    { daa: 24 * H, label: L('delay_24h') },
    { daa: 48 * H, label: L('delay_48h') },
    { daa: 7 * D, label: L('delay_7d') },
    { daa: 14 * D, label: L('delay_14d') },
  ];
  return [
    { daa: 60, label: '60 DAA (~1 min on simnet mining)' },
    { daa: 300, label: '300 DAA' },
  ];
}
// Inheritance period options; the first = disabled (heir empty).
export function inheritOptions() {
  if (network === 'mainnet') return [
    { daa: 0, label: L('inh_off') },
    { daa: 6 * MO, label: L('inh_6m') },
    { daa: 12 * MO, label: L('inh_12m') },
    { daa: 24 * MO, label: L('inh_24m') },
  ];
  return [
    { daa: 0, label: L('inh_off') },
    { daa: 120, label: '120 DAA (test)' },
    { daa: 600, label: '600 DAA (test)' },
  ];
}
export function daaToHuman(daa) {
  if (network !== 'mainnet') return `${daa} DAA`;
  const h = daa / H, perMonth = 30 * D;
  const n = (x) => (Number.isInteger(x) ? x : x.toFixed(1));
  if (h < 1) return `${Math.round(h * 60)} ${L('minutes')}`;
  if (h <= 48) return `${n(h)} ${L('hours')}`;
  if (daa % perMonth === 0 && daa >= perMonth) return `${daa / perMonth} ${L('months')}`;
  if (daa % D === 0) return `${daa / D} ${L('days')}`;
  return `${n(daa / D)} ${L('days')}`;
}

// Convert number+unit ("12 hours", "3 days", "6 months") into DAA
export function unitToDaa(n, unit) {
  if (!(n > 0)) return NaN;
  const per = unit === 'm' ? MO : unit === 'd' ? D : H;
  return Math.round(n * per);
}

// ── API ──
export async function api(path, opts) {
  const r = await fetch(API_ORIGIN + path, opts);
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`${L('server')}: ${r.status}`); }
  if (!r.ok) throw new Error(j.error || `${L('server')}: ${r.status}`);
  return j;
}
// raw /utxos text — passed to wasm as is
export async function utxosRaw(address) {
  const r = await fetch(`${API_ORIGIN}/api/safe/utxos?address=${encodeURIComponent(address)}`);
  const text = await r.text();
  if (!r.ok) throw new Error(L('node_down'));
  return text;
}
export function utxosSum(rawText) {
  const list = JSON.parse(rawText); // beta amounts < 2^53 — safe
  return list.reduce((s, u) => s + u.amount, 0);
}
export async function submitTx(builtJsonString) {
  const built = JSON.parse(builtJsonString);
  return api('/api/safe/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tx: built.tx }),
  });
}

// ── vault portfolio: via the single encrypted profile (session) ──
// The active address is public, kept as pure UI state (not a secret); plaintext vault mirrors were removed.
const LSA = 'kaspa-safe-active';
export function loadVaults() { return getVaults(); }              // session is already unlocked by the page's boot guard
export function saveVaults(arr) { setVaults(arr); }
export function activeAddr() { return localStorage.getItem(LSA); }
export function setActiveAddr(addr) { localStorage.setItem(LSA, addr); }
export function loadVault() {
  const arr = loadVaults(); if (!arr.length) return null;
  return arr.find((v) => v.vault_addr === activeAddr()) || arr[0];
}
export function saveVault(v) {                                     // v MAY contain hot_sk/alarm_sk/funding_sk — stored (the profile is encrypted)
  const profile = loadProfile(), arr = profile.vaults;
  const i = arr.findIndex((x) => x.vault_addr === v.vault_addr);
  // Background refreshes must not recreate a record that another device explicitly deleted.
  if (i < 0 && isProfileRecordTombstoned(profile, 'vaults', v.vault_addr)) return false;
  if (i >= 0) arr[i] = { ...arr[i], ...v }; else arr.push(v);
  saveProfile(profile); localStorage.setItem(LSA, v.vault_addr); return true;
}
export function removeVault(addr) {
  const profile = loadProfile();
  tombstoneProfileRecord(profile, 'vaults', addr);
  saveProfile(profile);
  const arr = profile.vaults;
  if (activeAddr() === addr) { if (arr.length) setActiveAddr(arr[0].vault_addr); else localStorage.removeItem(LSA); }
}
export function clearVault() { const v = loadVault(); if (v) removeVault(v.vault_addr); }

// owner-token: authorizes registry writes (not a vault secret, but kept to ourselves)
export function genToken() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

// ── utilities ──
export const $ = (id) => document.getElementById(id);
export const kas = (sompi) => (sompi / 1e8).toLocaleString(
  (document.documentElement.lang || 'en').startsWith('ru') ? 'ru-RU' : 'en-US',
  { maximumFractionDigits: 4 }
) + ' KAS';
export function copyBtn(btn, text) {
  btn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(text());
    const t = btn.textContent; btn.textContent = 'ок'; setTimeout(() => (btn.textContent = t), 900);
  });
}
export function showErr(el, e) {
  el.textContent = '⚠ ' + (e.message || e);
  el.className = 'note alarm';
  el.style.display = 'block';
}
export function qrInto(el, data) {
  if (typeof qrcode === 'undefined') return;
  const q = qrcode(0, 'M'); q.addData(data); q.make();
  el.innerHTML = q.createImgTag(4, 8);
}

// ── coin indicator (signature element) ──
// state: vault | unvaulting | empty · progress: 0..1 (fraction of the cancel window)
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderCoin(el, state, progress = 0, label = '') {
  if (!['vault', 'unvaulting', 'empty'].includes(state)) state = 'empty';
  progress = Math.max(0, Math.min(1, Number(progress) || 0));
  label = esc(label);
  const C = 2 * Math.PI * 47;
  el.className = `coin coin--${state}`;
  el.innerHTML = `
  <svg viewBox="0 0 100 100" role="img" aria-label="Состояние сейфа: ${label || state}">
    <defs>
      <radialGradient id="patina" cx="38%" cy="32%">
        <stop offset="0%" stop-color="#C9D4D2"/>
        <stop offset="42%" stop-color="#5FB8AE"/>
        <stop offset="78%" stop-color="#00C1AF"/>
        <stop offset="100%" stop-color="#0A7C72"/>
      </radialGradient>
    </defs>
    <circle class="ring-track" cx="50" cy="50" r="47" fill="none" stroke-width="3"/>
    <circle class="ring-window" cx="50" cy="50" r="47" fill="none" stroke-width="3"
      stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${(C * (1 - progress)).toFixed(1)}"/>
    <g class="disk-wrap" style="transform-origin:50% 50%">
      <circle class="disk" cx="50" cy="50" r="40"/>
      <circle class="rim" cx="50" cy="50" r="40" fill="none" stroke-width="1.6"/>
      <circle class="rim" cx="50" cy="50" r="35.5" fill="none" stroke-width=".7" opacity=".45"/>
      <!-- Kaspa K-arrow: continuation of motion -->
      <path class="karrow" d="M58 32 v36 M38 34 L55 50 L38 66"/>
      <ellipse class="glint" cx="38" cy="30" rx="14" ry="7" fill="#fff" transform="rotate(-28 38 30)"/>
    </g>
  </svg>
  <div class="coin-label">${label}</div>`;
}
