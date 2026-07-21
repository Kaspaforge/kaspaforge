import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

function moduleScript(html) {
  const scripts = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length, 'page must contain an inline module script');
  return scripts.at(-1)[1].replace(/import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];\s*/g, '');
}

for (const [language, prefix] of [['EN', '..'], ['RU', '../ru']]) {
  test(`${language} listing-new stays the desk stub, never the legacy form`, () => {
    // The static listing form was retired for the React Desk (2026-07-20); the tracked file must
    // match the stub prod serves, or a release re-plants the dead form (with the retired OTC
    // picker) in the doc-root. Form behavior itself is covered by desk NewListingView tests.
    const html = read(`${prefix}/listing-new.html`);
    assert.match(html, /Kaspa Forge Desk/);
    assert.match(html, /desk-app/);
    assert.doesNotMatch(html, /id="l-availability"/, 'legacy form must not come back');
    assert.doesNotMatch(html, /option value="otc"/, 'the retired OTC picker must not come back');
    assert.ok(html.length < 4096, 'a stub, not a page');
  });

  test(`${language} storefront identifies digital items as electronic delivery`, () => {
    const html = read(`${prefix}/market.html`);
    assert.match(html, /option value="digital"/);
    assert.doesNotMatch(html, /option value="otc"/, 'OTC belongs to Escrow, not the marketplace filter');
    assert.match(html, /(?:Three categories|Три категории)/);
    assert.match(html, /digital: ['"](?:Digital item|Цифровой товар)['"]/);
    // Keep the display label for legacy rows returned by browse; only creation/filtering is gone.
    assert.match(html, /otc: ['"](?:OTC \/ crypto trade|OTC \/ обмен криптовалюты)['"]/);
    assert.match(html, /category === 'digital' \? '💾'/);
    assert.match(html, /category === 'digital'\) return ['"](?:Electronic delivery|Электронная доставка)['"]/);
    assert.match(html, /category === 'digital' \? ['"](?:Electronic delivery|Электронная доставка)['"] :/);
    assert.doesNotThrow(() => new vm.Script(`(async () => {${moduleScript(html)}})`));
  });

  test(`${language} storefront sends exact sompi price filters while keeping shareable KAS URLs`, () => {
    const html = read(`${prefix}/market.html`);
    assert.match(html, /id="f-price-min"/);
    assert.match(html, /id="f-price-max"/);
    assert.match(html, /p\.set\('price_min', \$\('f-price-min'\)\.value\)/);
    assert.match(html, /params\.set\(`price_\$\{side\}_sompi`, sompi\)/);
    assert.match(html, /BigInt\(whole\) \* 100000000n/);
  });

  test(`${language} storefront uses compact mobile cards and an always-visible fixed detail CTA`, () => {
    const html = read(`${prefix}/market.html`);
    assert.match(html, /\.mk-detail-grid\{display:grid/);
    assert.match(html, /\.mk-detail-actions\{position:fixed;left:0;right:0;bottom:0/);
    assert.match(html, /safe-area-inset-bottom/);
    assert.match(html, /#list\{grid-template-columns:1fr;gap:10px\}/);
    assert.match(html, /replace\(\/\^📦 Ships to:/);
  });

  test(`${language} deal page uses digital-goods without enabling goods tracking`, () => {
    const html = read(`${prefix}/deal.html`);
    assert.match(html, /templateId === 'digital-goods'/);
    assert.match(html, /id="j-digital-hint"/);
    assert.match(html, /id="digital-delivery-hint"/);
    assert.match(html, /deal\.template === 'goods'/);
    assert.doesNotMatch(html, /deal\.template === 'service'.*chat-track/);
    assert.doesNotThrow(() => new vm.Script(`(async () => {${moduleScript(html)}})`));
  });
}

// The chat gate (checkMediaFile) accepts a fixed set and rejects the rest, and the sweeper deletes
// attachments 24h after the deal closes. A seller who meets either limit only when it bites has
// already taken the buyer's money into escrow; a buyer who misses the second one loses the goods
// they paid for. Both must be stated up front. Mirrors deal-media.test.ts on the React side.
for (const [language, prefix, limit, fallback, retention] of [
  ['EN', '..', /Attachments: images, video, PDF, archives \(zip \/ 7z \/ gz\) and audio, up to 50 MB/,
    /private link/, /24 hours after it closes they are permanently deleted/],
  ['RU', '../ru', /Вложения: изображения, видео, PDF, архивы \(zip \/ 7z \/ gz\) и аудио, до 50 МБ/,
    /приватной ссылкой/, /через 24 часа после её закрытия они безвозвратно удаляются/],
]) {
  test(`${language} digital copy states the attachment limit before funding`, () => {
    for (const page of [`${prefix}/deal.html`]) { // listing-new is a desk stub since 2026-07-20; the desk form states the limit itself
      const html = read(page);
      assert.match(html, limit, `${page} must state the attachment limit`);
      assert.match(html, fallback, `${page} must name the private-link fallback`);
    }
    // and must not go back to promising an unrestricted file
    assert.doesNotMatch(read(`${prefix}/deal.html`), /send the file, private link|отправьте файл, приватную ссылку/);
  });

  test(`${language} deal chat warns both parties that attachments are swept 24h after close`, () => {
    const html = read(`${prefix}/deal.html`);
    assert.match(html, /id="chat-retention-note"/, 'the chat must carry the retention note');
    assert.match(html, retention, 'the note must state the 24h window and that deletion is permanent');
  });
}

// The send gate and the accept filter must agree: a type offered in the picker that the gate then
// refuses is the same trap, one layer down.
test('the file picker offers exactly what the send gate accepts', () => {
  const escrow = read('./escrow.js');
  const sendable = [...escrow.matchAll(/const MIME_(?:IMG|VID|DOC|FILE) = \[([^\]]*)\]/g)]
    .flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
  assert.ok(sendable.includes('application/zip'), 'archives must be sendable — that is the point');
  for (const page of ['../deal.html', '../ru/deal.html']) {
    const accept = read(page).match(/id="chat-file" accept="([^"]+)"/)[1].split(',');
    assert.deepEqual([...accept].sort(), [...sendable].sort(), `${page} accept= must mirror the gate`);
  }
});
