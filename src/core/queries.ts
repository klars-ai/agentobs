/**
 * Read-side queries backing the dashboard API.
 *
 * All time filtering compares ISO-8601 strings, which is safe because every
 * timestamp is stored as UTC ISO-8601 - for that format lexicographic order
 * is chronological order.
 */
import type { DatabaseSync } from 'node:sqlite';

/**
 * A reporting window.
 *
 * The named ranges cover the common cases; `${n}m` covers "what has happened
 * in the last few minutes", which is the question someone asks while a run is
 * actually in progress and no calendar-based range can answer.
 */
export type Range = 'today' | '7d' | '30d' | 'all' | `${number}m`;

/** Human label for a range, used wherever one is printed or shown. */
export function rangeLabel(range: Range): string {
  const minutes = rangeMinutes(range);
  if (minutes !== null) {
    if (minutes < 60) return `Last ${minutes} min`;
    const hours = minutes / 60;
    return `Last ${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
  }
  const named: Record<string, string> = {
    today: 'Today',
    '7d': 'This week',
    '30d': 'This month',
    all: 'All time',
  };
  return named[range] ?? range;
}

/** Minutes in a `<n>m` range, or null when this is a named range. */
export function rangeMinutes(range: Range): number | null {
  const m = /^(\d+)m$/.exec(range);
  if (!m) return null;
  const minutes = Number(m[1]);
  // Bounded: a negative or absurd window is a caller bug, and silently
  // returning everything would look like the filter simply did nothing.
  return Number.isFinite(minutes) && minutes > 0 && minutes <= 60 * 24 * 7 ? minutes : null;
}

/** Start of a range as an ISO string, or null for "all". */
/**
 * An explicit date window, which beats a fixed range when investigating
 * something specific - "what did last Tuesday cost".
 */
export interface DateWindow {
  since?: string | null;
  until?: string | null;
}

/** Parses YYYY-MM-DD or an ISO timestamp into an ISO string. */
export function parseDate(value: string | undefined, endOfDay = false): string | null {
  if (!value) return null;
  const bare = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const d = new Date(bare ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}` : value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function rangeStart(range: Range): string | null {
  const now = new Date();

  const minutes = rangeMinutes(range);
  if (minutes !== null) return new Date(now.getTime() - minutes * 60_000).toISOString();

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
  /**
   * How many sessions in this window are coarse (process-wrap: duration and
   * exit code only). Surfaced so the UI can explain a zero tool-call count
   * instead of leaving it looking like a broken install - the single most
   * confusing thing a new user sees.
   */
  coarse_sessions: number;
  rich_sessions: number;
  /**
   * The immediately preceding window of the same length, so the UI can show a
   * delta. Null for range 'all', which has no "previous" to compare against -
   * a delta there would be meaningless rather than merely unknown.
   */
  previous: PeriodTotals | null;
}

export interface PeriodTotals {
  total_cost_usd: number | null;
  tool_calls: number;
  sessions: number;
  errors: number;
  error_rate: number;
}

/**
 * Totals for an explicit window. Used for the previous-period comparison;
 * `getSummary` handles the current window itself.
 */
function periodTotals(db: DatabaseSync, from: string, to: string): PeriodTotals {
  const calls = db
    .prepare(
      `SELECT COUNT(*) AS tool_calls,
              COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS errors,
              SUM(cost_usd) AS total_cost_usd
         FROM tool_calls
        WHERE started_at >= ? AND started_at < ?`,
    )
    .get(from, to) as Record<string, number | null>;
  const sessions = db
    .prepare('SELECT COUNT(*) AS n FROM sessions WHERE started_at >= ? AND started_at < ?')
    .get(from, to) as { n: number };

  const toolCalls = Number(calls.tool_calls ?? 0);
  const errors = Number(calls.errors ?? 0);
  return {
    total_cost_usd: calls.total_cost_usd === null ? null : Number(calls.total_cost_usd),
    tool_calls: toolCalls,
    sessions: Number(sessions.n ?? 0),
    errors,
    error_rate: toolCalls === 0 ? 0 : errors / toolCalls,
  };
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

  // Session-level totals. Transcript imports record tokens per session (usage
  // is reported per assistant message, not per tool call), so summing the
  // per-call columns alone would report a fully-imported session as zero.
  const sessionTotals = db
    .prepare(
      `SELECT COALESCE(SUM(total_tokens_in), 0) AS tokens_in,
              COALESCE(SUM(total_tokens_out), 0) AS tokens_out,
              SUM(total_cost_usd) AS cost
         FROM sessions ${where}`,
    )
    .get(...args) as Record<string, number | null>;

  const byFidelity = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN fidelity = 'coarse' THEN 1 ELSE 0 END), 0) AS coarse,
         COALESCE(SUM(CASE WHEN fidelity <> 'coarse' THEN 1 ELSE 0 END), 0) AS rich
       FROM sessions ${where}`,
    )
    .get(...args) as { coarse: number; rich: number };

  const toolCalls = Number(calls.tool_calls ?? 0);
  const errors = Number(calls.errors ?? 0);

  return {
    range,
    since,
    total_cost_usd:
      calls.total_cost_usd === null && sessionTotals.cost === null
        ? null
        : Math.max(Number(calls.total_cost_usd ?? 0), Number(sessionTotals.cost ?? 0)),
    uncosted_calls: Number(calls.uncosted_calls ?? 0),
    tool_calls: toolCalls,
    sessions: Number(sessions.n ?? 0),
    errors,
    blocked: Number(calls.blocked ?? 0),
    error_rate: toolCalls === 0 ? 0 : errors / toolCalls,
    // Prefer whichever source actually has data: hook/JSONL data lands on the
    // tool-call rows, transcript imports on the session rows.
    tokens_in: Math.max(Number(calls.tokens_in ?? 0), Number(sessionTotals.tokens_in ?? 0)),
    tokens_out: Math.max(Number(calls.tokens_out ?? 0), Number(sessionTotals.tokens_out ?? 0)),
    avg_duration_ms: calls.avg_duration_ms === null ? null : Number(calls.avg_duration_ms),
    coarse_sessions: Number(byFidelity.coarse ?? 0),
    rich_sessions: Number(byFidelity.rich ?? 0),
    previous: previousPeriod(db, range, since),
  };
}

/**
 * Totals for the window immediately before the current one, of equal length.
 * Returns null for 'all', where there is no previous period to compare to.
 */
function previousPeriod(db: DatabaseSync, range: Range, since: string | null): PeriodTotals | null {
  if (!since) return null;
  const start = Date.parse(since);
  const spanMs = range === 'today' ? 864e5 : range === '7d' ? 7 * 864e5 : 30 * 864e5;
  return periodTotals(db, new Date(start - spanMs).toISOString(), since);
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

/**
 * Compact per-bucket series for the stat-tile sparklines.
 *
 * Returns a fixed 12 buckets (the stat-tile contract's trend length),
 * zero-filled so a quiet day renders as a gap in the line rather than
 * silently shortening the series and misstating the shape.
 */
export function getSparklines(
  db: DatabaseSync,
  range: Range,
): { calls: number[]; cost: number[]; errors: number[]; sessions: number[]; blocked: number[] } {
  const POINTS = 12;
  const spanMs = range === 'today' ? 864e5 : range === '7d' ? 7 * 864e5 : 30 * 864e5;
  const end = Date.now();
  const start = range === 'all' ? null : end - spanMs;
  const bucketMs = (start ? spanMs : 30 * 864e5) / POINTS;
  const origin = start ?? end - 30 * 864e5;

  const rows = db
    .prepare(
      `SELECT started_at, status, cost_usd, session_id
         FROM tool_calls
        WHERE started_at >= ?`,
    )
    .all(new Date(origin).toISOString()) as unknown as Array<{
    started_at: string;
    status: string;
    cost_usd: number | null;
    session_id: string;
  }>;

  const calls = new Array(POINTS).fill(0);
  const cost = new Array(POINTS).fill(0);
  const errors = new Array(POINTS).fill(0);
  const blocked = new Array(POINTS).fill(0);
  const sessionSets: Array<Set<string>> = Array.from({ length: POINTS }, () => new Set());

  for (const row of rows) {
    const i = Math.min(POINTS - 1, Math.floor((Date.parse(row.started_at) - origin) / bucketMs));
    if (i < 0) continue;
    calls[i] += 1;
    cost[i] += row.cost_usd ?? 0;
    if (row.status === 'error') errors[i] += 1;
    if (row.status === 'blocked') blocked[i] += 1;
    sessionSets[i].add(row.session_id);
  }

  return { calls, cost, errors, blocked, sessions: sessionSets.map((s) => s.size) };
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


export interface DailyRow {
  /** Local calendar date, YYYY-MM-DD. */
  day: string;
  calls: number;
  errors: number;
  blocked: number;
  sessions: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number | null;
  /** Calls whose model had no price, so the cost is a floor rather than a total. */
  uncosted_calls: number;
}

/**
 * Day-by-day totals.
 *
 * Built from tool_calls rather than sessions on purpose. A session's totals are
 * stamped with its start date, so a run that began on the 25th and continued
 * to the 29th would put five days of work onto one row - which is exactly the
 * shape that makes a daily chart useless. Tool calls carry their own
 * timestamps and land on the day they actually happened.
 *
 * Dates are grouped in local time, because a user comparing this against their
 * own memory of Tuesday means their Tuesday, not UTC's.
 */
export function getDaily(db: DatabaseSync, range: Range): DailyRow[] {
  const since = rangeStart(range);
  const where = since ? 'WHERE started_at >= ?' : '';
  const args = since ? [since] : [];

  const calls = db
    .prepare(
      `SELECT date(started_at, 'localtime') AS day,
              COUNT(*) AS calls,
              COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS errors,
              COALESCE(SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END), 0) AS blocked,
              COALESCE(SUM(COALESCE(tokens_in, 0)), 0) AS tokens_in,
              COALESCE(SUM(COALESCE(tokens_out, 0)), 0) AS tokens_out,
              SUM(cost_usd) AS cost_usd,
              COALESCE(SUM(CASE WHEN cost_usd IS NULL AND status <> 'pending' THEN 1 ELSE 0 END), 0)
                AS uncosted_calls
         FROM tool_calls ${where}
        GROUP BY day`,
    )
    .all(...args) as unknown as Array<Omit<DailyRow, 'sessions'>>;

  // Sessions are counted by their own start date: "how many runs did I begin
  // that day" is the question a reader is actually asking of this column.
  const sessions = db
    .prepare(
      `SELECT date(started_at, 'localtime') AS day, COUNT(*) AS n
         FROM sessions ${where}
        GROUP BY day`,
    )
    .all(...args) as unknown as Array<{ day: string; n: number }>;

  const sessionsByDay = new Map(sessions.map((r) => [r.day, r.n]));
  const byDay = new Map(calls.map((r) => [r.day, r]));

  // Fill the gaps. A day with no activity is information - an absent row makes
  // a chart silently compress time and read as if work were continuous.
  const out: DailyRow[] = [];
  const days = new Set<string>([...byDay.keys(), ...sessionsByDay.keys()]);
  if (since) {
    const start = new Date(since);
    for (let d = new Date(start); d <= new Date(); d.setDate(d.getDate() + 1)) {
      days.add(localDay(d));
    }
  }

  for (const day of [...days].sort()) {
    const row = byDay.get(day);
    out.push({
      day,
      calls: Number(row?.calls ?? 0),
      errors: Number(row?.errors ?? 0),
      blocked: Number(row?.blocked ?? 0),
      sessions: Number(sessionsByDay.get(day) ?? 0),
      tokens_in: Number(row?.tokens_in ?? 0),
      tokens_out: Number(row?.tokens_out ?? 0),
      cost_usd: row?.cost_usd == null ? null : Number(row.cost_usd),
      uncosted_calls: Number(row?.uncosted_calls ?? 0),
    });
  }

  return out;
}

/** YYYY-MM-DD in local time, matching SQLite's date(..., 'localtime'). */
function localDay(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
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

export interface ProjectRow {
  project: string;
  cwd: string;
  sessions: number;
  tool_calls: number;
  errors: number;
  cost_usd: number | null;
  tokens: number;
  last_seen: string;
}

/**
 * Spend grouped by working directory - "which repo is burning my budget".
 *
 * cwd is already recorded per session, so this needs no new data; the display
 * name is the last path segment, since a full absolute path is unreadable in
 * a table and often identical up to the final directory.
 */
export function getProjects(db: DatabaseSync, range: Range): ProjectRow[] {
  const since = rangeStart(range);
  const where = since ? 'WHERE s.started_at >= ?' : '';
  const args = since ? [since] : [];

  const rows = db
    .prepare(
      `SELECT COALESCE(s.cwd, '(unknown)') AS cwd,
              COUNT(DISTINCT s.id) AS sessions,
              COALESCE(SUM(s.tool_call_count), 0) AS tool_calls,
              COALESCE(SUM(s.error_count), 0) AS errors,
              SUM(s.total_cost_usd) AS cost_usd,
              COALESCE(SUM(s.total_tokens_in + s.total_tokens_out), 0) AS tokens,
              MAX(s.started_at) AS last_seen
         FROM sessions s
         ${where}
        GROUP BY COALESCE(s.cwd, '(unknown)')`,
    )
    .all(...args) as unknown as Array<Omit<ProjectRow, 'project'>>;

  // Merge paths that differ only by case or separator. Windows reports the
  // same directory as both "i:\AgentObs" and "I:/AgentObs" depending on how
  // the process was launched, which otherwise splits one project into several
  // rows and makes the cost share meaningless.
  const merged = new Map<string, ProjectRow>();
  for (const r of rows) {
    const key = r.cwd.replace(/[\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
    const existing = merged.get(key);
    if (existing) {
      existing.sessions += r.sessions;
      existing.tool_calls += r.tool_calls;
      existing.errors += r.errors;
      existing.tokens += r.tokens;
      if (r.cost_usd !== null) existing.cost_usd = (existing.cost_usd ?? 0) + r.cost_usd;
      if (r.last_seen > existing.last_seen) existing.last_seen = r.last_seen;
    } else {
      merged.set(key, {
        ...r,
        project: r.cwd.replace(/[\/]+$/, '').split(/[\/]/).pop() || r.cwd,
      });
    }
  }

  return [...merged.values()].sort(
    (a, b) => (b.cost_usd ?? -1) - (a.cost_usd ?? -1) || b.tool_calls - a.tool_calls,
  );
}

export interface SessionDetail {
  session: SessionRow | undefined;
  calls: ToolCallRow[];
}

/** One session and its tool calls in order - the "what happened here?" view. */
export function getSessionDetail(db: DatabaseSync, sessionId: string): SessionDetail {
  const session = db
    .prepare(
      `SELECT id, agent_name, started_at, ended_at, cwd, fidelity, tool_call_count,
              error_count, blocked_count, total_cost_usd, total_tokens_in,
              total_tokens_out, exit_code
         FROM sessions WHERE id = ?`,
    )
    .get(sessionId) as unknown as SessionRow | undefined;

  const calls = db
    .prepare(
      `SELECT tc.id, tc.session_id, s.agent_name, tc.tool_name, tc.started_at,
              tc.duration_ms, tc.status, tc.input_summary, tc.output_summary,
              tc.cost_usd, tc.error_message,
              (SELECT pd.rule_matched FROM policy_decisions pd
                WHERE pd.tool_call_id = tc.id
                ORDER BY pd.decided_at DESC LIMIT 1) AS rule_matched
         FROM tool_calls tc
         LEFT JOIN sessions s ON s.id = tc.session_id
        WHERE tc.session_id = ?
        ORDER BY tc.started_at ASC`,
    )
    .all(sessionId) as unknown as ToolCallRow[];

  return { session, calls };
}

export interface ModelRow {
  model: string;
  calls: number;
  tokens: number;
  cost_usd: number | null;
}

/**
 * Spend grouped by model - "which model is actually costing me".
 *
 * Falls back to session-level tokens when the per-call columns are null,
 * which is the case for transcript imports (usage is reported per assistant
 * message, not per tool call).
 */
export function getModels(db: DatabaseSync, range: Range): ModelRow[] {
  const since = rangeStart(range);
  const args = since ? [since, since] : [];
  const callWhere = since ? 'WHERE started_at >= ? AND model IS NOT NULL' : 'WHERE model IS NOT NULL';
  const sessWhere = since
    ? 'WHERE s.started_at >= ? AND tc.id IS NULL'
    : 'WHERE tc.id IS NULL';

  // Per-call rows carry a model for hook/JSONL data. Transcript imports leave
  // it null there and record it on the session instead, so a call-only query
  // returned nothing at all for imported history - the common case.
  const rows = db
    .prepare(
      `SELECT model,
              COUNT(*) AS calls,
              COALESCE(SUM(COALESCE(tokens_in,0) + COALESCE(tokens_out,0)), 0) AS tokens,
              SUM(cost_usd) AS cost_usd
         FROM tool_calls ${callWhere}
        GROUP BY model`,
    )
    .all(...(since ? [since] : [])) as unknown as ModelRow[];

  // Sessions whose calls have no model of their own.
  const sessionRows = db
    .prepare(
      `SELECT COALESCE(s.model_hint, 'unknown') AS model,
              COUNT(DISTINCT s.id) AS calls,
              COALESCE(SUM(s.total_tokens_in + s.total_tokens_out), 0) AS tokens,
              SUM(s.total_cost_usd) AS cost_usd
         FROM sessions s
         LEFT JOIN tool_calls tc ON tc.session_id = s.id AND tc.model IS NOT NULL
         ${sessWhere}
        GROUP BY COALESCE(s.model_hint, 'unknown')`,
    )
    .all(...(since ? [since] : [])) as unknown as ModelRow[];

  const merged = new Map<string, ModelRow>();
  for (const r of [...rows, ...sessionRows]) {
    if (!r.model) continue;
    const existing = merged.get(r.model);
    if (existing) {
      existing.calls += r.calls;
      existing.tokens += r.tokens;
      if (r.cost_usd !== null) existing.cost_usd = (existing.cost_usd ?? 0) + r.cost_usd;
    } else {
      merged.set(r.model, { ...r });
    }
  }

  return [...merged.values()].sort(
    (a, b) => (b.cost_usd ?? -1) - (a.cost_usd ?? -1) || b.tokens - a.tokens,
  );
}
