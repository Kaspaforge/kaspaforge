import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VIEWS, resolveRoute } from './desk-routes.js';

test('canonical views resolve to themselves', () => {
  for (const v of VIEWS) assert.equal(resolveRoute('#' + v), v);
});
test('legacy aliases map to new views (external links must keep working)', () => {
  assert.equal(resolveRoute('#deals'), 'escrow');
  assert.equal(resolveRoute('#listings'), 'market');
  assert.equal(resolveRoute('#vaults'), 'safes');
});
test('unknown/empty hash falls back to overview', () => {
  assert.equal(resolveRoute(''), 'overview');
  assert.equal(resolveRoute('#nope'), 'overview');
  assert.equal(resolveRoute(undefined), 'overview');
});
test('hash is case-insensitive', () => {
  assert.equal(resolveRoute('#Deals'), 'escrow');
});
test('prototype-chain keys do not leak through the alias map', () => {
  for (const h of ['#constructor', '#toString', '#__proto__', '#hasOwnProperty'])
    assert.equal(resolveRoute(h), 'overview');
});
