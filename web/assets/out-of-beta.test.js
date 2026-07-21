import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const blogSlugs = [
  'client-side-keys-kaspa-desk',
  'kaspa-covenants-how-they-work',
  'kaspa-escrow-covenant-spending-paths',
  'pow-self-custody-trustless-tools',
  'kaspa-forge-hd-key-derivation',
  'kaspa-deterministic-key-derivation-backup',
  'kaspa-blockdag-ghostdag-explained',
];
const retiredCap = /(?:open beta|beta caps?|beta limits?|бета-(?:лимиты|ограничения)|50[–-]10(?:,| )000|50–10 000)/i;

test('LLM discovery copy describes the mainnet product without the retired cap', () => {
  const llms = readFileSync(new URL('../llms.txt', import.meta.url), 'utf8');
  assert.match(llms, /mainnet P2P deals from 50 KAS, with no platform upper cap/);
  assert.doesNotMatch(llms, retiredCap);
});

for (const slug of blogSlugs) {
  for (const prefix of ['../blog/', '../ru/blog/']) {
    test(`${prefix}${slug} contains current deal boundaries`, () => {
      const html = readFileSync(new URL(`${prefix}${slug}.html`, import.meta.url), 'utf8');
      assert.match(html, /"dateModified": "2026-07-20"/);
      assert.doesNotMatch(html, retiredCap);
    });
  }
}
