import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
const nav = readFileSync(new URL('./nav.js', import.meta.url), 'utf8');
test('nav lists BOARDS after DEPOSIT', () => {
  assert.match(nav, /boards\.html/);
  assert.match(nav, /BOARDS/);
  assert.ok(nav.indexOf('DEPOSIT') < nav.indexOf('BOARDS'), 'BOARDS comes after DEPOSIT');
});

test('BOARDS sits right after the Deposit entry in the links array', () => {
  assert.ok(nav.indexOf('deposit-index.html') !== -1, 'Deposit entry exists');
  assert.ok(nav.indexOf('deposit-index.html') < nav.indexOf('boards.html'),
    'boards.html comes after deposit-index.html');
});
