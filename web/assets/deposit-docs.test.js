import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(join(WEB, path), 'utf8');

function jsonLd(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/g)]
    .map((match) => JSON.parse(match[1]));
}

test('Deposit has complete EN and RU documentation pages with symmetric discovery metadata', () => {
  const en = read('docs/deposit.html');
  const ru = read('ru/docs/deposit.html');

  assert.match(en, /<html lang="en">/);
  assert.match(ru, /<html lang="ru">/);
  assert.match(en, /<link rel="canonical" href="https:\/\/kaspaforge\.org\/docs\/deposit\.html">/);
  assert.match(ru, /<link rel="canonical" href="https:\/\/kaspaforge\.org\/ru\/docs\/deposit\.html">/);
  assert.match(en, /hreflang="ru" href="https:\/\/kaspaforge\.org\/ru\/docs\/deposit\.html"/);
  assert.match(ru, /hreflang="en" href="https:\/\/kaspaforge\.org\/docs\/deposit\.html"/);

  for (const [html, lang, url] of [[en, 'en', 'https://kaspaforge.org/docs/deposit.html'], [ru, 'ru', 'https://kaspaforge.org/ru/docs/deposit.html']]) {
    const blocks = jsonLd(html);
    assert.ok(blocks.some((block) => block['@type'] === 'TechArticle' && block.inLanguage === lang && block.url === url));
    assert.ok(blocks.some((block) => block['@type'] === 'BreadcrumbList'));
    assert.ok(blocks.some((block) => block['@type'] === 'FAQPage'));
  }
});

test('Deposit docs pin the role, timing, fee, dispute and recovery invariants in both languages', () => {
  const en = read('docs/deposit.html');
  const ru = read('ru/docs/deposit.html');

  for (const html of [en, ru]) {
    assert.match(html, /7(?:\s|&nbsp;)*(?:to|–|—|до)(?:\s|&nbsp;)*730/i);
    assert.match(html, /3(?:\s|&nbsp;)*\/(?:\s|&nbsp;)*7(?:\s|&nbsp;)*\/(?:\s|&nbsp;)*14(?:\s|&nbsp;)*\/(?:\s|&nbsp;)*30/);
    assert.match(html, /0\.5%/);
    assert.match(html, /2%/);
    assert.match(html, /50 KAS/);
    assert.match(html, /escrow\.sil/);
  }

  assert.match(en, /holder[^<]*(?:contract )?buyer/i);
  assert.match(en, /depositor[^<]*(?:contract )?seller/i);
  assert.match(en, /auto-return/i);
  assert.match(en, /emergency timeout[^.]*depositor/i);
  assert.match(en, /encrypted Desk profile/i);

  assert.match(ru, /держатель[^<]*покупател/i);
  assert.match(ru, /залогодатель[^<]*продавц/i);
  assert.match(ru, /авто(?:матический |-)?возврат/i);
  assert.match(ru, /аварийн(?:ый|ого) таймаут[^.]*залогодател/i);
  assert.match(ru, /зашифрованн(?:ом|ый) профил/i);
});

test('every Docs page links Deposit in section navigation and the public footer', () => {
  const enFiles = readdirSync(join(WEB, 'docs')).filter((name) => name.endsWith('.html'));
  const ruFiles = readdirSync(join(WEB, 'ru/docs')).filter((name) => name.endsWith('.html'));

  for (const name of enFiles) {
    const html = read(`docs/${name}`);
    assert.match(html, /href="\/docs\/deposit\.html"[^>]*>Deposit<\/a>/, `EN docs nav missing Deposit: ${name}`);
    assert.match(html, /href="\/deposit-index\.html">Deposit<\/a>/, `EN footer missing Deposit: ${name}`);
  }
  for (const name of ruFiles) {
    const html = read(`ru/docs/${name}`);
    assert.match(html, /href="\/ru\/docs\/deposit\.html"[^>]*>Залог<\/a>/, `RU docs nav missing Deposit: ${name}`);
    assert.match(html, /href="\/ru\/deposit-index\.html">Залог<\/a>/, `RU footer missing Deposit: ${name}`);
  }
});

test('Docs indexes, sitemap and llms inventory discover Deposit in both languages', () => {
  const en = read('docs/index.html');
  const ru = read('ru/docs/index.html');
  const sitemap = read('sitemap.xml');
  const llms = read('llms.txt');

  assert.match(en, /four non-custodial services/i);
  assert.match(ru, /четыре некастодиальных сервиса/i);
  assert.ok(jsonLd(en)[0].hasPart.some((part) => part.url === 'https://kaspaforge.org/docs/deposit.html'));
  assert.ok(jsonLd(ru)[0].hasPart.some((part) => part.url === 'https://kaspaforge.org/ru/docs/deposit.html'));
  assert.match(en, /href="\/docs\/deposit\.html">Kaspa Deposit<\/a>/);
  assert.match(ru, /href="\/ru\/docs\/deposit\.html">Kaspa Залог<\/a>/);
  assert.match(sitemap, /<loc>https:\/\/kaspaforge\.org\/docs\/deposit\.html<\/loc>/);
  assert.match(sitemap, /<loc>https:\/\/kaspaforge\.org\/ru\/docs\/deposit\.html<\/loc>/);
  assert.match(llms, /\[How Kaspa Deposit works\]\(https:\/\/kaspaforge\.org\/docs\/deposit\.html\)/);
  assert.match(llms, /\[deposit\]\(https:\/\/kaspaforge\.org\/ru\/docs\/deposit\.html\)/);
  assert.match(read('deposit-index.html'), /href="\/docs\/deposit\.html">Deposit docs[^<]*<\/a>/);
  assert.match(read('ru/deposit-index.html'), /href="\/ru\/docs\/deposit\.html">Документы Залога[^<]*<\/a>/);
});
