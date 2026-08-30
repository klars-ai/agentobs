/**
 * Tests for the pricing table, and for topping up an existing one.
 *
 * The top-up exists because of a failure that is invisible until someone looks
 * at a bill: pricing.json is written once at install and never touched again,
 * so a user who installed before a model shipped gets `null` cost for it
 * forever. Nothing errors - an unpriced model is reported as blank by design -
 * so the dashboard just shows no spend and never says why.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'agentobs-pricing-'));
process.env.AGENTOBS_HOME = home;
mkdirSync(home, { recursive: true });

const { DEFAULT_PRICING, writeDefaultPricing, findModelPrice, computeCost, __resetPricingCache } =
  await import('./pricing.js');

const file = join(home, 'pricing.json');

test.after(() => rmSync(home, { recursive: true, force: true }));

test('a fresh install writes the full default table', () => {
  rmSync(file, { force: true });
  __resetPricingCache();

  const r = writeDefaultPricing();
  assert.equal(r.added.length, 0, 'a new file is written whole, not "added to"');

  const written = JSON.parse(readFileSync(file, 'utf8')) as typeof DEFAULT_PRICING;
  assert.deepEqual(Object.keys(written.models), Object.keys(DEFAULT_PRICING.models));
});

test('an older table is topped up with models it does not have', () => {
  // Exactly the shape of a real file written before the Claude 5 models
  // existed: valid, hand-editable, and quietly missing what you now run.
  writeFileSync(
    file,
    JSON.stringify({
      _comment: 'mine',
      updated: '2026-01-01',
      models: { 'claude-opus-4': { input_per_mtok: 15, output_per_mtok: 75 } },
    }),
    'utf8',
  );
  __resetPricingCache();

  const r = writeDefaultPricing();
  assert.ok(r.added.includes('claude-opus-5'), 'the missing model should be added');
  assert.ok(r.added.length > 1);

  const after = JSON.parse(readFileSync(file, 'utf8')) as typeof DEFAULT_PRICING;
  assert.ok(after.models['claude-opus-5'], 'new model present');
  assert.ok(after.models['claude-opus-4'], 'existing model kept');
});

test('a price the user edited is never overwritten', () => {
  // This file is where an organisation puts its contracted rates. Replacing a
  // rate someone set deliberately would be worse than leaving them out of date.
  writeFileSync(
    file,
    JSON.stringify({
      updated: '2026-01-01',
      models: { 'claude-opus-4': { input_per_mtok: 1.23, output_per_mtok: 4.56 } },
    }),
    'utf8',
  );
  __resetPricingCache();

  writeDefaultPricing();

  const after = JSON.parse(readFileSync(file, 'utf8')) as typeof DEFAULT_PRICING;
  assert.equal(after.models['claude-opus-4'].input_per_mtok, 1.23, 'their rate survives');
  assert.equal(after.models['claude-opus-4'].output_per_mtok, 4.56);
});

test('a table that already has everything is left alone', () => {
  writeFileSync(file, JSON.stringify(DEFAULT_PRICING), 'utf8');
  const before = readFileSync(file, 'utf8');
  __resetPricingCache();

  const r = writeDefaultPricing();
  assert.equal(r.added.length, 0);
  assert.equal(readFileSync(file, 'utf8'), before, 'no rewrite when nothing is missing');
});

test('a corrupt file is left for the user to fix, not replaced', () => {
  writeFileSync(file, '{ not json at all', 'utf8');
  __resetPricingCache();

  const r = writeDefaultPricing();
  assert.equal(r.added.length, 0);
  assert.equal(readFileSync(file, 'utf8'), '{ not json at all', 'their file is untouched');
});

test('the shipped table prices the models this tool actually reports', () => {
  writeFileSync(file, JSON.stringify(DEFAULT_PRICING), 'utf8');
  __resetPricingCache();

  // Every id here has been seen in a real transcript's message.model field.
  // A gap means silent blank costs, which is the bug this file guards.
  for (const id of [
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-opus-4-20250514',
    'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001',
  ]) {
    assert.ok(findModelPrice(id), `${id} has no price entry`);
    assert.ok((computeCost(id, 1_000, 1_000) ?? 0) > 0, `${id} costs nothing`);
  }
});

test('an unknown model costs null, never zero', () => {
  __resetPricingCache();
  assert.equal(computeCost('some-model-we-have-never-heard-of', 1_000_000, 1_000), null);
});
