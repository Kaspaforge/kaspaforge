import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

for (const [lang, desk] of [
  ['EN', page('../desk.html')],
  ['RU', page('../ru/desk.html')],
]) {
  test(`${lang} Desk redraws profile-backed views after Forge Sync merge`, () => {
    assert.match(desk, /function refreshProfileViewsAfterSync\(\)/);
    assert.match(desk, /mountProfileMirror\(\{ onProfileChanged: refreshProfileViewsAfterSync \}\)/);
    for (const render of ['renderVaultsTab', 'renderDealsTab', 'renderListingsTab', 'renderChatsTab']) {
      assert.match(desk, new RegExp(`function refreshProfileViewsAfterSync\\(\\)[\\s\\S]*?${render}\\(\\)`), `${lang}: missing ${render}`);
    }
  });
}
