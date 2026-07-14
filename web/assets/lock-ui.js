// kaspa-safe/web/assets/lock-ui.js — DOM gate over session: onboarding/unlock/migration + password re-prompt modal.
import * as session from './session.js';
import { core, ready } from './core7.js';
import { passphraseStrength, parseProfileFile, isEncryptedProfile } from './identity.js';   // pure (DOM-free) — don't duplicate password-strength logic
import { promptPassword, confirmBox, trapFocus } from './dialog.js';   // masked password input + focus trap (native prompt showed the password in plain text)

// i18n: language from <html lang> (same mechanism as app.js:lang()); dictionary is local —
// lock-ui deliberately does not import app.js (the versioned ?v=N URL would create a duplicate module).
const RU = (document.documentElement.lang || 'en').slice(0, 2) === 'ru';
const T = RU ? {
  pw: 'Пароль', pw2: 'Повтори пароль', busy: 'Работаю…',
  s_ok: 'сила: ок', s_weak: 'слабый — длиннее и разнообразнее',
  ob_title: 'Создай пароль доступа', ob_btn: 'Создать',
  ob_hint: 'Пароль шифрует твой профиль в этом браузере. Мы его не знаем и восстановить не сможем.',
  ob_ctx: 'Ключ сделки сохранится в этот профиль — один шифрованный файл на все твои сделки.',
  e_weak: 'Пароль слишком слабый — длиннее и разнообразнее', e_mismatch: 'Пароли не совпадают',
  restore: 'Восстановить из бэкапа', bk_pw: 'Пароль файла бэкапа:',
  e_badpw: 'Неверный пароль или битый файл', e_notkeys: 'Не похоже на файл ключей',
  dev_pw: 'Задай пароль для этого устройства:', e_weak2: 'Пароль слишком слабый',
  e_restore: 'Не удалось восстановить',
  mg_title: 'Зашифруй свои ключи', mg_btn: 'Зашифровать',
  mg_hint: 'В этом браузере уже есть ключи. Задай пароль — зашифруем их. После этого файл ключей защищён.',
  ul_title: 'Введи пароль', ul_btn: 'Открыть', ul_hint: 'Разблокируй панель своим паролем.',
  ul_forgot: 'Забыл пароль? Его не восстановить — но профиль можно вернуть из файла бэкапа (.age).',
  rs_replace: 'Восстановление заменит профиль этого браузера файлом бэкапа. Всё, что появилось ПОСЛЕ бэкапа (новые сделки/чаты/свопы), из этого браузера исчезнет. Продолжить?',
  e_wrongpw: 'Неверный пароль',
  cf_title: 'Подтверди пароль', cf_ok: 'Подтвердить', cf_cancel: 'Отмена',
} : {
  pw: 'Password', pw2: 'Repeat password', busy: 'Working…',
  s_ok: 'strength: ok', s_weak: 'weak — make it longer and more varied',
  ob_title: 'Create your access password', ob_btn: 'Create',
  ob_hint: "This password encrypts your profile in this browser. We don't know it and can't recover it.",
  ob_ctx: 'Your deal key will be saved into this profile — one encrypted file for all your deals.',
  e_weak: 'Password is too weak — make it longer and more varied', e_mismatch: "Passwords don't match",
  restore: 'Restore from backup', bk_pw: 'Backup file password:',
  e_badpw: 'Wrong password or corrupted file', e_notkeys: "Doesn't look like a key file",
  dev_pw: 'Set a password for this device:', e_weak2: 'Password is too weak',
  e_restore: 'Restore failed',
  mg_title: 'Encrypt your keys', mg_btn: 'Encrypt',
  mg_hint: 'This browser already has keys. Set a password to encrypt them — after that your key file is protected.',
  ul_title: 'Enter your password', ul_btn: 'Open', ul_hint: 'Unlock the panel with your password.',
  ul_forgot: "Forgot it? It can't be recovered — but your profile can be restored from a backup file (.age).",
  rs_replace: "Restoring replaces this browser's profile with the backup file. Anything created AFTER that backup (new deals/chats/swaps) will disappear from this browser. Continue?",
  e_wrongpw: 'Wrong password',
  cf_title: 'Confirm your password', cf_ok: 'Confirm', cf_cancel: 'Cancel',
};

let _wired = false;
export async function wireCrypto() {
  if (_wired) return; await ready;
  session.setCrypto({
    encrypt: core.encrypt_profile, decrypt: core.decrypt_profile, exportEncrypt: core.encrypt_profile,
    genKeys: () => JSON.parse(core.gen_keys()), addr: core.pubkey_to_address,
    // master seed and deterministic derivation (profile v3); `?.` — a cached older wasm core
    genSeed: () => (core.gen_seed ? core.gen_seed() : null),
    deriveKeys: (seed, domain, i) => JSON.parse(core.derive_keys(seed, domain, i)),
  });
  // Auto-lock: unlock overlay IN PLACE, no reload — reloading destroyed typed text
  // (a chat message, a half-filled form). At lock time the profile is guaranteed to exist
  // (we were unlocked) → unlockFlow path, no net needed. Desk UX review 2026-07-09.
  session.onLock(() => { requireUnlock(); });
  _wired = true;
}

function overlay(html) {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(8,10,14,.92);padding:20px';
  el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true');
  el.innerHTML = `<div class="plate" style="max-width:420px;width:100%">${html}</div>`;
  document.body.appendChild(el);
  trapFocus(el);   // Tab must not wander over the locked page UNDER the overlay (a11y review 2026-07-09)
  return el;
}

// opts (both optional, all existing call sites without them behave as before):
//   context    — html string "what this action is" (purchase: role · amount) above the overlay hint;
//                TRUSTED markup, the caller escapes any UGC. Added for the market join flow:
//                unlock there moved from page load to the Join click, and a password wall
//                without purchase context was the main drop-off point (UX review 2026-07-09).
//   cancelable — a "Cancel" button: resolve(false), no profile is created/opened.
// Returns true (unlocked) | false (cancelled). Legacy callers ignore the result.
export async function requireUnlock(net, opts = {}) {
  await wireCrypto();
  if (session.isUnlocked()) return true;
  if (session.hasEncryptedProfile()) {
    // this tab already unlocked the profile — navigation/reload must not re-ask the password
    // (session is per-tab, dies with the tab and via 15-min auto-lock; owner feedback 2026-07-09: prompts were too frequent)
    if (session.tryResume()) return true;
    return unlockFlow(opts);
  }
  if (session.hasLegacyPlaintext()) return migrateFlow(net, opts);
  return onboardFlow(net, opts);
}

function pwFlow({ title, hint, btn, twoFields, onSubmit, secondary, context, cancelable }) {
  return new Promise((resolve) => {
    const el = overlay(`<h2>${title}</h2>
      ${context ? `<p class="hint" style="border:1px solid var(--bd);border-radius:6px;padding:9px 11px;color:var(--ingot)">${context}</p>` : ''}
      <p class="hint">${hint}</p>
      <input type="password" id="lu-p1" placeholder="${T.pw}" autofocus>
      ${twoFields ? `<input type="password" id="lu-p2" placeholder="${T.pw2}" style="margin-top:8px">` : ''}
      <div class="hint" id="lu-s" style="margin-top:6px"></div>
      <p id="lu-e" class="note alarm" style="display:none"></p>
      <button id="lu-go" class="btn btn-kaspa" style="margin-top:12px">${btn}</button>
      ${secondary ? `<button id="lu-alt" class="btn btn-ghost" style="margin-top:8px">${secondary.label}</button>` : ''}
      ${cancelable ? `<button id="lu-x" class="btn btn-ghost" style="margin-top:8px">${T.cf_cancel}</button>` : ''}`);
    const $ = (id) => el.querySelector('#' + id);
    const showErr = (m) => { $('lu-e').style.display = 'block'; $('lu-e').textContent = m; };
    if (twoFields) $('lu-p1').oninput = () => { $('lu-s').textContent =
      passphraseStrength($('lu-p1').value).ok ? T.s_ok : T.s_weak; };
    if (secondary) $('lu-alt').onclick = () => secondary.run({ el, resolve, showErr });
    if (cancelable) $('lu-x').onclick = () => { el.remove(); resolve(false); };
    // Enter = submit (the product's most frequent action was mouse-only — UX review 2026-07-09), Esc = cancel.
    // Don't intercept Enter ON A BUTTON — otherwise Enter on a focused "Restore"/"Cancel" would press the primary.
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName !== 'BUTTON' && !$('lu-go').disabled) { e.preventDefault(); $('lu-go').click(); }
      if (e.key === 'Escape' && cancelable) { e.preventDefault(); el.remove(); resolve(false); }
    });
    $('lu-p1').focus();   // the autofocus attribute on dynamically inserted nodes doesn't fire everywhere
    $('lu-go').onclick = async () => {
      $('lu-e').style.display = 'none';
      const p1 = $('lu-p1').value, p2 = twoFields ? $('lu-p2').value : p1;
      const btnEl = $('lu-go'); const orig = btnEl.textContent; btnEl.disabled = true; btnEl.textContent = T.busy;
      await new Promise((r) => setTimeout(r, 0));           // let the browser repaint BEFORE the blocking ~1s scrypt
      try {
        const ok = await onSubmit(p1, p2, showErr);
        if (ok) { el.remove(); resolve(true); return; }
      } catch (err) { showErr(err.message); }
      btnEl.disabled = false; btnEl.textContent = orig;     // error/weak password/mismatch → restore the button
    };
  });
}

function onboardFlow(net, opts = {}) {
  return pwFlow({ title: T.ob_title, btn: T.ob_btn, twoFields: true, ...opts,
    // with purchase context, add a one-line "why a password" — a newcomer arriving via a
    // seller's link otherwise has no idea what a profile has to do with it
    hint: opts.context ? `${T.ob_hint} ${T.ob_ctx}` : T.ob_hint,
    onSubmit: (p1, p2, err) => {
      if (!passphraseStrength(p1).ok) { err(T.e_weak); return false; }
      if (p1 !== p2) { err(T.e_mismatch); return false; }
      session.onboard(p1, net);
      // "keys just created" marker — desk uses it to show the newcomer tour (desk-tour.js).
      // sessionStorage: survives navigation within this tab, dies with it; restore/unlock/
      // migrate do NOT set the marker — the tour never bothers an experienced user.
      try { sessionStorage.setItem('kaspa-just-onboarded', '1'); } catch {}
      return true;
    },
    secondary: { label: T.restore, run: (ctx) => restoreFromBackup(net, ctx) } });
}

// pick .age/.json → adopt the profile WHOLESALE. For .age, its password BECOMES the device password.
async function restoreFromBackup(net, { el, resolve, showErr }) {
  const alt = el.querySelector('#lu-alt'); if (alt) alt.disabled = true;
  try {
    const text = await pickFileText('.age,.json,application/json,text/plain');
    if (text == null) return;                               // cancelled — stay on onboarding
    let profile;
    if (isEncryptedProfile(text)) {
      const pw = await promptPassword(T.bk_pw); if (pw == null) return;
      try { profile = parseProfileFile(core.decrypt_profile(text, pw)); } catch { showErr(T.e_badpw); return; }
      session.adoptProfile(profile, pw); el.remove(); resolve(true); return;   // .age: its password = the device password
    }
    try { profile = parseProfileFile(text); } catch { showErr(T.e_notkeys); return; }
    const np = await promptPassword(T.dev_pw);
    if (np == null) return;                                  // cancelled (NOT to be confused with a weak password)
    if (!passphraseStrength(np).ok) { showErr(T.e_weak2); return; }
    session.adoptProfile(profile, np); el.remove(); resolve(true);
  } catch (err) {
    showErr((err && err.message) || T.e_restore);
  } finally {
    if (alt && document.body.contains(alt)) alt.disabled = false;   // re-enable if the overlay is still alive
  }
}
function pickFileText(accept) {
  return new Promise((res) => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = accept;
    inp.onchange = async () => { const f = inp.files[0]; res(f ? await f.text() : null); };
    inp.oncancel = () => res(null);
    inp.click();
  });
}
function migrateFlow(net, opts = {}) {
  return pwFlow({ title: T.mg_title, btn: T.mg_btn, twoFields: true, ...opts,
    hint: T.mg_hint,
    onSubmit: (p1, p2, err) => {
      if (!passphraseStrength(p1).ok) { err(T.e_weak2); return false; }
      if (p1 !== p2) { err(T.e_mismatch); return false; }
      session.migrateAndEncrypt(p1, net); return true;
    } });
}
function unlockFlow(opts = {}) {
  // "Forgot password" is not a dead end: the holder of a valid backup restores the profile
  // right here (onboarding had the button, unlock didn't; UX review 2026-07-09). Restore replaces
  // this browser's profile with the file wholesale — for someone who forgot the password, that's exactly the goal.
  return pwFlow({ title: T.ul_title, btn: T.ul_btn, twoFields: false, ...opts,
    hint: `${T.ul_hint} ${T.ul_forgot}`,
    onSubmit: (p1, _p2, err) => { if (session.unlock(p1)) return true; err(T.e_wrongpw); return false; },
    // unlike onboarding, a profile ALREADY exists here — warn that restore will replace it
    secondary: { label: T.restore, run: async (ctx) => {
      if (!await confirmBox(T.rs_replace, { danger: true })) return;
      return restoreFromBackup(undefined, ctx);
    } } });
}

// Re-asking the password for EVERY money/key action is deliberate (decision 2026-07-09):
// unlock survives navigation (tryResume), but confirming a send/export/funding remains a
// separate barrier against XSS-on-an-unlocked-tab and "stepped away from the computer".
// opts.context — TRUSTED html string "what exactly you are confirming" (amount + send address etc.)
// shown as a strip above the reason: blind confirmation (no amount/recipient) devalued the
// barrier itself — P0 of the desk review 2026-07-09. The caller escapes UGC (as in requireUnlock opts.context).
export function confirmPassword(reason, opts = {}) {
  return new Promise((resolve) => {
    const el = overlay(`<h2>${T.cf_title}</h2>
      ${opts.context ? `<p class="hint" style="border:1px solid var(--bd);border-radius:6px;padding:9px 11px;color:var(--ingot)">${opts.context}</p>` : ''}
      <p class="hint">${reason}</p>
      <input type="password" id="cp-p" placeholder="${T.pw}" autofocus>
      <p id="cp-e" class="note alarm" style="display:none">${T.e_wrongpw}</p>
      <div class="row wrap" style="gap:8px;margin-top:12px">
        <button id="cp-ok" class="btn btn-kaspa">${T.cf_ok}</button>
        <button id="cp-x" class="btn btn-ghost">${T.cf_cancel}</button></div>`);
    const cancel = () => { el.remove(); resolve(false); };
    el.querySelector('#cp-x').onclick = cancel;
    el.querySelector('#cp-ok').onclick = () => {
      if (session.confirm(el.querySelector('#cp-p').value)) { el.remove(); resolve(true); }
      else el.querySelector('#cp-e').style.display = 'block';
    };
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); el.querySelector('#cp-ok').click(); }
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
    el.querySelector('#cp-p').focus();
  });
}
