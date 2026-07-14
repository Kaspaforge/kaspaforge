import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safesCard, escrowCard, marketCard } from './desk-overview.js';

test('safesCard: totals, drafts excluded, withdrawal wins next-action', () => {
  const vaults = [
    { vault_addr: 'kaspa:aaa', label: 'Long Term' },
    { vault_addr: 'kaspa:bbb' },
    { vault_addr: 'kaspa:ccc', draft: true },
  ];
  const bal = new Map([
    ['kaspa:aaa', { sompi: 100_00000000, withdrawing: true, strays: false }],
    ['kaspa:bbb', { sompi: 50_00000000, withdrawing: false, strays: true }],
  ]);
  const c = safesCard(vaults, bal);
  assert.equal(c.count, 2);
  assert.equal(c.sumSompi, 150_00000000);
  assert.equal(c.attention, 1);
  assert.match(c.next.label, /Review withdrawal — “Long Term”/);
  assert.equal(c.next.href, '/manage.html');
  assert.equal(c.next.vault, 'kaspa:aaa');
});
test('safesCard: stray deposit is next when no withdrawal; idle → null', () => {
  const vaults = [{ vault_addr: 'kaspa:bbb', label: 'B' }];
  const stray = safesCard(vaults, new Map([['kaspa:bbb', { sompi: 1, withdrawing: false, strays: true }]]));
  assert.match(stray.next.label, /Sweep a stray deposit — “B”/);
  assert.equal(stray.next.href, '#safes');
  const idle = safesCard(vaults, new Map([['kaspa:bbb', { sompi: 1, withdrawing: false, strays: false }]]));
  assert.equal(idle.next, null);
});
test('safesCard: partial balances — unresolved vaults count but do not sum', () => {
  const c = safesCard([{ vault_addr: 'x' }, { vault_addr: 'y' }], new Map([['x', { sompi: 5 }]]));
  assert.equal(c.count, 2);
  assert.equal(c.sumSompi, 5);
});
test('escrowCard: buyer joined → fund action; closed excluded; only funded/disputed sum', () => {
  const deals = [
    { id: 1, role: 'buyer', amount: 10 },
    { id: 2, role: 'seller', amount: 600_00000000 },
    { id: 3, role: 'buyer', amount: 7 },
  ];
  const states = new Map([[1, 'joined'], [2, 'funded'], [3, 'closed']]);
  const c = escrowCard(deals, states, new Map());
  assert.equal(c.count, 2);
  assert.equal(c.sumSompi, 600_00000000);
  assert.equal(c.next.href, '/deal.html?id=1');
  assert.match(c.next.label, /Fund the escrow — deal #1/);
});
test('escrowCard: dispute beats unread; unread beats nothing; unknown state stays active', () => {
  const deals = [{ id: 4, role: 'seller', amount: 1 }, { id: 5, role: 'buyer', amount: 1 }];
  const d = escrowCard(deals, new Map([[4, 'disputed'], [5, 'funded']]), new Map([[5, 2]]));
  assert.match(d.next.label, /Respond to the dispute — deal #4/);
  const u = escrowCard(deals, new Map([[4, 'funded'], [5, 'funded']]), new Map([[5, 2]]));
  assert.match(u.next.label, /Read new messages — deal #5/);
  assert.equal(u.attention, 1);
  const unknown = escrowCard([{ id: 9, role: 'buyer', amount: 3 }], new Map(), new Map());
  assert.equal(unknown.count, 1);
});
test('marketCard: expiring published → extend; reserved counts active; empty → null next', () => {
  const now = 1_000_000;
  const listings = [
    { id: 1, title: 'Anvil', status: 'published', expires_at: now + 2 * 86400 },
    { id: 2, title: 'Tongs', status: 'reserved' },
    { id: 3, title: 'Old', status: 'closed' },
  ];
  const c = marketCard(listings, now);
  assert.equal(c.count, 2);
  assert.equal(c.attention, 1);
  assert.match(c.next.label, /Extend “Anvil” — 2d left/);
  assert.equal(c.next.href, '#market');
  assert.equal(marketCard([], now).next, null);
});
