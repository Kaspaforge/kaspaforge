import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const wallet = readFileSync(new URL('./wallet.js', import.meta.url), 'utf8');
const desks = [
  readFileSync(new URL('../desk-legacy.html', import.meta.url), 'utf8'),
];

test('portfolio balance can query saved addresses without waiting for seed discovery', () => {
  const body = wallet.match(/export async function walletPortfolioBalance[\s\S]*?\n}/)?.[0] || '';
  assert.match(body, /discover = true/);
  assert.match(body, /if \(discover\) await discoverFundedAddresses/);
  assert.doesNotMatch(body, /walletPlan\(/);
});

test('Desk paints the known balance before starting background discovery on reload', () => {
  for (const html of desks) {
    const refresh = html.match(/async function refreshWalletBalance[\s\S]*?\n}/)?.[0] || '';
    const knownAt = refresh.indexOf('walletPortfolioBalance(profile, net(), { discover: false })');
    const discoveryAt = refresh.indexOf('syncWalletAddresses(profile, net(), forceDiscovery)');
    assert.ok(knownAt >= 0, 'known-address balance lookup is missing');
    assert.ok(discoveryAt > knownAt, 'seed discovery must start after the known balance is painted');
    assert.match(html, /walletPortfolioBalance\(loadProfile\(\), net\(\), \{ discover: false \}\)\.then\(setBal\)/);
  }
});
