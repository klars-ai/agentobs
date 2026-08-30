import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'agentobs-budget-'));
process.env.AGENTOBS_HOME = home;

const { openDb, closeDb } = await import('./db.js');
const { setBudget, listBudgets, removeBudget, checkBudgets, blockingBudget, periodBounds } =
  await import('./budget.js');
const { startSession, beginToolCall, completeToolCall } = await import('./repo.js');

let db: ReturnType<typeof openDb>;

before(() => {
  db = openDb(join(home, 'b.db'));
});

after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

/** Records a session whose tool call costs roughly `usd`. */
function spend(usd: number, cwd = '/repo'): void {
  const sid = startSession(db, { agentName: 'test', cwd });
  const id = beginToolCall(db, { sessionId: sid, toolName: 'Bash' });
  // sonnet-4 output is $15/Mtok, so tokens = usd/15 * 1e6 gives the target.
  completeToolCall(db, id, {
    status: 'success',
    tokensIn: 0,
    tokensOut: Math.round((usd / 15) * 1_000_000),
    model: 'claude-sonnet-4',
  });
}

test('setting a budget twice updates rather than duplicating it', () => {
  setBudget(db, { period: 'daily', limitUsd: 5 });
  setBudget(db, { period: 'daily', limitUsd: 10 });
  const daily = listBudgets(db).filter((b) => b.period === 'daily');
  assert.equal(daily.length, 1, 'a second set must update, not stack a second limit');
  assert.equal(daily[0].limit_usd, 10);
});

test('a budget under its limit is not exceeded', () => {
  spend(1);
  const status = checkBudgets(db).find((s) => s.budget.period === 'daily')!;
  assert.equal(status.exceeded, false);
  assert.ok(status.ratio > 0 && status.ratio < 1, `unexpected ratio ${status.ratio}`);
});

test('crossing the limit reports exceeded, but only alerts once per period', () => {
  spend(20); // now well past the $10 daily limit
  const first = checkBudgets(db).find((s) => s.budget.period === 'daily')!;
  assert.equal(first.exceeded, true);
  assert.equal(first.newlyExceeded, true, 'first crossing should alert');

  // The one-shot guarantee: without it a warning would print on every
  // subsequent tool call for the rest of the day.
  const second = checkBudgets(db).find((s) => s.budget.period === 'daily')!;
  assert.equal(second.exceeded, true);
  assert.equal(second.newlyExceeded, false, 'must not alert twice in one period');
});

test('a warn budget does not block; a block budget does', () => {
  assert.equal(blockingBudget(checkBudgets(db, { record: false })), null, 'warn must not block');

  setBudget(db, { period: 'monthly', limitUsd: 1, action: 'block' });
  const blocking = blockingBudget(checkBudgets(db, { record: false }));
  assert.ok(blocking, 'an exceeded block budget should be returned');
  assert.equal(blocking.budget.action, 'block');
});

test('a scoped budget only counts spend under its own path', () => {
  setBudget(db, { period: 'monthly', limitUsd: 1000, scope: '/other-project' });
  const scoped = checkBudgets(db, { record: false }).find(
    (s) => s.budget.scope === '/other-project',
  )!;
  assert.equal(scoped.spent, 0, 'spend in /repo must not count against /other-project');
  assert.equal(scoped.exceeded, false);
});

test('period keys are stable within a period and differ across periods', () => {
  // Midday avoids the case where a UTC timestamp lands on a different local
  // calendar day, which is the point of the local-date fix rather than a
  // quirk to test around.
  const a = periodBounds('daily', new Date('2026-08-30T09:00:00Z'));
  const b = periodBounds('daily', new Date('2026-08-30T14:00:00Z'));
  const c = periodBounds('daily', new Date('2026-08-31T09:00:00Z'));
  assert.equal(a.key, b.key, 'same day must share a key, or alerts would repeat');
  assert.notEqual(a.key, c.key, 'a new day must get a new key, or alerts would never re-fire');

  // Keys carry a period prefix so a daily and a monthly budget can never
  // collide on the same string.
  assert.ok(periodBounds('monthly', new Date('2026-08-30T12:00:00Z')).key.startsWith('M'));
  assert.ok(periodBounds('weekly', new Date('2026-08-30T12:00:00Z')).key.startsWith('W'));
  assert.ok(periodBounds('daily', new Date('2026-08-30T12:00:00Z')).key.startsWith('D'));
});

test('removing a budget removes it and its events', () => {
  const b = setBudget(db, { period: 'weekly', limitUsd: 3 });
  assert.equal(removeBudget(db, b.id), true);
  assert.equal(
    listBudgets(db).some((x) => x.id === b.id),
    false,
  );
  assert.equal(removeBudget(db, 'no-such-id'), false, 'removing a missing budget is not an error');
});
