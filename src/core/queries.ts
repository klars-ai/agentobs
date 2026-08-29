/**
 * Read-side queries backing the dashboard API.
 *
 * All time filtering compares ISO-8601 strings, which is safe because every
 * timestamp is stored as UTC ISO-8601 - for that format lexicographic order
 * is chronological order.
 */
import type { DatabaseSync } from 'node:sqlite';

export type Range = 'today' | '7d' | '30d' | 'all';

/** Start of a range as an ISO string, or null for "all". */
export function rangeStart(range: Range): string | null {
  const now = new Date();
  switch (range) {
    case 'today': {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      return d.toISOString();
    }
    case '7d':
      return new Date(now.getTime() - 7 * 864e5).toISOString();
    case '30d':
      return new Date(now.getTime() - 30 * 864e5).toISOString();
    default:
      return null;
  }
}

export interface Summary {
  range: Range;
  since: string | null;
  total_cost_usd: number | null;
  /** Calls whose model wasn't in pricing.json, so the cost total is knowably incomplete. */
  uncosted_calls: number;
  tool_calls: number;
  sessions: number;
  errors: number;
  blocked: number;
  error_rate: number;
  tokens_in: number;
  tokens_out: number;
  avg_duration_ms: number | null;
}

export function getSummary(db: DatabaseSync, range: Range): Summary {
  const since = rangeStart(range);
  const where = since ? 'WHERE started_at >= ?' : '';
  const args = since ? [since] : [];

  const calls = db
    .prepare(
      `SELECT
         COUNT(*) AS tool_calls,
         COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS errors,
         COALESCE(SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END), 0) AS blocked,
         COALESCE(SUM(tokens_in), 0) AS tokens_in,
         COALESCE(SUM(tokens_out), 0) AS tokens_out,
         SUM(cost_usd) AS total_cost_usd,
         COALESCE(SUM(CASE WHEN cost_usd IS NULL AND status <> 'pending' THEN 1 ELSE 0 END), 0) AS uncosted_calls,
         AVG(duration_ms) AS avg_duration_ms
       FROM tool_calls ${where}`,
    )
    .get(...args) as Record<string, number | null>;

  const sessions = db.prepare(`SELECT COUNT(*) AS n FROM sessions ${where}`).get(...args) as {
    n: number;
  };

  const toolCalls = Number(calls.tool_calls ?? 0);
  const errors = Number(calls.errors ?? 0);

  return {
    range,
    since,
    total_cost_usd: calls.total_cost_usd === null ? null : Number(calls.total_cost_usd),
    uncosted_calls: Number(calls.uncosted_calls ?? 0),
    tool_calls: toolCalls,
    sessions: Number(sessions.n ?? 0),
    errors,
    blocked: Number(calls.blocked ?? 0),
    error_rate: toolCalls === 0 ? 0 : errors / toolCalls,
    tokens_in: Number(calls.tokens_in ?? 0),
    tokens_out: Number(calls.tokens_out ?? 0),
    avg_duration_ms: calls.avg_duration_ms === null ? null : Number(calls.avg_duration_ms),
  };
}

export interface TimelineBucket {
  bucket: string;
  calls: number;
  errors: number;
  cost_usd: number | null;
  tokens: number;
}

/**
 * Activity/cost over time. Buckets hourly for `today` and daily otherwise so
 * the chart keeps a readable number of points at every range.
 */
export function getTimeline(db: DatabaseSync, range: Range): TimelineBucket[] {
  const since = rangeStart(range);
  const fmt = range === 'today' ? '%Y-%m-%dT%H:00' : '%Y-%m-%d';
  const where = since ? 'WHERE started_at >= ?' : '';
  const args = since ? [since] : [];

  return db
    .prepare(
      `SELECT strftime(?, started_at) AS bucket,
              COUNT(*) AS calls,
              COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS errors,
              SUM(cost_usd) AS cost_usd,
              COALESCE(SUM(COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0)), 0) AS tokens
         FROM tool_calls ${where}
        GROUP BY bucket
        ORDER BY bucket ASC`,
    )
    .all(fmt, ...args) as unknown as TimelineBucket[];
}

export interface ToolBreakdownRow {
  tool_name: string;
  calls: number;
  errors: number;
  blocked: number;
  cost_usd: number | null;
  avg_duration_ms: number | null;
}

export function getToolsBreakdown(db: DatabaseSync, range: Range): ToolBreakdownRow[] {
  const since = rangeStart(range);
  const where = since ? 'WHERE started_at >= ?' : '';
  const args = since ? [since] : [];
  return db
    .prepare(
      `SELECT tool_name,
              COUNT(*) AS calls,
              COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS errors,
              COALESCE(SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END), 0) AS blocked,
              SUM(cost_usd) AS cost_usd,
              AVG(duration_ms) AS avg_duration_ms
         FROM tool_calls ${where}
        GROUP BY tool_name
        ORDER BY calls DESC`,
    )
    .all(...args) as unknown as ToolBreakdownRow[];
}

export interface ToolCallRow {
  id: string;
  session_id: string;
  agent_name: string | null;
  tool_name: string;
  started_at: string;
  duration_ms: number | null;
  status: string;
  input_summary: string | null;
  output_summary: string | null;
  cost_usd: number | null;
  error_message: string | null;
  rule_matched: string | null;
}

export function getRecentToolCalls(
  db: DatabaseSync,
  opts: { limit?: number; range?: Range; status?: string; sessionId?: string } = {},
): ToolCallRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const clauses: string[] = [];
  const args: (string | number)[] = [];

  const since = opts.range ? rangeStart(opts.range) : null;
  if (since) {
    clauses.push('tc.started_at >= ?');
    args.push(since);
  }
  if (opts.status) {
    clauses.push('tc.status = ?');
    args.push(opts.status);
  }
  if (opts.sessionId) {
    clauses.push('tc.session_id = ?');
    args.push(opts.sessionId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  return db
    .prepare(
      `SELECT tc.id, tc.session_id, s.agent_name, tc.tool_name, tc.started_at,
              tc.duration_ms, tc.status, tc.input_summary, tc.output_summary,
              tc.cost_usd, tc.error_message,
              (SELECT pd.rule_matched FROM policy_decisions pd
                WHERE pd.tool_call_id = tc.id
                ORDER BY pd.decided_at DESC LIMIT 1) AS rule_matched
         FROM tool_calls tc
         LEFT JOIN sessions s ON s.id = tc.session_id
         ${where}
        ORDER BY tc.started_at DESC
        LIMIT ?`,
    )
    .all(...args, limit) as unknown as ToolCallRow[];
}

export interface SessionRow {
  id: string;
  agent_name: string;
  started_at: string;
  ended_at: string | null;
  cwd: string | null;
  fidelity: string;
  tool_call_count: number;
  error_count: number;
  blocked_count: number;
  total_cost_usd: number | null;
  total_tokens_in: number;
  total_tokens_out: number;
  exit_code: number | null;
}

export function getSessions(
  db: DatabaseSync,
  opts: { limit?: number; range?: Range } = {},
): SessionRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const since = opts.range ? rangeStart(opts.range) : null;
  const where = since ? 'WHERE started_at >= ?' : '';
  const args = since ? [since] : [];
  return db
    .prepare(
      `SELECT id, agent_name, started_at, ended_at, cwd, fidelity, tool_call_count,
              error_count, blocked_count, total_cost_usd, total_tokens_in,
              total_tokens_out, exit_code
         FROM sessions ${where}
        ORDER BY started_at DESC
        LIMIT ?`,
    )
    .all(...args, limit) as unknown as SessionRow[];
}

export function getPolicyDecisions(db: DatabaseSync, opts: { limit?: number } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  return db
    .prepare(
      `SELECT id, tool_call_id, session_id, tool_name, rule_matched, decision, reason, decided_at
         FROM policy_decisions
        ORDER BY decided_at DESC
        LIMIT ?`,
    )
    .all(limit);
}
