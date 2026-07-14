import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const pages = [
  ["English", new URL("../recover.html", import.meta.url), /shared-storage mode/, /Forge Sync deliberately omits every alarm key/],
  ["Russian", new URL("../ru/recover.html", import.meta.url), /общее хранение/, /Forge Sync сознательно исключает все тревожные ключи/],
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
