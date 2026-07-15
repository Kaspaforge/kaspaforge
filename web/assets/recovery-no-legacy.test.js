import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("offline age decryptor is self-contained and fully built", () => {
  const template = readFileSync(new URL("../../tools/keyfile-decrypt.template.html", import.meta.url), "utf8");
  const built = readFileSync(new URL("../keyfile-decrypt.html", import.meta.url), "utf8");

  assert.doesNotMatch(template, /<script[^>]+src=/i);
  assert.doesNotMatch(template, /<link[^>]+rel=["']stylesheet/i);
  assert.doesNotMatch(template, /\bfetch\s*\(/);
  assert.match(template, /rel="icon" href="data:,"/);
  assert.doesNotMatch(built, /__WASM_GLUE__|__WASM_B64__/);
  assert.ok(Buffer.byteLength(built) > 3_000_000, "embedded WASM bundle is unexpectedly small");
});

const pages = [
  ["English", new URL("../recover.html", import.meta.url), /shared-storage mode/, /Forge Sync deliberately omits every alarm key/],
  ["Russian", new URL("../ru/recover.html", import.meta.url), /общее хранение/, /Forge Sync сознательно исключает все тревожные ключи/],
];

const escrowPages = [
  ["English escrow", new URL("../recover-escrow.html", import.meta.url), /standalone key-file decryptor/i],
  ["Russian escrow", new URL("../ru/recover-escrow.html", import.meta.url), /автономный дешифратор key-file/i],
];

for (const [language, url, sharedStorageCopy, syncWarning] of pages) {
  test(`${language} Recovery uses only the unified encrypted profile`, () => {
    const html = readFileSync(url, "utf8");

    assert.match(html, /\.age/);
    assert.match(html, /keyfile-decrypt\.html/);
    assert.match(html, /--recovery vault\.json/);
    assert.match(html, sharedStorageCopy);
    assert.match(html, syncWarning);
    assert.match(html, /alarm_sk/);

    for (const legacy of [
      /recovery sheet/i,
      /recovery-лист/i,
      /sheet\.txt/i,
      /лист\.txt/i,
      /kaspa-safe-recovery/i,
      /\blegacy\b/i,
      /\bлегаси\b/i,
    ]) {
      assert.doesNotMatch(html, legacy);
    }
  });
}

for (const [language, url, decryptorCopy] of escrowPages) {
  test(`${language} Recovery uses the encrypted Desk profile and states the CLI boundary`, () => {
    const html = readFileSync(url, "utf8");

    assert.match(html, /\.age/);
    assert.match(html, /keyfile-decrypt\.html/);
    assert.match(html, decryptorCopy);
    assert.match(html, /not.*standalone party-side CLI|Отдельного CLI стороны[\s\S]*пока нет/i);

    for (const stale of [
      /recovery sheet/i,
      /recovery-лист/i,
      /старому recovery/i,
      /kaspa-unlock/i,
      /are being published/i,
      /публикуются вместе/i,
    ]) {
      assert.doesNotMatch(html, stale);
    }
  });
}
