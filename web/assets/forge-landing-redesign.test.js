import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const en = readFileSync(new URL('../kaspa-forge.html', import.meta.url), 'utf8');
const ru = readFileSync(new URL('../ru/kaspa-forge.html', import.meta.url), 'utf8');
const status = JSON.parse(readFileSync(new URL('./sec-status.json', import.meta.url), 'utf8'));

test('EN landing leads with the precise Safe hook and searchable product title', () => {
  assert.match(en, /<title>[^<]*Non-Custodial Kaspa Vault, Escrow &amp; Marketplace<\/title>/);
  assert.match(en, /A Kaspa vault[\s\S]*where theft can[\s\S]*be cancelled/);
  assert.match(en, /before the window closes/);
  assert.match(en, /href="#desk"[^>]*>Preview the Desk/);
});

test('RU landing keeps the same redesigned information architecture', () => {
  assert.match(ru, /Сейф Kaspa[\s\S]*кражу можно[\s\S]*отменить/);
  assert.match(ru, /до закрытия окна/);
  assert.match(ru, /href="#desk"[^>]*>Посмотреть Деск/);
});

for (const [lang, html] of [['EN', en], ['RU', ru]]) {
  test(`${lang} landing states the Sync and separate alarm-key boundary`, () => {
    assert.doesNotMatch(html, /encrypted profile that never leaves your browser|One file is your whole backup|зашифрованн(?:ый|ого) профиль[^<]*не покидает браузер|Один файл[^<]*весь бэкап/i);
    assert.match(html, lang === 'EN' ? /ciphertext only/i : /только шифротекст/i);
    assert.match(html, lang === 'EN' ? /alarm cards remain separate/i : /alarm-карточки остаются отдельно/i);
  });

  test(`${lang} landing has four focused proof metrics and a full-width escrow comparison`, () => {
    assert.equal((html.match(/class="spec"/g) || []).length, 4);
    assert.match(html, /class="[^"]*escrow-compare[^"]*"/);
    assert.match(html, /3[–-]10\s*%/);
    assert.doesNotMatch(html, /on-chain ops<b>0 KAS|ончейн-операции<b>0 KAS/i);
  });

  test(`${lang} landing status has meaningful loading text and keeps the approved footer`, () => {
    assert.doesNotMatch(html, /id="ns-(?:net|daa|status)">…/);
    assert.doesNotMatch(html, /id="sec-(?:contracts|tests|release)">…/);
    assert.match(html, /© 2026 Kaspa Forge/);
    assert.match(html, /class="foot-ofs-logo"/);
  });
}

test('security strip no longer advertises the retired APK and uses current test totals', () => {
  assert.equal(status.tests.total.passed, 180);
  assert.equal(status.tests.total.failed, 0);
  assert.ok(!('release' in status));
  assert.match(en, /id="sec-verified"/);
  assert.match(ru, /id="sec-verified"/);
});
