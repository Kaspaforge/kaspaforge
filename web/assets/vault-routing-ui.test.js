import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

for (const [lang, desk, manage, selectLabel, selectedLabel, walletLabel] of [
  ['EN', page('../desk.html'), page('../manage.html'), 'Choose a safe', 'Withdraw selected', 'To my wallet'],
  ['RU', page('../ru/desk.html'), page('../ru/manage.html'), 'Выбери сейф', 'Вывести выбранные', 'На мой кошелёк'],
]) {
  test(`${lang} wallet exposes a persistent safe target selector`, () => {
    assert.match(desk, /id="w-safe-target"/);
    assert.ok(desk.includes(selectLabel));
    assert.doesNotMatch(desk, /function ensurePickBox/);
  });

  test(`${lang} multi-deposit vault supports individual and selected wallet withdrawals`, () => {
    for (const id of ['wd-select-all', 'wd-selected', 'wd-selected-desk']) {
      assert.ok(manage.includes(id), `${lang}: missing ${id}`);
    }
    assert.ok(manage.includes(selectedLabel));
    assert.ok(manage.includes(walletLabel));
    assert.match(manage, /function selectedVaultUtxos/);
    assert.match(manage, /async function withdrawMany/);
  });

  test(`${lang} selected deposits survive the six-second vault refresh`, () => {
    assert.match(manage, /const selectedVaultUtxoKeys = new Set\(\)/);
    assert.match(manage, /pick\.checked = selectedVaultUtxoKeys\.has/);
    assert.match(manage, /selectedVaultUtxoKeys\.add/);
  });
}
