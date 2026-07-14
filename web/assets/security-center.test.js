import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const pages = [
  ["English", new URL("../security.html", import.meta.url), new URL("../recover.html", import.meta.url)],
  ["Russian", new URL("../ru/security.html", import.meta.url), new URL("../ru/recover.html", import.meta.url)],
];

for (const [language, url, commonFooterPage] of pages) {
  test(`${language} Security Center uses the common footer and current recovery model`, () => {
    const html = readFileSync(url, "utf8");
    const commonHtml = readFileSync(commonFooterPage, "utf8");
    const footer = html.match(/<footer>[\s\S]*?<\/footer>/)?.[0];
    const commonFooter = commonHtml.match(/<footer>[\s\S]*?<\/footer>/)?.[0];
    assert.equal(footer, commonFooter);
    assert.match(html, /<div class="foot">/);
    assert.match(html, /class="foot-ofs-logo"/);
    assert.match(html, /© 2026 Kaspa Forge/);
    assert.doesNotMatch(html, /class="row wrap"/);
    assert.doesNotMatch(html, /recovery sheet/i);
    assert.doesNotMatch(html, /recovery-лист/i);
    assert.match(html, /148 passed · 0 failed · 4 ignored/);
    assert.match(html, /32 passed · 0 failed/);
    assert.match(html, /180 passed · 0 failed/);
    assert.match(html, /Forge Sync/);
    assert.doesNotMatch(html, /KaspaSafe\.apk|GitHub Releases|android-apk/);
    assert.match(html, language === "English" ? /No Android APK is currently distributed/ : /Android APK сейчас не распространяется/);
  });
}
