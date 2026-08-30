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

export type BudgetPeriod = 'daily' | 'weekly' | 'monthly';
export type BudgetAction = 'warn' | 'block';

export interface Budget {
  id: string;
  period: BudgetPeriod;
  limit_usd: number;
  action: BudgetAction;
  /** Null applies the budget everywhere; otherwise a cwd prefix. */
  scope: string | null;
  created_at: string;
  updated_at: string;
}

export interface BudgetStatus {
  budget: Budget;
  spent: number;
  limit: number;
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
  input: { period: BudgetPeriod; limitUsd: number; action?: BudgetAction; scope?: string | null },
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
    db.prepare('UPDATE budgets SET limit_usd = ?, action = ?, updated_at = ? WHERE id = ?').run(
      input.limitUsd,
      input.action ?? 'warn',
      now,
      id,
    );
  } else {
    db.prepare(
      `INSERT INTO budgets (id, period, limit_usd, action, scope, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.period, input.limitUsd, input.action ?? 'warn', input.scope ?? null, now, now);
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
    const spent = spendSince(db, start, budget.scope);
    const exceeded = spent >= budget.limit_usd;

    let newlyExceeded = false;
    if (exceeded && opts.record !== false) {
      try {
        db.prepare(
          `INSERT INTO budget_events (id, budget_id, period_key, spent_usd, limit_usd, action, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          randomUUID(),
          budget.id,
          key,
          spent,
          budget.limit_usd,
          budget.action,
          new Date().toISOString(),
        );
        newlyExceeded = true;
      } catch {
        // UNIQUE(budget_id, period_key) violation: already alerted this
        // period, which is exactly the intent.
      }
    }

    out.push({
      budget,
      spent,
      limit: budget.limit_usd,
      ratio: budget.limit_usd === 0 ? 0 : spent / budget.limit_usd,
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
