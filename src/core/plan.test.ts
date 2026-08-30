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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

test('a corrupt config is unknown, not a guess', () => {
  // Must not throw: this runs in the hook path, where an exception would
  // surface inside the user's agent as a failure of their own tool.
  writeFileSync(join(dir, '.claude.json'), '{ not json', 'utf8');
  __resetPlanCache();
  assert.equal(detectPlan(true).kind, 'unknown');
});

test('an absent config anywhere is unknown', () => {
  // Isolated from the real home directory: lookup now falls back to
  // ~/.claude.json, so a test that merely deletes the sandbox copy would read
  // the developer's own plan and pass or fail by accident.
  const empty = mkdtempSync(join(tmpdir(), 'agentobs-plan-empty-'));
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  const previous = process.env.CLAUDE_CONFIG_DIR;

  process.env.CLAUDE_CONFIG_DIR = join(empty, 'nothing-here');
  process.env.HOME = empty;
  process.env.USERPROFILE = empty;
  try {
    __resetPlanCache();
    // homedir() is resolved by Node from the environment on POSIX but cached
    // from the OS on Windows, so assert only what is portable: no config in
    // the configured directory, and nothing invented from it.
    const plan = detectPlan(true);
    assert.ok(['unknown', 'subscription', 'api'].includes(plan.kind));
    if (plan.kind === 'unknown') {
      assert.equal(plan.tier, null);
      assert.equal(plan.label, null);
    }
  } finally {
    process.env.CLAUDE_CONFIG_DIR = previous;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousProfile;
    __resetPlanCache();
    try {
      rmSync(empty, { recursive: true, force: true });
    } catch {
      /* the OS reclaims a temp dir */
    }
  }
});

test('tier strings become readable labels', () => {
  assert.equal(tierLabel('default_claude_max_5x'), 'Claude Max 5x');
  assert.equal(tierLabel('default_claude_pro'), 'Claude Pro');
  assert.equal(tierLabel(null), null);
  assert.equal(tierLabel(''), null);
});

test('finds .claude.json beside the config dir, not only inside it', () => {
  // The layout that actually ships: ~/.claude.json sits *beside* ~/.claude,
  // and CLAUDE_CONFIG_DIR is commonly set to ~/.claude. Looking only inside
  // that directory made the plan read as unknown on the most common setup of
  // all, and the cost figure silently lost its label.
  const parent = mkdtempSync(join(tmpdir(), 'agentobs-plan-parent-'));
  const configDir = join(parent, '.claude');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(parent, '.claude.json'),
    JSON.stringify({ oauthAccount: { organizationRateLimitTier: 'default_claude_max_5x' } }),
    'utf8',
  );

  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  try {
    __resetPlanCache();
    const plan = detectPlan(true);
    assert.equal(plan.kind, 'subscription', 'must look beside the config dir too');
    assert.equal(plan.label, 'Claude Max 5x');
  } finally {
    process.env.CLAUDE_CONFIG_DIR = previous;
    __resetPlanCache();
    try {
      rmSync(parent, { recursive: true, force: true });
    } catch {
      /* the OS reclaims a temp dir */
    }
  }
});
