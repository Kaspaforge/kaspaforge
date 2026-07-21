import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deskTourPlan } from './desk-tour.js';

const expectedRoutes = ['overview', 'overview', 'overview', 'wallet', 'wallet', 'safes', 'escrow', 'market', 'chats', 'settings'];

test('tour follows every current Desk section in EN and RU', () => {
  for (const lang of ['en', 'ru']) {
    const plan = deskTourPlan(lang);
    assert.deepEqual(plan.steps.map((step) => step.view), expectedRoutes);
    assert.equal(plan.steps.length, 10);
    for (const step of plan.steps) {
      assert.ok(step.sel);
      assert.ok(step.title);
      assert.ok(step.text.length > 40);
    }
  }
});

test('tour uses cockpit selectors, not the removed tab bar', () => {
  const selectors = deskTourPlan('en').steps.map((step) => step.sel).join(' ');
  assert.match(selectors, /#side-nav/);
  assert.match(selectors, /#bottom-nav/);
  assert.match(selectors, /#view-overview/);
  assert.match(selectors, /#d-lock/);
  assert.match(selectors, /#tab-chats/);
  assert.doesNotMatch(selectors, /#tab-bar|#backup-nudge/);
});

test('wallet step teaches the unified seed balance and no-collect model', () => {
  const en = deskTourPlan('en').steps.find((step) => step.view === 'wallet' && step.sel.includes('#wallet-box'));
  const ru = deskTourPlan('ru').steps.find((step) => step.view === 'wallet' && step.sel.includes('#wallet-box'));
  assert.match(en.text, /one spendable balance/i);
  assert.match(en.text, /no collect is needed/i);
  assert.match(ru.text, /одном доступном балансе/i);
  assert.match(ru.text, /собирать их не нужно/i);
});

test('settings step explains Forge Sync without promising separate-key transfer', () => {
  const en = deskTourPlan('en').steps.find((step) => step.view === 'settings');
  const ru = deskTourPlan('ru').steps.find((step) => step.view === 'settings');
  assert.match(en.text, /Forge Sync/i);
  assert.match(en.text, /Safe alarm keys are never synced/i);
  assert.match(ru.text, /Forge Sync/i);
  assert.match(ru.text, /тревожные ключи сейфов не синхронизирует/i);
});

test('unknown language falls back to English', () => {
  assert.equal(deskTourPlan('de').dialog, deskTourPlan('en').dialog);
  assert.notEqual(deskTourPlan('ru').dialog, deskTourPlan('en').dialog);
});
