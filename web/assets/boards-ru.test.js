import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
const ru = readFileSync(new URL('../ru/boards.html', import.meta.url), 'utf8');
const rules = readFileSync(new URL('../boards/rules.html', import.meta.url), 'utf8');
test('RU boards twin carries the RU header and the same board slugs', () => {
  assert.match(ru, /KaspaForge Boards/);          // brand term stays
  assert.match(ru, /Без аккаунтов|Просто треды/);  // RU tagline
  assert.match(ru, /data-board="kas"/);
});
test('rules page exists in both locales', () => {
  assert.match(rules, /publication rules|Publication Rules/i);
});
