/**
 * Data-access layer: the ONLY place that writes sessions/tool_calls.
 *
 * Centralising writes here is what makes the privacy guarantee auditable -
 * redaction is applied on the way in (see redact()), so no adapter can
 * bypass it by writing a summary directly, and a reviewer only has to check
 * this one file to confirm the claim.
 */
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { redact } from './redact.js';
import { computeCost } from './pricing.js';
import { getMeta } from './db.js';

export type ToolStatus = 'success' | 'error' | 'pending' | 'blocked';
export type Fidelity = 'rich' | 'coarse';

const nowIso = (): string => new Date().toISOString();

export interface StartSessionInput {
  id?: string;
  agentName: string;
  cwd?: string | null;
  gitBranch?: string | null;
  fidelity?: Fidelity;
  startedAt?: string;
}

export function startSession(db: DatabaseSync, input: StartSessionInput): string {
  const id = input.id ?? randomUUID();
  const ts = input.startedAt ?? nowIso();
  db.prepare(
    `INSERT INTO sessions (id, agent_name, started_at, cwd, git_branch, fidelity, device_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(
    id,
    input.agentName,
    ts,
    input.cwd ?? null,
    input.gitBranch ?? null,
    input.fidelity ?? 'rich',
    getMeta(db, 'device_id'),
    ts,
  );
  return id;
}

export function endSession(
  db: DatabaseSync,
  sessionId: string,
  opts: { exitCode?: number | null; endedAt?: string } = {},
): void {
  db.prepare(
    `UPDATE sessions
        SET ended_at = ?, exit_code = ?, updated_at = ?, synced_at = NULL
      WHERE id = ?`,
  ).run(opts.endedAt ?? nowIso(), opts.exitCode ?? null, nowIso(), sessionId);
}

/**
 * Ensures a session row exists before a tool call references it.
 *
 * Hooks can fire without a SessionStart ever reaching us - the agent may
 * have been running before AgentObs was installed, or a SessionStart hook
 * may not be configured. Dropping those tool calls would silently lose data,
 * so we synthesise the parent session instead.
 */
export function ensureSession(db: DatabaseSync, sessionId: string, agentName: string, cwd?: string | null): void {
  const exists = db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId);
  if (!exists) startSession(db, { id: sessionId, agentName, cwd });
}

export interface RecordToolCallInput {
  id?: string;
  sessionId: string;
  toolName: string;
  input?: unknown;
  status?: ToolStatus;
  startedAt?: string;
  model?: string | null;
}

/** Inserts a `pending` tool call at PreToolUse time. Returns its id. */
export function beginToolCall(db: DatabaseSync, input: RecordToolCallInput): string {
  const id = input.id ?? randomUUID();
  const ts = input.startedAt ?? nowIso();
  const summary = redact(input.input);
  db.prepare(
    `INSERT INTO tool_calls (id, session_id, tool_name, started_at, status, input_summary, model, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(
    id,
    input.sessionId,
    input.toolName,
    ts,
    input.status ?? 'pending',
    summary.text,
    input.model ?? null,
    ts,
  );
  return id;
}

export interface CompleteToolCallInput {
  output?: unknown;
  status: ToolStatus;
  tokensIn?: number | null;
  tokensOut?: number | null;
  model?: string | null;
  errorMessage?: string | null;
  endedAt?: string;
}

/** Finalises a tool call at PostToolUse time, computing duration and cost. */
export function completeToolCall(
  db: DatabaseSync,
  toolCallId: string,
  input: CompleteToolCallInput,
): void {
  const row = db
    .prepare('SELECT started_at, session_id, model FROM tool_calls WHERE id = ?')
    .get(toolCallId) as { started_at: string; session_id: string; model: string | null } | undefined;
  if (!row) return;

  const endedAt = input.endedAt ?? nowIso();
  const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(row.started_at));
  const model = input.model ?? row.model;
  const cost = computeCost(model, input.tokensIn, input.tokensOut);
  const summary = redact(input.output);

  db.prepare(
    `UPDATE tool_calls
        SET ended_at = ?, duration_ms = ?, status = ?, output_summary = ?,
            tokens_in = ?, tokens_out = ?, cost_usd = ?, model = ?,
            error_message = ?, updated_at = ?, synced_at = NULL
      WHERE id = ?`,
  ).run(
    endedAt,
    durationMs,
    input.status,
    summary.text,
    input.tokensIn ?? null,
    input.tokensOut ?? null,
    cost,
    model,
    input.errorMessage ? redact(input.errorMessage, 300).text : null,
    nowIso(),
    toolCallId,
  );

  rollUpSession(db, row.session_id);
}

/**
 * Recomputes a session's aggregates from its tool calls.
 *
 * Deliberately a full re-aggregation rather than incremental counters: a
 * hook that fires twice, or a crash between insert and update, would drift
 * an incremental counter permanently, and these totals are what the whole
 * dashboard reports. Cost is SUM over known-model rows only, so an unknown
 * model leaves the total honest rather than silently under-reporting.
 */
export function rollUpSession(db: DatabaseSync, sessionId: string): void {
  db.prepare(
    `UPDATE sessions SET
        tool_call_count  = (SELECT COUNT(*) FROM tool_calls WHERE session_id = ?),
        error_count      = (SELECT COUNT(*) FROM tool_calls WHERE session_id = ? AND status = 'error'),
        blocked_count    = (SELECT COUNT(*) FROM tool_calls WHERE session_id = ? AND status = 'blocked'),
        total_tokens_in  = (SELECT COALESCE(SUM(tokens_in), 0) FROM tool_calls WHERE session_id = ?),
        total_tokens_out = (SELECT COALESCE(SUM(tokens_out), 0) FROM tool_calls WHERE session_id = ?),
        total_cost_usd   = (SELECT SUM(cost_usd) FROM tool_calls WHERE session_id = ?),
        updated_at       = ?,
        synced_at        = NULL
      WHERE id = ?`,
  ).run(sessionId, sessionId, sessionId, sessionId, sessionId, sessionId, nowIso(), sessionId);
}

/** Records a policy decision - the audit trail behind every block. */
export function recordPolicyDecision(
  db: DatabaseSync,
  input: {
    toolCallId?: string | null;
    sessionId?: string | null;
    toolName?: string | null;
    ruleMatched?: string | null;
    decision: 'allow' | 'block' | 'needs_approval';
    reason?: string | null;
  },
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO policy_decisions (id, tool_call_id, session_id, tool_name, rule_matched, decision, reason, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.toolCallId ?? null,
    input.sessionId ?? null,
    input.toolName ?? null,
    input.ruleMatched ?? null,
    input.decision,
    input.reason ?? null,
    nowIso(),
  );
  return id;
}
