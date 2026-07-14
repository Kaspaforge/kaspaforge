import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createSubscriptionStatusLoader, subscriptionView } from "./safe-subscription.js";

const trial = {
  active: true,
  paid_until: 1_800_000_000,
  paid_sompi: 0,
  price_kas: 100,
  sub_addr: "kaspa:qsub",
  tg_connected: false,
  alert_email: "",
  delivery_configured: false,
};

test("unpaid trial without a delivery channel never claims the user is subscribed", () => {
  const view = subscriptionView(trial, "en");
  assert.equal(view.tone, "warn");
  assert.match(view.status, /No notification channel connected/);
  assert.match(view.status, /will not receive alerts/);
  assert.equal(view.badge, null);
  assert.equal(view.showPay, true);
  assert.match(view.payLabel, /^Subscribe/);
});

test("unpaid trial with Telegram says trial, not paid subscription", () => {
  const view = subscriptionView({ ...trial, tg_connected: true, delivery_configured: true }, "en");
  assert.equal(view.tone, "ok");
  assert.match(view.status, /Free trial/);
  assert.match(view.status, /Telegram connected/);
  assert.equal(view.badge, null);
  assert.equal(view.showPay, true);
});

test("paid access without a delivery channel still warns that alerts cannot arrive", () => {
  const view = subscriptionView({ ...trial, paid_sompi: 10_000_000_000 }, "en");
  assert.equal(view.tone, "warn");
  assert.match(view.status, /will not receive alerts/);
  assert.equal(view.badge, "✓ Paid");
  assert.equal(view.showPay, false);
});

test("paid active delivery is the only state shown as subscribed", () => {
  const view = subscriptionView({
    ...trial,
    paid_sompi: 10_000_000_000,
    alert_email: "owner@example.com",
    delivery_configured: true,
  }, "en");
  assert.equal(view.tone, "ok");
  assert.match(view.status, /Paid alerts active/);
  assert.match(view.status, /email connected/);
  assert.equal(view.badge, "✓ Paid");
  assert.equal(view.showPay, false);
});

test("expired paid access offers renewal", () => {
  const view = subscriptionView({ ...trial, active: false, paid_sompi: 10_000_000_000 }, "en");
  assert.equal(view.tone, "warn");
  assert.equal(view.showPay, true);
  assert.match(view.payLabel, /^Renew/);
});

test("Russian copy makes missing delivery explicit", () => {
  const view = subscriptionView(trial, "ru");
  assert.match(view.status, /Канал уведомлений не подключён/);
  assert.match(view.status, /алерты не придут/);
  assert.match(view.payLabel, /^Подключить/);
});

test("the API and every Safe subscription surface use delivery-aware status", () => {
  const api = readFileSync(new URL("../../server/src/api.rs", import.meta.url), "utf8");
  assert.match(api, /"tg_connected"/);
  assert.match(api, /"delivery_configured"/);
  assert.match(api, /"delivery_active"/);

  for (const relative of ["../desk.html", "../ru/desk.html", "../manage.html", "../ru/manage.html"]) {
    const html = readFileSync(new URL(relative, import.meta.url), "utf8");
    assert.match(html, /safe-subscription\.js\?v=2/);
    assert.match(html, /subscriptionView\(s,/);
    assert.doesNotMatch(html, /✓ Subscribed|✓ Подписка активна/);
  }
});

test("subscription status loader deduplicates concurrent renders and caches the result", async () => {
  let calls = 0;
  let release;
  const response = new Promise((resolve) => { release = resolve; });
  const load = createSubscriptionStatusLoader(async () => {
    calls += 1;
    return response;
  });
  const vault = { vault_addr: "kaspa:qvault", token: "owner" };

  const first = load(vault);
  const second = load(vault);
  assert.equal(calls, 1);
  release({ active: true });
  assert.deepEqual(await first, { active: true });
  assert.deepEqual(await second, { active: true });
  assert.deepEqual(await load(vault), { active: true });
  assert.equal(calls, 1);
});

test("subscription status loader retries one transient 429 response", async () => {
  let calls = 0;
  const load = createSubscriptionStatusLoader(async () => {
    calls += 1;
    if (calls === 1) throw new Error("server: 429");
    return { active: true };
  }, { wait: async () => {} });

  assert.deepEqual(await load({ vault_addr: "kaspa:qvault", token: "owner" }), { active: true });
  assert.equal(calls, 2);
});
