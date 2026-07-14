import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = (name) => readFileSync(new URL(name, import.meta.url), 'utf8');

for (const [lang, html, desk, create, heading] of [
  ['EN', page('../manage.html'), '/desk.html#settings', '/create.html', 'No vaults in this profile'],
  ['RU', page('../ru/manage.html'), '/ru/desk.html#settings', '/ru/create.html', 'В этом профиле нет сейфов'],
]) {
  test(`${lang} manage empty state uses the unified Desk profile`, () => {
    assert.match(html, new RegExp(heading));
    assert.ok(html.includes(`href="${desk}"`));
    assert.ok(html.includes(`href="${create}"`));
    assert.doesNotMatch(html, /recovery sheet|recovery-лист|public parameters|публичн\S* параметр/i);

    for (const legacyId of ['sheet-btn', 'sheet-file', 'load-btn', 'in-hot', 'in-alarm', 'in-delay']) {
      assert.doesNotMatch(html, new RegExp(`id="${legacyId}"`), `${lang}: legacy ${legacyId} must stay removed`);
    }
  });
}
