function dateOf(seconds) {
  const n = Number(seconds);
  return Number.isFinite(n) && n > 0
    ? new Date(n * 1000).toISOString().slice(0, 10)
    : "—";
}

function channelOf(status, lang) {
  const tg = Boolean(status.tg_connected);
  const email = Boolean(String(status.alert_email || "").trim());
  if (tg && email) return lang === "ru" ? "Telegram и email подключены" : "Telegram and email connected";
  if (tg) return lang === "ru" ? "Telegram подключён" : "Telegram connected";
  if (email) return lang === "ru" ? "email подключён" : "email connected";
  return null;
}

export function createSubscriptionStatusLoader(fetchStatus, options = {}) {
  const ttlMs = options.ttlMs ?? 15_000;
  const retryDelayMs = options.retryDelayMs ?? 350;
  const now = options.now || (() => Date.now());
  const wait = options.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const cache = new Map();
  const inflight = new Map();

  return async function loadSubscriptionStatus(vault) {
    const key = `${vault.vault_addr}\u0000${vault.token}`;
    const cached = cache.get(key);
    if (cached && now() - cached.savedAt < ttlMs) return cached.value;
    if (inflight.has(key)) return inflight.get(key);

    const request = async () => {
      try {
        return await fetchStatus(vault);
      } catch (error) {
        if (!/(^|\D)429(\D|$)/.test(String(error?.message || error))) throw error;
        await wait(retryDelayMs);
        return fetchStatus(vault);
      }
    };
    const pending = request()
      .then((value) => {
        cache.set(key, { value, savedAt: now() });
        return value;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
    return pending;
  };
}

export function subscriptionView(status, lang = "en") {
  const ru = lang === "ru";
  const active = Boolean(status.active);
  const priceKas = Number(status.price_kas) || 0;
  const paid = Number(status.paid_sompi) >= priceKas * 100_000_000 && priceKas > 0;
  const channel = channelOf(status, lang);
  const deliveryConfigured = Boolean(status.delivery_configured || channel);
  const until = dateOf(status.paid_until);

  let text;
  let tone = "warn";
  if (!deliveryConfigured) {
    if (ru) {
      text = `Канал уведомлений не подключён — алерты не придут. ${active ? (paid ? "Оплаченный период" : "Пробный период") + ` до ${until}.` : "Доступ приостановлен."}`;
    } else {
      text = `No notification channel connected — you will not receive alerts. ${active ? (paid ? "Paid access" : "Free trial") + ` until ${until}.` : "Access is paused."}`;
    }
  } else if (active && paid) {
    text = ru ? `Оплаченные алерты работают до ${until} · ${channel}` : `Paid alerts active until ${until} · ${channel}`;
    tone = "ok";
  } else if (active) {
    text = ru ? `Пробный период до ${until} · ${channel}` : `Free trial until ${until} · ${channel}`;
    tone = "ok";
  } else {
    text = ru ? `Алерты приостановлены · ${channel}` : `Alerts paused · ${channel}`;
  }

  const showPay = Boolean(status.sub_addr) && !(active && paid);
  return {
    status: text,
    tone,
    paid,
    trial: active && !paid,
    deliveryConfigured,
    badge: active && paid ? (ru ? "✓ Оплачено" : "✓ Paid") : null,
    showPay,
    payLabel: `${paid ? (ru ? "Продлить" : "Renew") : (ru ? "Подключить" : "Subscribe")} · ${priceKas} KAS/${ru ? "год" : "year"}`,
  };
}
