/**
 * `agentobs budget` - spend limits.
 */
import { openDb } from '../core/db.js';
import {
  checkBudgets,
  listBudgets,
  removeBudget,
  setBudget,
  type BudgetAction,
  type BudgetPeriod,
} from '../core/budget.js';

const money = (v: number): string => `$${v.toFixed(2)}`;

/** A 20-cell bar. Text, so it works in any terminal without colour support. */
function bar(ratio: number, width = 20): string {
  const filled = Math.min(width, Math.max(0, Math.round(ratio * width)));
  return `[${'#'.repeat(filled)}${'.'.repeat(width - filled)}]`;
}

export interface BudgetSetOptions {
  daily?: string;
  weekly?: string;
  monthly?: string;
  block?: boolean;
  scope?: string;
}

export async function budgetSet(opts: BudgetSetOptions): Promise<void> {
  const periods: Array<[BudgetPeriod, string | undefined]> = [
    ['daily', opts.daily],
    ['weekly', opts.weekly],
    ['monthly', opts.monthly],
  ];
  const chosen = periods.filter(([, v]) => v !== undefined);

  if (chosen.length === 0) {
    console.error(`No limit given.

  Usage:  agentobs budget set --daily 5
          agentobs budget set --monthly 100 --block
          agentobs budget set --daily 2 --scope /path/to/project

  --block refuses further tool calls once the limit is crossed; without
  it the limit only warns. Blocking needs the PreToolUse hook, since
  that is the only point where a call can be stopped before it runs.`);
    process.exitCode = 2;
    return;
  }

  const db = openDb();
  const action: BudgetAction = opts.block ? 'block' : 'warn';

  for (const [period, raw] of chosen) {
    const limit = Number(raw);
    if (!Number.isFinite(limit) || limit <= 0) {
      console.error(`Invalid ${period} limit: ${raw}`);
      process.exitCode = 2;
      return;
    }
    const b = setBudget(db, { period, limitUsd: limit, action, scope: opts.scope ?? null });
    console.log(
      `  ${period.padEnd(8)} ${money(b.limit_usd).padStart(9)}  ${b.action}` +
        (b.scope ? `  scope: ${b.scope}` : ''),
    );
  }

  console.log('\nRun "agentobs budget" to see current spend against these limits.');
}

export async function budgetStatus(): Promise<void> {
  const db = openDb();
  const budgets = listBudgets(db);

  if (budgets.length === 0) {
    console.log(`No budgets set.

  agentobs budget set --daily 5        warn when today passes $5
  agentobs budget set --monthly 100 --block   stop at $100 this month

Budgets are the spend equivalent of the policy guardrails: instead of
finding out after the fact, you get told - or stopped - at the limit.`);
    return;
  }

  // record:false - reporting status must not consume the one-shot alert that
  // the hook path relies on to warn exactly once per period.
  const statuses = checkBudgets(db, { record: false });

  console.log('\n  Budget      Spent      Limit   Used  Action\n  ' + '-'.repeat(56));
  for (const s of statuses) {
    const pct = `${Math.round(s.ratio * 100)}%`.padStart(5);
    const flag = s.exceeded ? (s.budget.action === 'block' ? ' OVER (blocking)' : ' OVER') : '';
    console.log(
      `  ${s.budget.period.padEnd(9)} ${money(s.spent).padStart(9)} ${money(s.limit).padStart(10)} ` +
        `${pct}  ${s.budget.action}${flag}`,
    );
    console.log(`  ${bar(s.ratio)}${s.budget.scope ? `  ${s.budget.scope}` : ''}`);
  }
  console.log('');
}

export async function budgetRemove(id: string): Promise<void> {
  const db = openDb();
  // Accept an id prefix: the full UUID is tedious to type, and `budget`
  // prints only the period, so a user has to look the id up somehow.
  const match = listBudgets(db).find((b) => b.id === id || b.id.startsWith(id) || b.period === id);
  if (!match) {
    console.error(`No budget matching "${id}". Run "agentobs budget" to list them.`);
    process.exitCode = 1;
    return;
  }
  removeBudget(db, match.id);
  console.log(`Removed the ${match.period} budget (${money(match.limit_usd)}).`);
}
