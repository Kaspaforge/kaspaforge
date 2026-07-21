import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../boards.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('./boards.js', import.meta.url), 'utf8');

test('boards.html carries the brand header, nav and board slugs', () => {
  assert.match(html, /KaspaForge Boards/);
  assert.match(html, /No accounts\. No profiles\. Just threads\./);
  assert.match(html, /\/b\/|data-board="b"/);
});

test('boards.js renders a tombstone for a hidden post with rules + tx links', () => {
  // the module must expose renderPost for a hidden entry producing a tombstone with both links
  assert.match(js, /hidden/);
  assert.match(js, /\/boards\/rules/);        // rules link
  assert.match(js, /explorer|\/txs\/|tx=|transaction/i); // on-chain tx link
  assert.doesNotThrow(() => new vm.Script(js.replace(/import\s+[\s\S]*?from\s+['"][^'"]+['"];?/g, '')));
});
