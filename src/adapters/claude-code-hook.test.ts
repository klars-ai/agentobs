import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Redirect AGENTOBS_HOME before any module reads it.
const home = mkdtempSync(join(tmpdir(), 'agentobs-hook-test-'));
process.env.AGENTOBS_HOME = home;

// A policy the tests can rely on, written before the engine first loads it.
writeFileSync(
  join(home, 'policy.json'),
  JSON.stringify({
    rules: [
      { name: 'block-rm', match: { tool: 'Bash', command_pattern: '*rm -rf*' }, decision: 'block' },
      { name: 'guard-env', match: { tool: '*', path_pattern: '**/.env*' }, decision: 'needs_approval' },
    ],
    default_decision: 'allow',
  }),
);

const { handleHook } = await import('./claude-code-hook.js');
const { openDb, closeDb } = await import('../core/db.js');
const { getRecentToolCalls, getSessions } = await import('../core/queries.js');

let db: ReturnType<typeof openDb>;

before(() => {
  db = openDb();
});

after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

test('SessionStart records a session', () => {
  const result = handleHook({
    hook_event_name: 'SessionStart',
    session_id: 'hook-s1',
    cwd: '/repo',
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, undefined, 'SessionStart must not write to stdout');

  const session = getSessions(db).find((s) => s.id === 'hook-s1');
  assert.ok(session, 'session should exist');
  assert.equal(session.agent_name, 'claude-code');
  assert.equal(session.fidelity, 'rich');
});

test('an allowed PreToolUse stays silent so normal permissions still apply', () => {
  // Emitting permissionDecision:"allow" here would force-allow a call the
  // user's own settings might have prompted about. Staying silent is the
  // correct pass-through.
  const result = handleHook({
    hook_event_name: 'PreToolUse',
    session_id: 'hook-s1',
    tool_name: 'Bash',
    tool_use_id: 'call-ok',
    tool_input: { command: 'npm test' },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, undefined);

  const call = getRecentToolCalls(db, { sessionId: 'hook-s1' }).find((c) => c.id === 'call-ok');
  assert.ok(call);
  assert.equal(call.status, 'pending');
});

test('a blocked PreToolUse returns the documented deny payload', () => {
  const result = handleHook({
    hook_event_name: 'PreToolUse',
    session_id: 'hook-s1',
    tool_name: 'Bash',
    tool_use_id: 'call-block',
    tool_input: { command: 'rm -rf /var/data' },
  });

  // Exit 0 with JSON on stdout - JSON is only honoured on exit 0, and this
  // shape is what Claude Code reads to deny the call.
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout, 'a block must write a decision to stdout');

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(payload.hookSpecificOutput.permissionDecisionReason, /block-rm/);

  const call = getRecentToolCalls(db, { sessionId: 'hook-s1' }).find((c) => c.id === 'call-block');
  assert.equal(call?.status, 'blocked');
  assert.equal(call?.rule_matched, 'block-rm', 'the audit trail must name the rule');
});

test('needs_approval denies with guidance rather than silently allowing', () => {
  const result = handleHook({
    hook_event_name: 'PreToolUse',
    session_id: 'hook-s1',
    tool_name: 'Edit',
    tool_use_id: 'call-env',
    tool_input: { file_path: '/repo/.env' },
  });
  const payload = JSON.parse(result.stdout ?? '{}');
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(payload.hookSpecificOutput.permissionDecisionReason, /approval/i);
});

test('PostToolUse completes the call and never invents token counts', () => {
  handleHook({
    hook_event_name: 'PostToolUse',
    session_id: 'hook-s1',
    tool_name: 'Bash',
    tool_use_id: 'call-ok',
    tool_response: 'done',
  });

  const call = getRecentToolCalls(db, { sessionId: 'hook-s1' }).find((c) => c.id === 'call-ok');
  assert.equal(call?.status, 'success');
  // PostToolUse carries no usage data; a number here would be fabricated.
  assert.equal(call?.cost_usd, null);
});

test('a tool result flagged as an error is recorded as an error', () => {
  handleHook({
    hook_event_name: 'PreToolUse',
    session_id: 'hook-s1',
    tool_name: 'Bash',
    tool_use_id: 'call-err',
    tool_input: { command: 'exit 1' },
  });
  handleHook({
    hook_event_name: 'PostToolUse',
    session_id: 'hook-s1',
    tool_name: 'Bash',
    tool_use_id: 'call-err',
    tool_response: { is_error: true, content: 'command failed' },
  });

  const call = getRecentToolCalls(db, { sessionId: 'hook-s1' }).find((c) => c.id === 'call-err');
  assert.equal(call?.status, 'error');
  assert.match(call?.error_message ?? '', /failed/);
});

test('secrets in tool input never reach storage', () => {
  handleHook({
    hook_event_name: 'PreToolUse',
    session_id: 'hook-s1',
    tool_name: 'Bash',
    tool_use_id: 'call-secret',
    tool_input: { command: 'export AWS_KEY=AKIAIOSFODNN7EXAMPLE && deploy' },
  });
  const call = getRecentToolCalls(db, { sessionId: 'hook-s1' }).find((c) => c.id === 'call-secret');
  assert.ok(!call?.input_summary?.includes('AKIAIOSFODNN7EXAMPLE'), call?.input_summary ?? '');
});

test('a tool call arriving without SessionStart is still recorded', () => {
  // The agent may have been running before AgentObs was installed.
  handleHook({
    hook_event_name: 'PreToolUse',
    session_id: 'never-announced',
    tool_name: 'Read',
    tool_use_id: 'orphan-1',
    tool_input: { file_path: '/repo/README.md' },
  });
  assert.equal(getRecentToolCalls(db, { sessionId: 'never-announced' }).length, 1);
});

test('an unknown hook event is ignored without failing', () => {
  const result = handleHook({ hook_event_name: 'SomeFutureEvent', session_id: 'hook-s1' });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, undefined);
});

test('SessionEnd closes the session', () => {
  handleHook({ hook_event_name: 'SessionEnd', session_id: 'hook-s1' });
  const session = getSessions(db).find((s) => s.id === 'hook-s1');
  assert.ok(session?.ended_at, 'session should be closed');
});
