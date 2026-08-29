import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// AGENTOBS_HOME must be redirected before any module reads it, so the test
// suite can never touch a developer's real ~/.agentobs database.
const home = mkdtempSync(join(tmpdir(), 'agentobs-test-'));
process.env.AGENTOBS_HOME = home;

const { openDb, closeDb, ensureDeviceId, getMeta } = await import('./db.js');
const {
  startSession,
  endSession,
  ensureSession,
  beginToolCall,
  completeToolCall,
  recordPolicyDecision,
} = await import('./repo.js');
const { getSummary, getTimeline, getToolsBreakdown, getRecentToolCalls, getSessions } =
  await import('./queries.js');

let db: ReturnType<typeof openDb>;

before(() => {
  db = openDb(join(home, 'test.db'));
});

after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

test('schema applies and a device id is minted once', () => {
  const first = ensureDeviceId(db);
  const second = ensureDeviceId(db);
  assert.equal(first, second, 'device id must be stable across calls');
  assert.equal(getMeta(db, 'device_id'), first);
});

test('a full session lifecycle rolls up correctly', () => {
  const sid = startSession(db, { agentName: 'claude-code', cwd: '/repo' });

  const ok = beginToolCall(db, { sessionId: sid, toolName: 'Bash', input: 'npm test' });
  completeToolCall(db, ok, {
    status: 'success',
    output: 'all tests pass',
    tokensIn: 1000,
    tokensOut: 500,
    model: 'claude-sonnet-4',
  });

  const bad = beginToolCall(db, { sessionId: sid, toolName: 'Edit', input: 'x' });
  completeToolCall(db, bad, { status: 'error', errorMessage: 'file not found' });

  endSession(db, sid, { exitCode: 0 });

  const session = getSessions(db)[0];
  assert.equal(session.tool_call_count, 2);
  assert.equal(session.error_count, 1);
  assert.equal(session.total_tokens_in, 1000);
  assert.equal(session.total_tokens_out, 500);
  // sonnet-4 at $3/$15 per Mtok: 1000 in + 500 out = 0.003 + 0.0075
  assert.ok(
    Math.abs((session.total_cost_usd ?? 0) - 0.0105) < 1e-9,
    `unexpected cost ${session.total_cost_usd}`,
  );
  assert.equal(session.exit_code, 0);
  assert.ok(session.ended_at);
});

test('cost is null - never guessed - for an unknown model', () => {
  const sid = startSession(db, { agentName: 'generic' });
  const id = beginToolCall(db, { sessionId: sid, toolName: 'Bash' });
  completeToolCall(db, id, {
    status: 'success',
    tokensIn: 5000,
    tokensOut: 5000,
    model: 'some-unreleased-model-9',
  });
  const row = getRecentToolCalls(db, { sessionId: sid })[0];
  assert.equal(row.cost_usd, null, 'unknown model must yield null, not a fabricated cost');
});

test('model ids with vendor prefixes and date suffixes still price', () => {
  const sid = startSession(db, { agentName: 'claude-code' });
  const id = beginToolCall(db, { sessionId: sid, toolName: 'Bash' });
  completeToolCall(db, id, {
    status: 'success',
    tokensIn: 1_000_000,
    tokensOut: 0,
    model: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
  });
  const row = getRecentToolCalls(db, { sessionId: sid })[0];
  assert.equal(row.cost_usd, 3, 'should match claude-sonnet-4 at $3/Mtok input');
});

test('secrets never reach the stored summary', () => {
  const sid = startSession(db, { agentName: 'claude-code' });
  const id = beginToolCall(db, {
    sessionId: sid,
    toolName: 'Bash',
    input: 'export AWS_KEY=AKIAIOSFODNN7EXAMPLE && deploy',
  });
  completeToolCall(db, id, {
    status: 'success',
    output: 'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  });
  const row = getRecentToolCalls(db, { sessionId: sid })[0];
  assert.ok(!row.input_summary?.includes('AKIAIOSFODNN7EXAMPLE'), row.input_summary ?? '');
  assert.ok(
    !row.output_summary?.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'),
    row.output_summary ?? '',
  );
});

test('a tool call orphaned from its session is still recorded', () => {
  // Hooks can fire without SessionStart - the agent may predate the install.
  // Dropping those calls would silently lose data.
  ensureSession(db, 'synthetic-session-1', 'claude-code', '/repo');
  const id = beginToolCall(db, { sessionId: 'synthetic-session-1', toolName: 'Read' });
  assert.ok(id);
  assert.equal(getRecentToolCalls(db, { sessionId: 'synthetic-session-1' }).length, 1);
});

test('a blocked call is recorded with its matching rule for the audit trail', () => {
  const sid = startSession(db, { agentName: 'claude-code' });
  const id = beginToolCall(db, {
    sessionId: sid,
    toolName: 'Bash',
    input: 'rm -rf /',
    status: 'blocked',
  });
  recordPolicyDecision(db, {
    toolCallId: id,
    sessionId: sid,
    toolName: 'Bash',
    ruleMatched: 'no-recursive-delete',
    decision: 'block',
    reason: 'matched rm -rf',
  });
  const row = getRecentToolCalls(db, { sessionId: sid })[0];
  assert.equal(row.status, 'blocked');
  assert.equal(row.rule_matched, 'no-recursive-delete');
});

test('summary aggregates and flags uncosted calls honestly', () => {
  const s = getSummary(db, 'all');
  assert.ok(s.tool_calls > 0);
  assert.ok(s.sessions > 0);
  assert.ok(s.error_rate >= 0 && s.error_rate <= 1);
  // The unknown-model call above must be counted as uncosted, so the UI can
  // say the total is incomplete rather than quietly under-reporting.
  assert.ok(s.uncosted_calls >= 1, `expected uncosted calls, got ${s.uncosted_calls}`);
  assert.equal(s.blocked, 1);
});

test('timeline and breakdown return usable rows', () => {
  const timeline = getTimeline(db, 'all');
  assert.ok(timeline.length > 0);
  assert.ok(timeline[0].bucket, 'bucket label must be present');

  const tools = getToolsBreakdown(db, 'all');
  assert.ok(tools.length > 0);
  // Ordered by call count descending.
  for (let i = 1; i < tools.length; i++) {
    assert.ok(tools[i - 1].calls >= tools[i].calls, 'breakdown must be sorted by calls desc');
  }
});

test('completing an unknown tool call id is a no-op, not a crash', () => {
  // A PostToolUse hook can arrive without its PreToolUse partner (agent
  // restarted mid-call); this must never throw inside the observed agent.
  assert.doesNotThrow(() => completeToolCall(db, 'does-not-exist', { status: 'success' }));
});
