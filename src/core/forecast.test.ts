import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'agentobs-forecast-'));
process.env.AGENTOBS_HOME = home;

const { openDb, closeDb } = await import('./db.js');
const { setBudget, checkBudgets } = await import('./budget.js');
const { forecastBudget, humanDuration } = await import('./forecast.js');
const { startSession, beginToolCall, completeToolCall } = await import('./repo.js');

let db: ReturnType<typeof openDb>;

before(() => {
  db = openDb(join(home, 'f.db'));
});

after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

/** Seeds `count` calls spread over the last `minutes`, each costing ~`usdEach`. */
function seed(count: number, minutes: number, usdEach: number): void {
  const sid = startSession(db, { agentName: 'test', cwd: '/repo' });
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const ts = new Date(now - (minutes - (i * minutes) / count) * 60000).toISOString();
    const id = beginToolCall(db, { sessionId: sid, toolName: 'Bash', startedAt: ts });
    completeToolCall(db, id, {
      status: 'success',
      tokensIn: 0,
      tokensOut: Math.round((usdEach / 15) * 1_000_000),
      model: 'claude-sonnet-4',
      endedAt: ts,
    });
  }
}

test('no projection without enough samples', () => {
  setBudget(db, { period: 'daily', limitUsd: 5 });
  const status = checkBudgets(db, { record: false })[0];
  const f = forecastBudget(db, status);
  assert.equal(f.minutesToLimit, null, 'must not project from nothing');
  assert.equal(f.confidence, 'none');
  assert.ok(f.note, 'should say why it cannot project');
});

test('projects a time-to-limit once there is real activity', () => {
  seed(30, 30, 0.0667); // ~$2 over 30 minutes against a $5 limit
  const status = checkBudgets(db, { record: false })[0];
  const f = forecastBudget(db, status);

  assert.ok(f.ratePerHour > 0, 'a rate should be measurable');
  assert.ok(f.minutesToLimit !== null, 'should project a time to the limit');
  assert.ok(f.minutesToLimit > 0, 'the limit is ahead, not behind');
  assert.ok(f.projectedTotal > status.spent, 'projection should exceed current spend');
});

test('the rate comes from recent activity, not the whole period', () => {
  // Regression: averaging over the whole period diluted a 40-minute burst by
  // the hours of idle time around it - roughly 7x - which under-warns exactly
  // the person actively working.
  const status = checkBudgets(db, { record: false })[0];
  const f = forecastBudget(db, status);
  const dilutedRate = (status.spent / ((Date.now() - Date.parse(status.periodStart)) / 60000)) * 60;
  assert.ok(
    f.ratePerHour > dilutedRate,
    `recent-window rate ${f.ratePerHour} should exceed period-average ${dilutedRate}`,
  );
});

test('an already-exceeded budget reports no projection', () => {
  setBudget(db, { period: 'monthly', limitUsd: 0.01 });
  const status = checkBudgets(db, { record: false }).find((s) => s.budget.period === 'monthly')!;
  const f = forecastBudget(db, status);
  assert.equal(f.minutesToLimit, null);
  assert.match(f.note ?? '', /already/i);
});

test('durations read the way a human would say them', () => {
  assert.equal(humanDuration(0.4), 'under a minute');
  assert.equal(humanDuration(44), '44 min');
  assert.equal(humanDuration(125), '2h 5m');
  assert.equal(humanDuration(2880), '2 days');
  assert.equal(humanDuration(-1), '—');
});
