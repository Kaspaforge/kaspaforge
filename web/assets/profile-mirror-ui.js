// Settings UI for manual Forge Profile Mirror. No background sync and no silent overwrite.
import * as session from './session.js';
import { loadProfile, mergeProfile, parseProfileFile } from './identity.js';
import { core, ready as coreReady } from './core7.js';
import { confirmPassword } from './lock-ui.js';
import { alertBox, confirmBox, trapFocus } from './dialog.js';
import {
  MirrorApi, classifyMirrorState, createSnapshot, decryptSnapshot, derivedMirrorIdentity,
  mirrorProjection, profileHash, verifyHistoryChain, verifySnapshot,
} from './profile-mirror.js';

const RU = (document.documentElement.lang || 'en').startsWith('ru');
const T = RU ? {
  off: 'Выкл.', ready: 'Актуально', busy: 'Синхронизация…', offline: 'Сервер недоступен',
  conflict: 'Конфликт — нужно объединить версии', warning: 'Предупреждение безопасности',
  enable: 'Включить синхронизацию', sync: 'Синхронизировать', password: 'Включение Forge Sync',
  consent: 'На сервер уйдёт дополнительная зашифрованная копия рабочего профиля. Устройства с этим профилем получат Wallet, hot/funding-ключи сейфов, Escrow, Market и Chats. Тревожные ключи сейфов автоматически исключаются — даже если сохранены в зашифрованном профиле — и остаются только на устройстве, где хранятся. Для отмены вывода на другом устройстве импортируйте актуальный .age-файл с устройства, где есть тревожный ключ, или используйте alarm-карточку.\n\nForge Sync не заменяет офлайн-бэкап .age.',
  consentOk: 'Включить', merge: (v, c) => `${c ? 'Локальная и серверная копии обе изменились.' : 'На сервере есть новая копия.'}\n\nРасшифровать и безопасно объединить версию ${v} с этим устройством? Ничего не будет затёрто автоматически.`,
  mergeOk: 'Объединить', differentPw: 'Серверная копия age зашифрована другим паролем устройства. Локальный профиль не изменён.',
  badInner: 'Серверная копия не соответствует подписанному профилю. Локальный профиль не изменён.',
  done: 'Forge Sync завершён. Профиль и серверная копия актуальны.',
  failed: (e) => `Forge Sync не выполнен: ${e}`,
  human: 'Защита Forge Sync от спама', verify: 'Подтверди, что запрос создаёт человек.',
  cancel: 'Отмена', captchaFailed: 'Проверка Cloudflare не пройдена. Попробуй ещё раз.',
} : {
  off: 'Off', ready: 'Up to date', busy: 'Syncing…', offline: 'Server unavailable',
  conflict: 'Conflict — versions must be merged', warning: 'Security warning',
  enable: 'Enable sync', sync: 'Sync now', password: 'Enabling Forge Sync',
  consent: 'An additional encrypted copy of your working profile will be stored on the server. Devices holding this profile receive Wallet, Safe hot/funding keys, Escrow, Market and Chats. Safe alarm keys are excluded automatically — even when stored in the encrypted profile — and stay only on the device that holds them. To cancel a withdrawal on another device, import a current .age backup from the device holding the alarm key, or use its alarm card.\n\nForge Sync does not replace your offline .age backup.',
  consentOk: 'Enable', merge: (v, c) => `${c ? 'Both the local and server copies changed.' : 'A newer server copy is available.'}\n\nDecrypt and safely merge version ${v} into this device? Nothing is overwritten automatically.`,
  mergeOk: 'Merge', differentPw: 'The remote age copy uses a different device password. The local profile was not changed.',
  badInner: 'The remote copy does not match its signed profile. The local profile was not changed.',
  done: 'Forge Sync complete. The profile and server copy are up to date.',
  failed: (e) => `Forge Sync failed: ${e}`,
  human: 'Forge Sync spam protection', verify: 'Confirm that a human is creating this mirror.',
  cancel: 'Cancel', captchaFailed: 'Cloudflare verification failed. Please try again.',
};

const api = new MirrorApi();
const stateKey = (id) => `kaspa-forge-mirror-state:${id}`;
const head = (s) => ({ version: s.version, blob_hash: s.blob_hash,
  profile_hash: s.profile_hash, updated_at: Date.now() });

function readCheckpoint(id) {
  try {
    const v = JSON.parse(localStorage.getItem(stateKey(id)) || 'null');
    return v && Number.isInteger(v.version) && typeof v.blob_hash === 'string' ? v : null;
  } catch { return null; }
}
function saveCheckpoint(s) { localStorage.setItem(stateKey(s.profile_id), JSON.stringify(head(s))); }

function setUi(status, button, text, disabled = false) {
  status.textContent = text; button.disabled = disabled;
}

function loadTurnstile() {
  return new Promise((resolve, reject) => {
    if (window.turnstile) return resolve();
    const existing = document.querySelector('script[data-forge-turnstile]');
    if (existing) {
      existing.addEventListener('load', resolve, { once: true });
      existing.addEventListener('error', () => reject(new Error(T.captchaFailed)), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.dataset.forgeTurnstile = '1';
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true; script.defer = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error(T.captchaFailed));
    document.head.appendChild(script);
  });
}

async function turnstileChallenge(sitekey) {
  await loadTurnstile();
  if (!window.turnstile || !sitekey) throw new Error(T.captchaFailed);
  return new Promise((resolve, reject) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(8,10,14,.92);padding:20px';
    overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true');
    const plate = document.createElement('div'); plate.className = 'plate';
    plate.style.cssText = 'max-width:420px;width:100%';
    const title = document.createElement('h2'); title.textContent = T.human;
    const note = document.createElement('p'); note.className = 'hint'; note.textContent = T.verify;
    const widget = document.createElement('div'); widget.style.cssText = 'min-height:70px;margin:14px 0';
    const cancel = document.createElement('button'); cancel.className = 'btn btn-ghost'; cancel.textContent = T.cancel;
    plate.append(title, note, widget, cancel); overlay.appendChild(plate); document.body.appendChild(overlay);
    trapFocus(overlay); cancel.focus();
    let widgetId = null, done = false;
    const finish = (token, error = null) => {
      if (done) return; done = true;
      if (widgetId !== null) { try { window.turnstile.remove(widgetId); } catch {} }
      overlay.remove();
      if (error) reject(error); else resolve(token);
    };
    cancel.onclick = () => finish(null, new Error(T.captchaFailed));
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(null, new Error(T.captchaFailed)); }
    });
    try {
      widgetId = window.turnstile.render(widget, {
        sitekey, theme: 'dark', language: RU ? 'ru' : 'en', action: 'forge-sync-enable',
        callback: (token) => finish(token),
        'error-callback': () => { note.className = 'note alarm'; note.textContent = T.captchaFailed; },
        'expired-callback': () => { if (widgetId !== null) try { window.turnstile.reset(widgetId); } catch {} },
      });
    } catch { finish(null, new Error(T.captchaFailed)); }
  });
}

async function registerMirror(mirror) {
  try {
    return await api.register(mirror);
  } catch (e) {
    if (e.status !== 403 || e.body?.code !== 'turnstile_required') throw e;
    const health = await api.health();
    if (!health.captcha || !health.sitekey) throw e;
    return api.register(mirror, await turnstileChallenge(health.sitekey));
  }
}

async function uploadLocal(profile, mirror, remote, status, button) {
  setUi(status, button, T.busy, true);
  const projected = mirrorProjection(profile);
  const snapshot = await createSnapshot(session.exportProfile(projected), projected, mirror, remote);
  await api.upload(snapshot); saveCheckpoint(snapshot);
  setUi(status, button, `${T.ready} · v${snapshot.version}`, false);
  return snapshot;
}

async function mergeRemote(remote, profile, mirror, checkpoint, conflict, status, button) {
  if (!await confirmBox(T.merge(remote.version, conflict), { danger: conflict, ok: T.mergeOk })) return false;
  if (checkpoint && remote.version > checkpoint.version + 1) {
    const history = await api.versions(mirror);
    await verifyHistoryChain(history.versions, remote, mirror, checkpoint);
  }
  let imported;
  try {
    const armored = await decryptSnapshot(remote, mirror, checkpoint && remote.version <= checkpoint.version + 1 ? checkpoint : null);
    imported = parseProfileFile(JSON.stringify(session.decryptArmoredCurrent(armored)));
  } catch (e) {
    await alertBox(/passphrase|decrypt|corrupt/i.test(e.message || '') ? T.differentPw : T.failed(e.message || e), { alarm: true });
    return false;
  }
  if (!imported.mirror || imported.mirror.profile_id !== mirror.profile_id
      || imported.mirror.auth_pk !== mirror.auth_pk || await profileHash(imported) !== remote.profile_hash) {
    await alertBox(T.badInner, { alarm: true }); return false;
  }
  const merged = mergeProfile(profile, imported); // union keys/records; current wallet remains active
  session.commit(merged);
  await uploadLocal(merged, mirror, remote, status, button);
  return true;
}

export function mountProfileMirror({ onProfileChanged = null } = {}) {
  const status = document.getElementById('st-sync-status');
  const button = document.getElementById('st-sync-btn');
  if (!status || !button) return;
  const render = () => {
    let p; try { p = loadProfile(); } catch { return; }
    const cp = p.mirror && readCheckpoint(p.mirror.profile_id);
    status.textContent = p.mirror ? (cp ? `${T.ready} · v${cp.version}` : T.off) : T.off;
    button.textContent = p.mirror ? T.sync : T.enable;
  };
  button.onclick = async () => {
    if (!await confirmPassword(T.password)) return;
    button.disabled = true;
    try {
      let profile = loadProfile();
      if (!profile.mirror) {
        if (!await confirmBox(T.consent, { danger: true, ok: T.consentOk })) return;
      }
      await coreReady;
      const derived = derivedMirrorIdentity(profile, core.forge_sync_identity);
      // Migrate the random MVP identity on the next manual Sync. Copies of the same pre-Sync
      // profile now derive the same ID/auth/outer key and converge through the normal merge flow.
      if (!profile.mirror || profile.mirror.profile_id !== derived.profile_id
          || profile.mirror.identity_mode !== derived.identity_mode) {
        profile.mirror = derived;
        session.commit(profile);
      }
      const mirror = profile.mirror;
      setUi(status, button, T.busy, true);
      await registerMirror(mirror); // idempotent; only first creation requires Turnstile
      let remote = null;
      try { remote = await api.latest(mirror); }
      catch (e) { if (e.status !== 404) throw e; }
      const checkpoint = readCheckpoint(mirror.profile_id);
      if (remote) await verifySnapshot(remote, mirror); // signature + actual blob hash before any state decision
      const localHash = await profileHash(mirrorProjection(profile));
      const decision = classifyMirrorState(localHash, remote, checkpoint);
      if (decision.action === 'security_warning') throw new Error(`remote ${decision.reason} detected`);
      if (decision.action === 'upload_initial' || decision.action === 'upload') {
        await uploadLocal(profile, mirror, remote, status, button);
      } else if (decision.action === 'adopt_checkpoint') {
        saveCheckpoint(remote);
      } else if (decision.action === 'merge_remote') {
        const changed = await mergeRemote(remote, profile, mirror, checkpoint, decision.conflict, status, button);
        if (!changed) return;
      }
      setUi(status, button, `${T.ready} · v${readCheckpoint(mirror.profile_id)?.version || remote?.version || 1}`, false);
      if (onProfileChanged) onProfileChanged();
      await alertBox(T.done);
    } catch (e) {
      const security = /rollback|fork|signature|hash|history gap/i.test(e.message || '');
      setUi(status, button, security ? T.warning : T.offline, false);
      await alertBox(T.failed(e.message || e), { alarm: true });
    } finally {
      button.disabled = false;
      try { button.textContent = loadProfile().mirror ? T.sync : T.enable; } catch {}
    }
  };
  render();
}
