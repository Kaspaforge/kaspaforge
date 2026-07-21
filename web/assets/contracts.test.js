import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCatalog, getTemplate, classOf, windowForShipping, evidenceState, loc, visibleTemplates } from './contracts.js';

const text = readFileSync(fileURLToPath(new URL('./contracts-catalog.json', import.meta.url)), 'utf8');
const catalog = parseCatalog(text);

test('parseCatalog throws on malformed JSON', () => {
  assert.throws(() => parseCatalog('{not json'));
});

test('getTemplate finds by id and returns null for unknown', () => {
  assert.equal(getTemplate(catalog, 'hire-developer').id, 'hire-developer');
  assert.equal(getTemplate(catalog, 'nope'), null);
});

test('classOf returns the covenant class', () => {
  assert.equal(classOf(getTemplate(catalog, 'buy-goods')), 'goods');
  assert.equal(classOf(getTemplate(catalog, 'otc-swap')), 'otc');
  assert.equal(classOf(getTemplate(catalog, 'hire-developer')), 'service');
});

test('windowForShipping maps geo to hours, falls back to default', () => {
  const g = getTemplate(catalog, 'buy-goods');
  assert.equal(windowForShipping(g, 'local'), 96);
  assert.equal(windowForShipping(g, 'intl_far'), 720);
  assert.equal(windowForShipping(g, 'unknown-geo'), g.window_default); // fallback
  const s = getTemplate(catalog, 'hire-developer'); // no window_by_shipping
  assert.equal(windowForShipping(s, 'intl'), s.window_default);
});

test('evidenceState marks tracking/file done from chat messages, others manual', () => {
  const g = getTemplate(catalog, 'buy-goods'); // evidence: tracking(req), receipt-photo(file)
  const st = evidenceState(g, [{ t: 'track', n: 'RA123' }]);
  const byId = Object.fromEntries(st.map((e) => [e.id, e.done]));
  assert.equal(byId['tracking'], true);      // a 'track' message satisfies tracking
  assert.equal(byId['receipt-photo'], false); // no 'media' message yet
  const st2 = evidenceState(g, [{ t: 'track' }, { t: 'media', media_id: 'x' }]);
  assert.equal(st2.find((e) => e.id === 'receipt-photo').done, true);
});

test('visibleTemplates drops hidden, preserves order; getTemplate still resolves hidden', () => {
  const vis = visibleTemplates(catalog);
  assert.ok(vis.every((t) => !t.hidden));                                  // no hidden entries
  assert.equal(vis.find((t) => t.id === 'design-3-stage'), undefined);     // staged-hidden
  assert.ok(vis.some((t) => t.id === 'buy-goods'));                        // visible ones kept
  assert.deepEqual(vis.map((t) => t.id), catalog.templates.filter((t) => !t.hidden).map((t) => t.id)); // order
  assert.equal(getTemplate(catalog, 'design-3-stage').id, 'design-3-stage'); // still resolvable for existing deals
  assert.deepEqual(visibleTemplates(null), []);                            // defensive
});

test('loc picks language with en fallback', () => {
  assert.equal(loc({ en: 'Buyer', ru: 'Покупатель' }, 'ru'), 'Покупатель');
  assert.equal(loc({ en: 'Buyer', ru: 'Покупатель' }, 'en'), 'Buyer');
  assert.equal(loc({ en: 'Only EN' }, 'ru'), 'Only EN'); // fallback
  assert.equal(loc(undefined, 'en'), '');
});
