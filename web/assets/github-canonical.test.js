import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC_README = fileURLToPath(new URL('../../spike/vaultctl/README-PUBLIC.md', import.meta.url));
const TEXT_EXT = new Set(['.html', '.js', '.json', '.txt', '.xml', '.webmanifest']);
const OLD_REPO = ['pcdoctormsk-ctrl', 'kaspa-safe'].join('/');

function textFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...textFiles(path));
    else if (TEXT_EXT.has(extname(entry.name))) out.push(path);
  }
  return out;
}

test('every Kaspa Forge website link uses the canonical GitHub repository', () => {
  const stale = textFiles(WEB).filter((path) => readFileSync(path, 'utf8').includes(`github.com/${OLD_REPO}`));
  assert.deepEqual(stale, []);
});

test('public mirror README presents Kaspa Forge without distributing the retired APK', () => {
  const readme = readFileSync(PUBLIC_README, 'utf8');
  assert.match(readme, /^# Kaspa Forge\b/m);
  assert.match(readme, /Safe \+ Escrow \+ Deposit \+ Market \+ Desk/);
  assert.match(readme, /https:\/\/kaspaforge\.org\/deposit-index\.html/);
  assert.match(readme, /covenant behind both Kaspa Escrow and Kaspa\s+Deposit/);
  assert.match(readme, /https:\/\/kaspaforge\.org/);
  assert.match(readme, /prebuilt Android package is\s+currently distributed/i);
  assert.doesNotMatch(readme, /KaspaSafe\.apk|github\.com\/Kaspaforge\/kaspaforge\/releases|release-apk/);
  assert.doesNotMatch(readme, /safe\.officeforge\.co|escrow\.officeforge\.co|pcdoctormsk-ctrl\/kaspa-safe/);
});
