import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const pages = [
  ["English Desk docs", new URL("../docs/desk.html", import.meta.url), /Forge Sync never transfers a Safe alarm key/],
  ["Russian Desk docs", new URL("../ru/docs/desk.html", import.meta.url), /Forge Sync никогда не переносит тревожный ключ сейфа/],
  ["English Security docs", new URL("../docs/security.html", import.meta.url), /cannot cancel a withdrawal on that device/],
  ["Russian Security docs", new URL("../ru/docs/security.html", import.meta.url), /не сможете отменить вывод на этом устройстве/],
];

for (const [name, url, warning] of pages) {
  test(`${name} explains the unsynced alarm-key boundary`, () => {
    const html = readFileSync(url, "utf8");
    assert.match(html, warning);
    assert.match(html, /\.age/);
  });
}
