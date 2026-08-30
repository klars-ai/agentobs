/**
 * Tests for the optimisation hints.
 *
 * The risk with any "insights" feature is that it degrades into horoscope
 * text - advice that is always true, never specific, and therefore never
 * acted on. These tests pin the three rules that keep it honest: stay silent
 * below the sample threshold, name the number that triggered the hint, and do
 * not describe a human waiting as a performance problem.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'agentobs-advice-'));
process.env.AGENTOBS_HOME = home;
// No Claude config here, so the plan reads as unknown and the
// subscription-specific hint stays out of these fixtures.
process.env.CLAUDE_CONFIG_DIR = join(home, 'no-claude');

const { openDb } = await import('./db.js');
const { getHints } = await import('./advice.js');

test.after(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* the OS reclaims a temp dir */
  }
});

const db = openDb();
const now = new Date().toISOString();

function addSession(id: string, tokensIn = 0): void {
  db.prepare(
    `INSERT OR IGNORE INTO sessions (id, agent_name, started_at, updated_at, total_tokens_in)
     VALUES (?, 'claude-code', ?, ?, ?)`,
  ).run(id, now, now, tokensIn);
}

function addCalls(
  prefix: string,
  tool: string,
  count: number,
  opts: { status?: string; cost?: number | null; durationMs?: number; input?: string } = {},
): void {
  addSession('s-main');
  for (let i = 0; i < count; i += 1) {
    db.prepare(
      `INSERT INTO tool_calls
         (id, session_id, tool_name, started_at, status, cost_usd, duration_ms, input_summary, updated_at)
       VALUES (?, 's-main', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `${prefix}-${i}`,
      tool,
      now,
      opts.status ?? 'success',
      opts.cost ?? null,
      opts.durationMs ?? null,
      opts.input ?? null,
      now,
    );
  }
}

test('says nothing when there is too little data to mean anything', () => {
  addCalls('tiny', 'Bash', 5);
  assert.deepEqual(getHints(db, 'today'), [], 'five calls cannot support advice');
});

test('a failing tool is reported with the count that triggered it', () => {
  addCalls('ok', 'Write', 40);
  addCalls('bad', 'Write', 10, { status: 'error' });

  const hint = getHints(db, 'today').find((h) => h.kind === 'reliability');
  assert.ok(hint, 'a 20% failure rate should be raised');
  // The specific number is the point: without it this is unactionable.
  assert.match(hint!.title, /Write failed 10 of 50 times \(20%\)/);
});

test('a tool failing rarely is not worth interrupting for', () => {
  const before = getHints(db, 'today').filter((h) => h.kind === 'reliability').length;
  addCalls('rare-ok', 'Glob', 200);
  addCalls('rare-bad', 'Glob', 2, { status: 'error' });

  const glob = getHints(db, 'today').find((h) => h.title.startsWith('Glob'));
  assert.equal(glob, undefined, '1% is noise, not a pattern');
  assert.ok(before >= 0);
});

test('a human-paced tool is never called slow', () => {
  // AskUserQuestion averaging half an hour means someone went to lunch.
  // Reporting that as a performance problem is advice nobody can act on.
  addCalls('ask', 'AskUserQuestion', 15, { durationMs: 1_800_000 });

  const speed = getHints(db, 'today').filter((h) => h.kind === 'speed');
  assert.ok(
    !speed.some((h) => h.title.includes('AskUserQuestion')),
    'waiting for a human is not a slow tool',
  );
});

test('a genuinely slow tool is reported', () => {
  addCalls('slow', 'Bash', 12, { durationMs: 45_000 });

  const hint = getHints(db, 'today').find((h) => h.kind === 'speed');
  assert.ok(hint, 'a tool averaging 45s over 12 calls is worth flagging');
  assert.match(hint!.title, /Bash averages 45s per call/);
});

test('a long session is flagged, since context is re-sent every turn', () => {
  addSession('s-huge', 3_000_000);

  const hint = getHints(db, 'today').find((h) => h.title.includes('2M input tokens'));
  assert.ok(hint, 'a 3M-token session should be raised');
  assert.match(hint!.detail, /\/clear/, 'and should say what to do about it');
});

test('hints are ranked and capped', () => {
  const hints = getHints(db, 'today');
  assert.ok(hints.length <= 4, 'a long list is a list nobody reads');
  for (let i = 1; i < hints.length; i += 1) {
    assert.ok(hints[i - 1].weight >= hints[i].weight, 'ordered by impact');
  }
});

test('every hint carries evidence and an action', () => {
  for (const h of getHints(db, 'today')) {
    // A title with no digit in it is almost certainly a generality.
    assert.match(h.title, /\d/, `hint has no number in it: ${h.title}`);
    assert.ok(h.detail.length > 40, `hint has no actionable detail: ${h.title}`);
  }
});
