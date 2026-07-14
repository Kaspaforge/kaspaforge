// kaspa-safe/web/assets/desk-routes.js — pure hash→view resolver for the desk cockpit.
// DOM-free → unit-testable. Legacy anchors #vaults/#deals/#listings are kept as aliases:
// external links (emails, chats, other pages) already point at them (desk.html decision 2026-07-09).
export const VIEWS = ['overview', 'wallet', 'safes', 'escrow', 'market', 'chats', 'settings'];
const ALIASES = { vaults: 'safes', deals: 'escrow', listings: 'market' };
export function resolveRoute(hash) {
  const h = String(hash || '').replace(/^#/, '').toLowerCase();
  if (VIEWS.includes(h)) return h;
  return Object.hasOwn(ALIASES, h) ? ALIASES[h] : 'overview';
}
