// kaspa-safe/web/assets/dialog.js — house modals replacing native alert()/confirm()/prompt().
// Native dialogs on a trust-critical product look like "kaspaforge.org says…" (foreign chrome,
// browser locale, password in plain text in prompt) — desk review feedback (2026-07-09). Same visual
// language as the lock-ui.js overlays: .plate on a dimmed backdrop, Enter=primary, Esc=cancel, focus trapped.
const RU = (document.documentElement.lang || 'en').slice(0, 2) === 'ru';
const T = RU ? { ok: 'Ок', cancel: 'Отмена', pw: 'Пароль' }
             : { ok: 'OK', cancel: 'Cancel', pw: 'Password' };

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Tab must not escape under the modal — cycles inside (minimal focus trap; exported for lock-ui)
export function trapFocus(el) {
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const f = [...el.querySelectorAll('button,input,a[href],select,textarea')].filter((x) => !x.disabled && x.offsetParent);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
    else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
  });
}

function box(html) {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(8,10,14,.92);padding:20px';
  el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true');
  el.innerHTML = `<div class="plate" style="max-width:420px;width:100%">${html}</div>`;
  document.body.appendChild(el);
  trapFocus(el);
  return el;
}

/** alert replacement. msg is escaped (server e.message values land here too). opts.title — heading,
 *  opts.alarm — red note instead of hint (for errors). Enter/Esc/button close it. */
export function alertBox(msg, opts = {}) {
  return new Promise((resolve) => {
    const el = box(`${opts.title ? `<h2>${esc(opts.title)}</h2>` : ''}
      <p class="${opts.alarm ? 'note alarm' : 'hint'}" style="white-space:pre-wrap;margin:0">${esc(msg)}</p>
      <button class="btn btn-kaspa" style="margin-top:14px">${T.ok}</button>`);
    const done = () => { el.remove(); resolve(); };
    el.querySelector('button').onclick = done;
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); done(); } });
    el.querySelector('button').focus();
  });
}

/** confirm replacement → Promise<boolean>. Enter = OK, Esc = cancel.
 *  opts: title, ok/cancel — custom button labels, danger — message shown as a red note. */
export function confirmBox(msg, opts = {}) {
  return new Promise((resolve) => {
    const el = box(`${opts.title ? `<h2>${esc(opts.title)}</h2>` : ''}
      <p class="${opts.danger ? 'note alarm' : 'hint'}" style="white-space:pre-wrap;margin:0">${esc(msg)}</p>
      <div class="row wrap" style="gap:8px;margin-top:14px">
        <button id="dg-ok" class="btn btn-kaspa">${esc(opts.ok || T.ok)}</button>
        <button id="dg-x" class="btn btn-ghost">${esc(opts.cancel || T.cancel)}</button></div>`);
    const done = (v) => { el.remove(); resolve(v); };
    el.querySelector('#dg-ok').onclick = () => done(true);
    el.querySelector('#dg-x').onclick = () => done(false);
    el.addEventListener('keydown', (e) => {
      // Enter on a FOCUSED button is its native click (otherwise Enter on Cancel would press OK)
      if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); done(true); }
      if (e.key === 'Escape') { e.preventDefault(); done(false); }
    });
    el.querySelector('#dg-ok').focus();
  });
}

/** prompt replacement for plain TEXT → Promise<string|null> (null = cancel, '' = clear).
 *  opts: value — initial value (for editing), placeholder, maxlength (default 64). */
export function promptText(label, opts = {}) {
  return new Promise((resolve) => {
    const el = box(`<p class="hint" style="margin:0 0 8px">${esc(label)}</p>
      <input type="text" id="dg-t" maxlength="${Number(opts.maxlength) || 64}"
        value="${esc(opts.value || '')}" placeholder="${esc(opts.placeholder || '')}">
      <div class="row wrap" style="gap:8px;margin-top:12px">
        <button id="dg-ok" class="btn btn-kaspa">${T.ok}</button>
        <button id="dg-x" class="btn btn-ghost">${T.cancel}</button></div>`);
    const done = (v) => { el.remove(); resolve(v); };
    el.querySelector('#dg-ok').onclick = () => done(el.querySelector('#dg-t').value);
    el.querySelector('#dg-x').onclick = () => done(null);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); done(el.querySelector('#dg-t').value); }
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
    });
    const inp = el.querySelector('#dg-t');
    inp.focus(); inp.select();
  });
}

/** prompt replacement for PASSWORDS → Promise<string|null> (null = cancel). Input is masked —
 *  native prompt() showed the backup file password in plain text. */
export function promptPassword(label) {
  return new Promise((resolve) => {
    const el = box(`<p class="hint" style="margin:0 0 8px">${esc(label)}</p>
      <input type="password" id="dg-p" placeholder="${T.pw}">
      <div class="row wrap" style="gap:8px;margin-top:12px">
        <button id="dg-ok" class="btn btn-kaspa">${T.ok}</button>
        <button id="dg-x" class="btn btn-ghost">${T.cancel}</button></div>`);
    const done = (v) => { el.remove(); resolve(v); };
    el.querySelector('#dg-ok').onclick = () => done(el.querySelector('#dg-p').value);
    el.querySelector('#dg-x').onclick = () => done(null);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); done(el.querySelector('#dg-p').value); }
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
    });
    el.querySelector('#dg-p').focus();
  });
}
