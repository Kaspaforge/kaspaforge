import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const catalog = JSON.parse(
  readFileSync(fileURLToPath(new URL('./contracts-catalog.json', import.meta.url)), 'utf8')
);
const WINDOW_WHITELIST = new Set([24, 48, 72, 96, 120, 168, 336, 720]); // 336/720 land via Task 7
const CLASSES = new Set(['goods', 'otc', 'service']);
const KINDS = new Set(['tracking', 'txid', 'file', 'text', 'link']);
const bothLangs = (o) => o && typeof o.en === 'string' && typeof o.ru === 'string';

test('catalog has version and exactly the 10 expected templates', () => {
  assert.equal(catalog.version, 1);
  const ids = catalog.templates.map((t) => t.id);
  assert.deepEqual(
    [...ids].sort(),
    ['agent-commission','batch-supply','bounty','buy-goods','design-3-stage',
     'digital-goods','hire-developer','otc-swap','rental','returnable-deposit'].sort()
  );
  assert.equal(new Set(ids).size, ids.length, 'ids must be unique');
});

test('every template obeys the schema invariants', () => {
  for (const t of catalog.templates) {
    assert.ok(CLASSES.has(t.class), `${t.id}: bad class ${t.class}`);
    assert.ok(bothLangs(t.title) && bothLangs(t.goal), `${t.id}: title/goal need en+ru`);
    assert.ok(bothLangs(t.roles.buyer) && bothLangs(t.roles.seller), `${t.id}: roles need en+ru`);
    assert.ok(WINDOW_WHITELIST.has(t.window_default), `${t.id}: window_default off-whitelist`);
    assert.ok(Array.isArray(t.window_choices) && t.window_choices.length > 0, `${t.id}: window_choices`);
    for (const w of t.window_choices) assert.ok(WINDOW_WHITELIST.has(w), `${t.id}: window ${w} off-whitelist`);
    assert.ok(t.window_choices.includes(t.window_default), `${t.id}: default not in choices`);
    if (t.window_by_shipping) assert.equal(t.class, 'goods', `${t.id}: window_by_shipping only for goods`);
    assert.ok(['pct', 'kas'].includes(t.deposit_hint.mode), `${t.id}: deposit mode`);
    for (const e of t.evidence) {
      assert.ok(KINDS.has(e.kind), `${t.id}: evidence kind ${e.kind}`);
      assert.ok(bothLangs(e.label), `${t.id}: evidence label needs en+ru`);
      assert.equal(typeof e.required, 'boolean', `${t.id}: evidence.required must be boolean`);
    }
    for (const s of t.stages) assert.ok(bothLangs(s.label) && bothLangs(s.note), `${t.id}: stage en+ru`);
    for (const k of ['renewal_note','default_outcome_note','dispute_guidance','descr_scaffold'])
      assert.ok(bothLangs(t[k]), `${t.id}: ${k} needs en+ru`);
  }
});
