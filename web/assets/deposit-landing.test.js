import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const en = readFileSync(new URL('../deposit-index.html', import.meta.url), 'utf8');
const ru = readFileSync(new URL('../ru/deposit-index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('./deposit-landing.css', import.meta.url), 'utf8');
const ogImage = readFileSync(new URL('./og-deposit.png', import.meta.url));

for (const [lang, html] of [['EN', en], ['RU', ru]]) {
  test(`${lang} Deposit landing owns a return-clock visual instead of cloning Escrow`, () => {
    assert.match(html, /class="deposit-hero"/);
    assert.match(html, /class="return-card"/);
    assert.match(html, /class="return-flow"/);
    assert.doesNotMatch(html, /class="cov"|class="sim"|Try to keep the deposit|Попробуйте удержать залог/);
    assert.doesNotMatch(html, /Deposit is Escrow pointed the other way|Залог — это Гарант, направленный в другую сторону/);
  });

  test(`${lang} Deposit landing explains the job before technical detail`, () => {
    assert.match(html, lang === 'EN' ? /Your deposit comes back by default/ : /Ваш залог возвращается сам/);
    assert.match(html, lang === 'EN' ? /Apartment or vehicle/ : /Квартира или автомобиль/);
    assert.match(html, lang === 'EN' ? /Camera, tools or electronics/ : /Камера, инструмент или техника/);
    assert.match(html, lang === 'EN' ? /No claim by the deadline means automatic return/ : /Нет претензии к дедлайну — залог возвращается сам/);
    assert.ok(html.indexOf('id="uses"') < html.indexOf('id="proof"'));
  });

  test(`${lang} Deposit landing keeps the mediator and custody authority boundary honest`, () => {
    assert.match(html, lang === 'EN' ? /AI advises\. It never moves money/ : /ИИ советует\. Он не двигает деньги/);
    assert.match(html, lang === 'EN' ? /human arbiter/ : /человек-арбитр/);
    assert.match(html, lang === 'EN' ? /Kaspa Forge does not hold the deposit/ : /Kaspa Forge тоже не держит залог/);
    assert.match(html, lang === 'EN' ? /emergency timeout returns everything to the depositor/ : /аварийный таймаут возвращает всё залогодателю/);
  });

  test(`${lang} Deposit landing sends protocol depth to Docs and preserves live proof hooks`, () => {
    assert.match(html, lang === 'EN' ? /href="\/docs\/escrow\.html"/ : /href="\/ru\/docs\/escrow\.html"/);
    assert.match(html, /id="netstat"/);
    assert.match(html, /id="ns-net"/);
    assert.match(html, /id="ns-daa"/);
    assert.match(html, /id="ns-dot"/);
    assert.match(html, /id="ns-status"/);
    assert.match(html, /id="secstat"/);
    assert.match(html, /id="sec-contracts"/);
    assert.match(html, /id="sec-tests"/);
    assert.match(html, /id="sec-verified"/);
  });

  test(`${lang} Deposit landing keeps pricing and limits canonical`, () => {
    assert.match(html, /0\.5%/);
    assert.match(html, /1\.2 KAS/);
    assert.match(html, /2%/);
    assert.match(html, /5 KAS/);
    assert.match(html, lang === 'EN' ? /Deposits start at 50 KAS/ : /Залоги — от 50 KAS/);
  });

  test(`${lang} Deposit landing keeps SEO, FAQ schema and conversion routes`, () => {
    assert.match(html, /"@type":"FAQPage"/);
    assert.match(html, /rel="canonical"/);
    assert.match(html, /hreflang="en"/);
    assert.match(html, /hreflang="ru"/);
    assert.match(html, /href="https:\/\/kaspaforge\.org\/deposit-new\.html"/);
    assert.match(html, /href="\/desk"/);
    assert.match(html, /deposit-landing\.css\?v=1/);
    assert.match(html, /https:\/\/kaspaforge\.org\/assets\/og-deposit\.png\?v=1/);
    assert.doesNotMatch(html, /og-forge\.png/);
  });
}

test('Deposit social preview has the declared Open Graph dimensions', () => {
  assert.equal(ogImage.subarray(1, 4).toString(), 'PNG');
  assert.equal(ogImage.readUInt32BE(16), 1200);
  assert.equal(ogImage.readUInt32BE(20), 630);
});

test('Deposit visual system has its own accent, responsive layouts and reduced motion', () => {
  assert.match(css, /--deposit:#8792ff/);
  assert.match(css, /\.return-card/);
  assert.match(css, /\.return-flow/);
  assert.match(css, /@media\(max-width:900px\)/);
  assert.match(css, /@media\(max-width:640px\)/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/);
});
