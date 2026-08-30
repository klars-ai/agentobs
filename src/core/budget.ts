/**
 * Budget limits - spend guardrails.
 *
 * The policy engine blocks dangerous *commands*; this blocks dangerous
 * *spending*. Same idea, applied to money: an agent that quietly burns $400
 * overnight is a real failure mode, and a dashboard you have to remember to
 * open does not prevent it.
 *
 * Evaluated on the PreToolUse hook path, so it has to stay cheap: the spend
 * query is a single indexed SUM, and a crossed threshold is recorded once per
 * period so a warning does not repeat on every subsequent call.
 */
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

/**
 * 'block5h' tracks Claude's rolling five-hour session window, and 'weekly'
 * its weekly cap. Most Claude Code users are on a subscription, so the real
 * constraint is not dollars - it is being locked out mid-task. Those users
 * want to know "how much of my window is left", which a USD budget cannot
 * express.
 */
export type BudgetPeriod = 'daily' | 'weekly' | 'monthly' | 'block5h';
export type BudgetAction = 'warn' | 'block';

export interface Budget {
  id: string;
  period: BudgetPeriod;
  /** Null when the budget is denominated in tokens instead. */
  limit_usd: number | null;
  limit_tokens: number | null;
  action: BudgetAction;
  /** Null applies the budget everywhere; otherwise a cwd prefix. */
  scope: string | null;
  created_at: string;
  updated_at: string;
}

export interface BudgetStatus {
  budget: Budget;
  /** Spend in the budget's own unit - USD or tokens. */
  spent: number;
  limit: number;
  /** Which unit `spent` and `limit` are in, so the UI formats correctly. */
  unit: 'usd' | 'tokens';
  /** 0-1+; can exceed 1 when over budget. */
  ratio: number;
  periodKey: string;
  periodStart: string;
  exceeded: boolean;
  /** True the first time this period crosses the limit - drives one-shot alerts. */
  newlyExceeded: boolean;
}

/**
 * Start of the current period, and a stable key identifying it.
 *
 * The key is what makes alerts one-shot: a UNIQUE index on
 * (budget_id, period_key) means the second insert for the same day simply
 * fails, so no bookkeeping is needed to avoid repeat warnings.
 */
export function periodBounds(
  period: BudgetPeriod,
  now = new Date(),
): { start: string; key: string } {
  const d = new Date(now);

  if (period === 'daily') {
    d.setHours(0, 0, 0, 0);
    return { start: d.toISOString(), key: `D${localDate(d)}` };
  }

  if (period === 'block5h') {
    // Anthropic's session window is a rolling 5 hours anchored to first use,
    // but the anchor is not exposed anywhere we can read. Fixed 5-hour blocks
    // from midnight are a deliberate approximation: it tracks the right
    // quantity at the right cadence without pretending to know the true
    // anchor. The key changes every block, so alerts re-arm correctly.
    const blockIndex = Math.floor(d.getHours() / 5);
    d.setHours(blockIndex * 5, 0, 0, 0);
    return { start: d.toISOString(), key: `B${localDate(d)}-${blockIndex}` };
  }

  if (period === 'weekly') {
    // Week starts Monday; getDay() returns 0 for Sunday, hence the shift.
    const day = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - day);
    d.setHours(0, 0, 0, 0);
    return { start: d.toISOString(), key: `W${localDate(d)}` };
  }

  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return { start: d.toISOString(), key: `M${localDate(d).slice(0, 7)}` };
}

/**
 * Local calendar date as YYYY-MM-DD.
 *
 * Deliberately not toISOString().slice(0,10): the boundary is local midnight,
 * but toISOString converts back to UTC, so east of Greenwich the key lands on
 * the previous day. A user's "daily budget" means their day, not UTC's.
 */
function localDate(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function listBudgets(db: DatabaseSync): Budget[] {
  return db
    .prepare('SELECT * FROM budgets ORDER BY period, limit_usd')
    .all() as unknown as Budget[];
}

export function setBudget(
  db: DatabaseSync,
  input: {
    period: BudgetPeriod;
    limitUsd?: number;
    limitTokens?: number;
    action?: BudgetAction;
    scope?: string | null;
  },
): Budget {
  const now = new Date().toISOString();
  // One budget per (period, scope): setting a daily limit twice updates it
  // rather than silently stacking two limits that both fire.
  // IFNULL on both sides so a null scope matches a null scope; a plain
  // `scope = ?` would never match, since NULL = NULL is not true in SQL.
  const existing = db
    .prepare("SELECT id FROM budgets WHERE period = ? AND IFNULL(scope, '') = IFNULL(?, '')")
    .get(input.period, input.scope ?? null) as { id: string } | undefined;

  const id = existing?.id ?? randomUUID();
  if (existing) {
    db.prepare(
      'UPDATE budgets SET limit_usd = ?, limit_tokens = ?, action = ?, updated_at = ? WHERE id = ?',
    ).run(input.limitUsd ?? null, input.limitTokens ?? null, input.action ?? 'warn', now, id);
  } else {
    db.prepare(
      `INSERT INTO budgets (id, period, limit_usd, limit_tokens, action, scope, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.period,
      input.limitUsd ?? null,
      input.limitTokens ?? null,
      input.action ?? 'warn',
      input.scope ?? null,
      now,
      now,
    );
  }
  return db.prepare('SELECT * FROM budgets WHERE id = ?').get(id) as unknown as Budget;
}

export function removeBudget(db: DatabaseSync, id: string): boolean {
  const before = db.prepare('SELECT COUNT(*) AS n FROM budgets WHERE id = ?').get(id) as { n: number };
  if (before.n === 0) return false;
  db.prepare('DELETE FROM budget_events WHERE budget_id = ?').run(id);
  db.prepare('DELETE FROM budgets WHERE id = ?').run(id);
  return true;
}

/** Spend since `since`, optionally limited to sessions under a cwd prefix. */
export function spendSince(db: DatabaseSync, since: string, scope?: string | null): number {
  // Sum both sources: hook/JSONL data costs per tool call, transcript imports
  // cost per session. Taking the larger avoids double-counting a session that
  // has both, while never under-reporting one that has only one.
  const callSum = db
    .prepare(
      `SELECT COALESCE(SUM(tc.cost_usd), 0) AS c
         FROM tool_calls tc
         JOIN sessions s ON s.id = tc.session_id
        WHERE tc.started_at >= ?
          AND (? IS NULL OR s.cwd LIKE ? || '%')`,
    )
    .get(since, scope ?? null, scope ?? '') as { c: number };

  const sessionSum = db
    .prepare(
      `SELECT COALESCE(SUM(total_cost_usd), 0) AS c
         FROM sessions
        WHERE started_at >= ?
          AND (? IS NULL OR cwd LIKE ? || '%')`,
    )
    .get(since, scope ?? null, scope ?? '') as { c: number };

  return Math.max(Number(callSum.c ?? 0), Number(sessionSum.c ?? 0));
}

/** Tokens consumed since `since`, optionally scoped to a cwd prefix. */
export function tokensSince(db: DatabaseSync, since: string, scope?: string | null): number {
  const callSum = db
    .prepare(
      `SELECT COALESCE(SUM(COALESCE(tc.tokens_in,0) + COALESCE(tc.tokens_out,0)), 0) AS t
         FROM tool_calls tc
         JOIN sessions s ON s.id = tc.session_id
        WHERE tc.started_at >= ?
          AND (? IS NULL OR s.cwd LIKE ? || '%')`,
    )
    .get(since, scope ?? null, scope ?? '') as { t: number };

  const sessionSum = db
    .prepare(
      `SELECT COALESCE(SUM(total_tokens_in + total_tokens_out), 0) AS t
         FROM sessions
        WHERE started_at >= ?
          AND (? IS NULL OR cwd LIKE ? || '%')`,
    )
    .get(since, scope ?? null, scope ?? '') as { t: number };

  // Same reasoning as spendSince: prefer whichever source has data rather
  // than adding them, which would double-count a session that has both.
  return Math.max(Number(callSum.t ?? 0), Number(sessionSum.t ?? 0));
}

/**
 * Evaluates every budget against current spend.
 *
 * `newlyExceeded` is set only the first time a period crosses its limit, and
 * recording that fact is what keeps a warning from firing on every subsequent
 * tool call for the rest of the day.
 */
export function checkBudgets(db: DatabaseSync, opts: { record?: boolean } = {}): BudgetStatus[] {
  const out: BudgetStatus[] = [];

  for (const budget of listBudgets(db)) {
    const { start, key } = periodBounds(budget.period);

    // A budget is denominated in either dollars or tokens; tokens exist
    // because subscription users are capped on usage, not spend.
    const isTokenBudget = budget.limit_tokens !== null && budget.limit_tokens !== undefined;
    const limit = isTokenBudget ? Number(budget.limit_tokens) : Number(budget.limit_usd ?? 0);
    const spent = isTokenBudget
      ? tokensSince(db, start, budget.scope)
      : spendSince(db, start, budget.scope);

    const exceeded = limit > 0 && spent >= limit;

    let newlyExceeded = false;
    if (exceeded && opts.record !== false) {
      try {
        db.prepare(
          `INSERT INTO budget_events (id, budget_id, period_key, spent_usd, limit_usd, action, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(randomUUID(), budget.id, key, spent, limit, budget.action, new Date().toISOString());
        newlyExceeded = true;
      } catch {
        // UNIQUE(budget_id, period_key) violation: already alerted this
        // period, which is exactly the intent.
      }
    }

    out.push({
      budget,
      spent,
      limit,
      unit: isTokenBudget ? 'tokens' : 'usd',
      ratio: limit === 0 ? 0 : spent / limit,
      periodKey: key,
      periodStart: start,
      exceeded,
      newlyExceeded,
    });
  }

  return out;
}

/** The first budget that should block, if any. */
export function blockingBudget(statuses: BudgetStatus[]): BudgetStatus | null {
  return statuses.find((s) => s.exceeded && s.budget.action === 'block') ?? null;
}

/**
 * Formats a budget figure in its own unit.
 *
 * toFixed(2) alone reported a $0.0001 limit as "$0.00", which reads as a bug
 * rather than a very small limit - and a token budget rendered as dollars
 * entirely. Small values keep enough decimals to stay recognisable.
 *
 * Shared rather than duplicated: the hook's block message, the desktop toast
 * and the webhook payload all describe the same breach, and wording that
 * disagrees between them is how a user stops trusting the numbers.
 */
export function budgetAmount(value: number, unit: 'usd' | 'tokens'): string {
  if (unit === 'tokens') {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M tokens`;
    if (value >= 1_000) return `${Math.round(value / 1_000)}K tokens`;
    return `${Math.round(value)} tokens`;
  }
  if (value > 0 && value < 0.01) return `$${value.toPrecision(2)}`;
  return `$${value.toFixed(2)}`;
}
