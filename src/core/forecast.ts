/**
 * Burn-rate forecasting: how long until a limit is hit.
 *
 * Every other tool in this space reports what already happened. A forecast is
 * the one thing a read-only tool cannot give you, because it needs the limit
 * as well as the usage - and it is what people actually want at 2am when the
 * question is "can I finish this refactor before I get locked out".
 *
 * Deliberately conservative about what it claims. A rate computed from three
 * minutes of activity is noise, so short or sparse windows return a null
 * projection rather than a confident-looking number, and every result carries
 * its own confidence so the UI can hedge honestly.
 */
import type { DatabaseSync } from 'node:sqlite';
import { periodBounds, type BudgetStatus } from './budget.js';

export interface Forecast {
  /** Tokens (or USD) consumed per hour over the sample window. */
  ratePerHour: number;
  /** Minutes until the limit is reached, or null when not projectable. */
  minutesToLimit: number | null;
  /** Minutes left in the current period. */
  minutesRemaining: number;
  /**
   * True when the limit is projected to arrive before the period resets -
   * the case actually worth warning about.
   */
  willExceed: boolean;
  /** Projected total by the end of the period. */
  projectedTotal: number;
  confidence: 'high' | 'low' | 'none';
  /** Why confidence is low or none, for the UI to show instead of a number. */
  note: string | null;
}

/** Minimum sample before a rate means anything. */
const MIN_SAMPLE_MINUTES = 10;
/** Minimum data points before a rate means anything. */
const MIN_SAMPLES = 3;

/**
 * Projects when a budget will be reached at the current burn rate.
 *
 * The rate comes from activity *within the current period only*: usage from a
 * previous window says nothing about this one, and including it would smear a
 * quiet night into a busy morning.
 */
export function forecastBudget(db: DatabaseSync, status: BudgetStatus): Forecast {
  const periodStartMs = Date.parse(status.periodStart);
  const now = Date.now();
  const elapsedMinutes = (now - periodStartMs) / 60000;
  const periodMinutes = periodLengthMinutes(status.budget.period);
  const minutesRemaining = Math.max(0, periodMinutes - elapsedMinutes);

  const empty: Forecast = {
    ratePerHour: 0,
    minutesToLimit: null,
    minutesRemaining,
    willExceed: false,
    projectedTotal: status.spent,
    confidence: 'none',
    note: null,
  };

  if (status.limit <= 0) return empty;
  if (status.exceeded) {
    return { ...empty, projectedTotal: status.spent, note: 'Limit already reached.' };
  }

  // Sample the RECENT window, not the whole period. Someone who worked for
  // 40 minutes and then idled for four hours still has a burn rate of "what
  // they burn while working" - averaging over the idle time dilutes it by 7x
  // and quietly under-warns exactly the person who is actively working.
  const RECENT_WINDOW_MIN = 60;
  const recentStartMs = Math.max(periodStartMs, now - RECENT_WINDOW_MIN * 60000);
  const recentStart = new Date(recentStartMs).toISOString();

  const recent = db
    .prepare(
      `SELECT COUNT(*) AS n,
              MIN(tc.started_at) AS first_at,
              MAX(tc.started_at) AS last_at,
              COALESCE(SUM(COALESCE(tc.tokens_in,0) + COALESCE(tc.tokens_out,0)), 0) AS tokens,
              COALESCE(SUM(tc.cost_usd), 0) AS cost
         FROM tool_calls tc
         JOIN sessions s ON s.id = tc.session_id
        WHERE tc.started_at >= ?
          AND (? IS NULL OR s.cwd LIKE ? || '%')`,
    )
    .get(recentStart, status.budget.scope ?? null, status.budget.scope ?? '') as {
    n: number;
    first_at: string | null;
    last_at: string | null;
    tokens: number;
    cost: number;
  };

  if (elapsedMinutes < MIN_SAMPLE_MINUTES) {
    return { ...empty, note: `Only ${Math.round(elapsedMinutes)} min into this period.` };
  }
  if (recent.n < MIN_SAMPLES || !recent.first_at) {
    return { ...empty, note: `Only ${recent.n} call(s) in the last hour.` };
  }

  // Span of actual activity, floored so a burst of calls in one second does
  // not divide by ~zero and project an infinite rate.
  const activeMinutes = Math.max(
    MIN_SAMPLE_MINUTES,
    (Date.parse(recent.last_at ?? recent.first_at) - Date.parse(recent.first_at)) / 60000,
  );
  const recentUsage = status.unit === 'tokens' ? Number(recent.tokens) : Number(recent.cost);
  const ratePerHour = (recentUsage / activeMinutes) * 60;
  const samples = { n: recent.n };

  const remainingAllowance = status.limit - status.spent;
  const minutesToLimit = (remainingAllowance / ratePerHour) * 60;
  const projectedTotal = status.spent + (ratePerHour / 60) * minutesRemaining;

  return {
    ratePerHour,
    minutesToLimit,
    minutesRemaining,
    willExceed: minutesToLimit < minutesRemaining,
    projectedTotal,
    // A short window can still swing wildly, so say so rather than implying
    // the projection is firmer than the data supports.
    confidence: activeMinutes >= 20 && samples.n >= 8 ? 'high' : 'low',
    note:
      activeMinutes < 20 || samples.n < 8
        ? `Rate from ${Math.round(activeMinutes)} min of activity - it may still swing.`
        : null,
  };
}

function periodLengthMinutes(period: string): number {
  switch (period) {
    case 'block5h':
      return 5 * 60;
    case 'daily':
      return 24 * 60;
    case 'weekly':
      return 7 * 24 * 60;
    default:
      return 30 * 24 * 60;
  }
}

/** "22 min" / "3h 10m" / "2 days" - a duration a human can act on. */
export function humanDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0) return '—';
  if (minutes < 1) return 'under a minute';
  if (minutes < 90) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 36) {
    const h = Math.floor(hours);
    const m = Math.round(minutes - h * 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  return `${Math.round(hours / 24)} days`;
}

/** Wall-clock time a limit is projected to be reached. */
export function projectedTime(minutesToLimit: number): string {
  return new Date(Date.now() + minutesToLimit * 60000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}
