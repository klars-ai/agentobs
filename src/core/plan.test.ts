/**
 * Tests for plan detection.
 *
 * The bug this guards: cost is computed from token counts at API list price
 * and was presented as spend. On a subscription that is not spend at all - a
 * Claude Max user saw "$5,525.61 this week" against a fixed monthly fee. The
 * arithmetic was right and the label was wrong, which is worse than a visibly
 * broken number because it looks authoritative.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'agentobs-plan-'));
process.env.CLAUDE_CONFIG_DIR = dir;

const { detectPlan, costCaveat, costLabel, tierLabel, __resetPlanCache } = await import(
  './plan.js',
);

const write = (value: unknown): void =>
  writeFileSync(join(dir, '.claude.json'), JSON.stringify(value), 'utf8');

test.after(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the OS can reclaim a temp dir */
  }
});

test('an OAuth account is a subscription, and the tier is read', () => {
  write({
    oauthAccount: {
      organizationRateLimitTier: 'default_claude_max_5x',
      seatTier: null,
    },
  });
  __resetPlanCache();

  const plan = detectPlan(true);
  assert.equal(plan.kind, 'subscription');
  assert.equal(plan.tier, 'default_claude_max_5x');
  assert.equal(plan.label, 'Claude Max 5x');
});

test('a subscription gets a caveat naming the plan', () => {
  write({ oauthAccount: { organizationRateLimitTier: 'default_claude_max_5x' } });
  __resetPlanCache();

  const caveat = costCaveat(detectPlan(true));
  assert.ok(caveat, 'a subscription must carry a caveat');
  assert.match(caveat!, /not a bill/i, 'must say the figure is not what they pay');
  assert.match(caveat!, /Claude Max 5x/, 'must name the plan');
  assert.match(caveat!, /--tokens/, 'must point at the limit that actually applies');
});

test('the headline is not called "spend" on a subscription', () => {
  // "Spend this week: $5,525.61" against a flat monthly fee is the whole bug.
  write({ oauthAccount: { organizationRateLimitTier: 'default_claude_max_5x' } });
  __resetPlanCache();
  assert.equal(costLabel(detectPlan(true)), 'API-equivalent usage');

  write({ someOtherKey: true });
  __resetPlanCache();
  assert.equal(costLabel(detectPlan(true)), 'Spend', 'on an API key it really is spend');
});

test('no OAuth account means an API key, where dollars are real', () => {
  // Here the figure needs no caveat: the user is billed per token.
  write({ someOtherKey: true });
  __resetPlanCache();

  const plan = detectPlan(true);
  assert.equal(plan.kind, 'api');
  assert.equal(costCaveat(plan), null, 'an API plan must not be caveated');
});

test('a missing or corrupt config is unknown, not a guess', () => {
  rmSync(join(dir, '.claude.json'), { force: true });
  __resetPlanCache();
  assert.equal(detectPlan(true).kind, 'unknown');

  writeFileSync(join(dir, '.claude.json'), '{ not json', 'utf8');
  __resetPlanCache();
  // Must not throw: this runs in the hook path, where an exception would
  // surface inside the user's agent.
  assert.equal(detectPlan(true).kind, 'unknown');
});

test('tier strings become readable labels', () => {
  assert.equal(tierLabel('default_claude_max_5x'), 'Claude Max 5x');
  assert.equal(tierLabel('default_claude_pro'), 'Claude Pro');
  assert.equal(tierLabel(null), null);
  assert.equal(tierLabel(''), null);
});
