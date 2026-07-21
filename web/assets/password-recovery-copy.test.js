import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('legacy lock screen says that encrypted backup is not a password reset', () => {
  const source = read('./lock-ui.js');
  assert.match(source, /Forgotten passwords cannot be reset/);
  assert.match(source, /An encrypted \.age backup still requires the password used to create it/);
  assert.match(source, /Забытый пароль нельзя сбросить/);
  assert.match(source, /Для зашифрованного бэкапа \.age тоже нужен пароль/);
  assert.doesNotMatch(source, /profile can be restored from a backup file/);
  assert.doesNotMatch(source, /профиль можно вернуть из файла бэкапа/);
});

test('Desk recovery docs state the same password boundary in both languages', () => {
  const en = read('../docs/desk.html');
  const ru = read('../ru/docs/desk.html');
  assert.match(en, /backup requires that same password/);
  assert.match(en, /cannot reset or bypass a forgotten password/);
  assert.match(ru, /Для зашифрованного бэкапа/);
  assert.match(ru, /не сбрасывает и не обходит забытый пароль/);
});
