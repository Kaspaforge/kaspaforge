import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const pages = [
  ['Forge EN', '../kaspa-forge.html'],
  ['Forge RU', '../ru/kaspa-forge.html'],
  ['Safe EN', '../index.html'],
  ['Safe RU', '../ru/index.html'],
  ['Escrow EN', '../escrow-index.html'],
  ['Escrow RU', '../ru/escrow-index.html'],
];

for (const [name, path] of pages) {
  test(`${name} renders the shared network and security rails`, () => {
    const html = readFileSync(new URL(path, import.meta.url), 'utf8');

    assert.match(html, /href="\/assets\/status-rail\.css\?v=1"/);
    assert.match(html, /class="status-rail status-rail--network/);
    assert.match(html, /class="status-rail status-rail--security/);
    assert.equal((html.match(/class="status-metric(?:\s|\")/g) || []).length, 12);

    for (const id of ['ns-net', 'ns-daa', 'ns-dot', 'ns-status', 'sec-contracts', 'sec-tests', 'sec-verified', 'sec-link', 'sec-github']) {
      assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `${id} must remain unique for status scripts`);
    }

    assert.match(html, /Toccata/);
    assert.match(html, /status-value--live/);
    assert.doesNotMatch(html, /status-value--beta/);
    assert.match(html, /status-action[^>]*id="sec-link"/);
    assert.match(html, /status-action[^>]*id="sec-github"/);
  });
}
