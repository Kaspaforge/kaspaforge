import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const en = read('../agents/index.html');
const ru = read('../ru/agents/index.html');
const homeEn = read('../kaspa-forge.html');
const homeRu = read('../ru/kaspa-forge.html');
const nav = read('./nav.js');
const sitemap = read('../sitemap-forge.xml');

test('EN Agents page leads with authority-safe agentic commerce positioning', () => {
  assert.match(en, /<title>AI Agents for Crypto Escrow &amp; Marketplace/);
  assert.match(en, /AI agents can inspect a deal[\s\S]*cannot touch the money/);
  assert.match(en, /Agents do the work[\s\S]*Covenants keep the authority/);
  assert.match(en, /non-binding/i);
  assert.match(en, /never receive your private keys/i);
});

test('RU Agents page keeps the same product and security claims', () => {
  assert.match(ru, /ИИ-агенты для криптоэскроу и маркета/);
  assert.match(ru, /ИИ-агенты могут проверить сделку[\s\S]*не могут коснуться денег/);
  assert.match(ru, /Агенты делают работу[\s\S]*Ковенанты сохраняют власть/);
  assert.match(ru, /не имеет обязательной силы/i);
  assert.match(ru, /не получают твои приватные ключи/i);
});

for (const [lang, page] of [['EN', en], ['RU', ru]]) {
  test(`${lang} Agents page documents both live agent roles and human escalation`, () => {
    assert.match(page, /Market|Маркет/);
    assert.match(page, /Escrow|Эскроу/);
    assert.match(page, /approved[^<]*rejected[^<]*needs_review/);
    assert.match(page, /refund[^<]*release[^<]*split/);
    assert.match(page, /human|человек/i);
    assert.match(page, /github\.com\/Kaspaforge\/kaspaforge/);
  });
}

test('Agents is discoverable from both homepages, shared navigation and sitemap', () => {
  for (const html of [homeEn, homeRu]) {
    assert.match(html, /href="\/(?:ru\/)?agents\/"/);
    assert.match(html, /class="agent-home"/);
  }
  assert.match(nav, /agents\//);
  assert.match(sitemap, /https:\/\/kaspaforge\.org\/agents\//);
  assert.match(sitemap, /https:\/\/kaspaforge\.org\/ru\/agents\//);
});

test('Agents pages expose canonical, hreflang and FAQ structured data', () => {
  assert.match(en, /rel="canonical" href="https:\/\/kaspaforge\.org\/agents\/"/);
  assert.match(ru, /rel="canonical" href="https:\/\/kaspaforge\.org\/ru\/agents\/"/);
  for (const html of [en, ru]) {
    assert.match(html, /"@type":"FAQPage"/);
    assert.match(html, /hreflang="x-default"/);
  }
});
