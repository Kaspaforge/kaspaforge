// kaspa-safe/web/assets/desk-overview.js — pure view-model builders for the Overview summary
// cards. Deterministic Next-action priorities per spec §5.4 (canon dd5d9c74). DOM-free, no
// Date.now (nowSec is injected) → unit-testable with node --test.

const short = (a) => (a ? a.slice(0, 14) + '…' : '');
const vName = (v) => v.label || short(v.vault_addr);

/** Safes: активный вывод > припаркованный (stray) депозит > idle.
 *  balances пополняется по мере резолва per-vault запросов renderVaultsTab — частичная карта ок. */
export function safesCard(vaults, balances) {
  const live = (vaults || []).filter((v) => !v.draft);
  let sum = 0, withdrawing = 0, wd = null, stray = null;
  for (const v of live) {
    const b = balances.get(v.vault_addr);
    if (!b) continue;
    sum += b.sompi || 0;
    if (b.withdrawing) { withdrawing++; if (!wd) wd = v; }
    if (b.strays && !stray) stray = v;
  }
  const next = wd
    ? { label: `Review withdrawal — “${vName(wd)}”`, href: '/manage.html', vault: wd.vault_addr }
    : stray
    ? { label: `Sweep a stray deposit — “${vName(stray)}”`, href: '#safes' }
    : null;
  return { count: live.length, sumSompi: sum, attention: withdrawing, next };
}

/** Escrow: ждёт действия МОЕЙ роли (joined+buyer=fund, disputed) > непрочитанное > null.
 *  Неизвестное состояние (стейт ещё не догрузился) считается активным. */
export function escrowCard(deals, states, unread) {
  const stateOf = (d) => states.get(d.id);
  const closed = (s) => s === 'closed' || s === 'expired';
  const active = (deals || []).filter((d) => !closed(stateOf(d)));
  const sum = active.reduce((s, d) =>
    s + (stateOf(d) === 'funded' || stateOf(d) === 'disputed' ? (d.amount || 0) : 0), 0);
  const awaiting = active.filter((d) =>
    (stateOf(d) === 'joined' && d.role === 'buyer') || stateOf(d) === 'disputed');
  const withUnread = active.filter((d) => (unread.get(d.id) || 0) > 0);
  const next = awaiting.length
    ? { label: stateOf(awaiting[0]) === 'disputed'
        ? `Respond to the dispute — deal #${awaiting[0].id}`
        : `Fund the escrow — deal #${awaiting[0].id}`,
        href: `/deal.html?id=${awaiting[0].id}` }
    : withUnread.length
    ? { label: `Read new messages — deal #${withUnread[0].id}`, href: `/deal.html?id=${withUnread[0].id}` }
    : null;
  return { count: active.length, sumSompi: sum, attention: awaiting.length + withUnread.length, next };
}

/** Market: истекающее (≤3 дней) объявление > null. Активные = published|reserved. */
export function marketCard(listings, nowSec) {
  const live = (listings || []).filter((l) => l.status === 'published' || l.status === 'reserved');
  const days = (l) => (l.expires_at ? Math.ceil((l.expires_at - nowSec) / 86400) : Infinity);
  const expiring = live
    .filter((l) => l.status === 'published' && days(l) <= 3)
    .sort((a, b) => days(a) - days(b));
  const next = expiring.length
    ? { label: `Extend “${expiring[0].title}” — ${Math.max(0, days(expiring[0]))}d left`, href: '#market' }
    : null;
  return { count: live.length, sumSompi: null, attention: expiring.length, next };
}
