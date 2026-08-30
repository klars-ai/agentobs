/**
 * Tests for the day-by-day breakdown.
 *
 * Two properties matter here and neither is obvious from the SQL.
 *
 * A session's totals are stamped with its start date, so building a daily view
 * from sessions puts a run that spanned five days entirely on the day it began.
 * Tool calls carry their own timestamps, so the view is built from those.
 *
 * And a day with no activity is information. Dropping empty rows makes a chart
 * silently compress time, so a fortnight of nothing reads as continuous work.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'agentobs-daily-'));
process.env.AGENTOBS_HOME = home;

const { openDb } = await import('./db.js');
const { getDaily, rangeMinutes, rangeLabel, rangeStart } = await import('./queries.js');

test.after(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* the OS reclaims a temp dir */
  }
});

/** An ISO timestamp `daysAgo` days back, at midday local time. */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(12, 0, 0, 0);
  return d.toISOString();
}

const db = openDb();

test('calls land on the day they happened, not the day their session began', () => {
  // One session started five days ago, with calls on three different days.
  db.prepare(
    `INSERT INTO sessions (id, agent_name, started_at, updated_at)
     VALUES ('s-span', 'claude-code', ?, ?)`,
  ).run(daysAgo(5), daysAgo(1));

  for (const [i, day] of [5, 3, 1].entries()) {
    db.prepare(
      `INSERT INTO tool_calls (id, session_id, tool_name, started_at, status, cost_usd, tokens_in, tokens_out, updated_at)
       VALUES (?, 's-span', 'Bash', ?, 'success', 1.5, 100, 50, ?)`,
    ).run(`c-${i}`, daysAgo(day), daysAgo(day));
  }

  const rows = getDaily(db, '7d');
  const withCalls = rows.filter((r) => r.calls > 0);

  assert.equal(withCalls.length, 3, 'three separate days, not one');
  for (const r of withCalls) {
    assert.equal(r.calls, 1);
    assert.equal(r.cost_usd, 1.5);
  }
});

test('quiet days are present, not skipped', () => {
  const rows = getDaily(db, '7d');
  // A 7-day window covers 8 calendar days inclusive of both ends.
  assert.ok(rows.length >= 7, `expected a row per day, got ${rows.length}`);
  assert.ok(
    rows.some((r) => r.calls === 0),
    'a day with no calls must still appear',
  );
});

test('rows are ordered oldest first, with no duplicate days', () => {
  const rows = getDaily(db, '7d');
  const days = rows.map((r) => r.day);
  assert.deepEqual(days, [...days].sort(), 'ascending by date');
  assert.equal(new Set(days).size, days.length, 'no day appears twice');
});

test('a day whose calls have no price reports null, never zero', () => {
  db.prepare(
    `INSERT INTO sessions (id, agent_name, started_at, updated_at)
     VALUES ('s-free', 'claude-code', ?, ?)`,
  ).run(daysAgo(2), daysAgo(2));
  db.prepare(
    `INSERT INTO tool_calls (id, session_id, tool_name, started_at, status, cost_usd, updated_at)
     VALUES ('c-free', 's-free', 'Read', ?, 'success', NULL, ?)`,
  ).run(daysAgo(2), daysAgo(2));

  const row = getDaily(db, '7d').find((r) => r.calls === 1 && r.cost_usd === null);
  assert.ok(row, 'an unpriced day must report null cost');
  assert.ok(row!.uncosted_calls > 0, 'and say how many calls were unpriced');
});

test('errors and blocked calls are counted per day', () => {
  db.prepare(
    `INSERT INTO tool_calls (id, session_id, tool_name, started_at, status, updated_at)
     VALUES ('c-err', 's-span', 'Bash', ?, 'error', ?)`,
  ).run(daysAgo(1), daysAgo(1));
  db.prepare(
    `INSERT INTO tool_calls (id, session_id, tool_name, started_at, status, updated_at)
     VALUES ('c-blk', 's-span', 'Bash', ?, 'blocked', ?)`,
  ).run(daysAgo(1), daysAgo(1));

  const rows = getDaily(db, '7d');
  const totalErrors = rows.reduce((a, r) => a + r.errors, 0);
  const totalBlocked = rows.reduce((a, r) => a + r.blocked, 0);
  assert.equal(totalErrors, 1);
  assert.equal(totalBlocked, 1);
});

test('a <n>m range resolves to that many minutes ago', () => {
  const before = Date.now();
  const start = Date.parse(rangeStart('20m') as string);
  const minutesBack = (before - start) / 60000;
  assert.ok(Math.abs(minutesBack - 20) < 0.5, `expected ~20 minutes, got ${minutesBack}`);
});

test('an out-of-bounds minute window is refused, not clamped', () => {
  // A crafted ?range=99999m must not turn into an unbounded scan, and
  // silently returning everything would look like the filter did nothing.
  assert.equal(rangeMinutes('99999m' as never), null);
  assert.equal(rangeMinutes('0m' as never), null);
  assert.equal(rangeMinutes('-5m' as never), null);
  assert.equal(rangeMinutes('abc' as never), null);
  assert.equal(rangeMinutes('today'), null, 'a named range has no minute count');
});

test('minute windows are labelled in the unit a reader thinks in', () => {
  assert.equal(rangeLabel('5m' as never), 'Last 5 min');
  assert.equal(rangeLabel('60m' as never), 'Last 1h');
  assert.equal(rangeLabel('300m' as never), 'Last 5h');
  assert.equal(rangeLabel('today'), 'Today');
});

test('a short window returns only recent rows', () => {
  // Everything seeded by the tests above is at least a day old, so a 5-minute
  // window must come back empty rather than falling through to all rows.
  const rows = getDaily(db, '5m' as never);
  const calls = rows.reduce((a, r) => a + r.calls, 0);
  assert.equal(calls, 0, 'a 5-minute window must not include day-old calls');
});
