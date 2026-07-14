import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8');

test('Safe and Escrow removals persist synced profile tombstones', () => {
  const app = read('./app.js');
  const escrow = read('./escrow.js');
  assert.match(app, /tombstoneProfileRecord\(profile, 'vaults', addr\)/);
  assert.match(escrow, /tombstoneProfileRecord\(profile, 'deals', id\)/);
  assert.match(app, /isProfileRecordTombstoned\(profile, 'vaults', v\.vault_addr\)/);
  assert.match(escrow, /isProfileRecordTombstoned\(profile, 'deals', d\.id\)/);
});

test('automatic recovery skips tombstones while explicit key-file import revives them', () => {
  const restore = read('./restore.js');
  const desk = read('../desk.html');
  const deskRu = read('../ru/desk.html');
  assert.match(restore, /Object\.keys\(profile\.tombstones\?\.vaults \|\| \{\}\)/);
  assert.match(restore, /Object\.keys\(profile\.tombstones\?\.deals \|\| \{\}\)/);
  for (const page of [desk, deskRu]) {
    assert.match(page, /reviveProfileRecords\(mergeProfile\(local, imported\), imported\)/);
  }
});
