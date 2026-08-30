/**
 * Optimisation hints derived from what actually happened.
 *
 * A dashboard that only reports leaves the reader to work out what to do about
 * it. This turns the same rows into specific, checkable suggestions.
 *
 * Three rules keep this from becoming noise, which is the failure mode of
 * every "insights" feature:
 *
 *  1. Every hint names the evidence. "Bash failed 100 times (3%)" is
 *     actionable; "consider reviewing your tool usage" is horoscope text.
 *  2. A hint appears only past a threshold where the advice is worth the
 *     interruption. Below it, silence is the correct output.
 *  3. Nothing is invented. If the data cannot support a claim - an unpriced
 *     model, too few samples - the hint is not emitted rather than hedged.
 *
 * Hints are ranked by estimated impact so the first one is the one worth
 * doing, and capped, because a list of twelve suggestions is a list nobody
 * reads.
 */
import type { DatabaseSync } from 'node:sqlite';
import { rangeStart, type Range } from './queries.js';
import { detectPlan } from './plan.js';

export type HintKind = 'cost' | 'reliability' | 'speed' | 'hygiene';

export interface Hint {
  kind: HintKind;
  /** One line, specific, with the number that triggered it. */
  title: string;
  /** What to do about it. */
  detail: string;
  /** Rough ordering weight; not shown, only used to rank. */
  weight: number;
}

/** Below this, a percentage is noise rather than a pattern. */
const MIN_SAMPLES = 20;

const pct = (n: number, of: number): number => (of === 0 ? 0 : (n / of) * 100);
const num = (n: number): string => Math.round(n).toLocaleString('en-US');

export function getHints(db: DatabaseSync, range: Range): Hint[] {
  const since = rangeStart(range);
  const where = since ? 'WHERE started_at >= ?' : '';
  const args = since ? [since] : [];
  const hints: Hint[] = [];

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS errors,
              COALESCE(SUM(cost_usd), 0) AS cost
         FROM tool_calls ${where}`,
    )
    .get(...args) as { calls: number; errors: number; cost: number };

  // Nothing useful can be said about a handful of calls.
  if (totals.calls < MIN_SAMPLES) return [];

  // ---- Reliability: a tool that fails often wastes a full turn each time,
  // because the agent pays for the failed call and then pays again to retry.
  const flaky = db
    .prepare(
      `SELECT tool_name,
              COUNT(*) AS n,
              SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors
         FROM tool_calls ${where}
        GROUP BY tool_name
       HAVING n >= 10 AND errors > 0
        ORDER BY errors DESC
        LIMIT 3`,
    )
    .all(...args) as Array<{ tool_name: string; n: number; errors: number }>;

  for (const t of flaky) {
    const rate = pct(t.errors, t.n);
    if (rate < 5) continue;
    hints.push({
      kind: 'reliability',
      title: `${t.tool_name} failed ${t.errors} of ${num(t.n)} times (${rate.toFixed(0)}%)`,
      detail:
        `Each failure costs a full turn: the agent pays for the failed call, reads the error, ` +
        `then pays again to retry. Look at what those calls have in common - a wrong path, a ` +
        `missing dependency, a command that needs different quoting on this platform.`,
      weight: t.errors * 2,
    });
  }

  // ---- Cost: one tool dominating spend is worth knowing about, because it is
  // usually one loop or one oversized input rather than steady usage.
  if (totals.cost > 0) {
    const top = db
      .prepare(
        `SELECT tool_name, COUNT(*) AS n, SUM(cost_usd) AS cost
           FROM tool_calls ${where}
          GROUP BY tool_name
         HAVING cost IS NOT NULL
          ORDER BY cost DESC
          LIMIT 1`,
      )
      .get(...args) as { tool_name: string; n: number; cost: number } | undefined;

    if (top && pct(top.cost, totals.cost) > 55) {
      hints.push({
        kind: 'cost',
        title: `${top.tool_name} accounts for ${pct(top.cost, totals.cost).toFixed(0)}% of the total across ${num(top.n)} calls`,
        detail:
          `One tool dominating usually means a loop, or one call carrying far more context than ` +
          `it needs. Check the Breakdown tab for the biggest individual calls before assuming ` +
          `it is spread evenly.`,
        weight: 40,
      });
    }
  }

  // ---- Cost: repeated identical calls. The same command run many times with
  // the same input is work the agent could have remembered.
  const repeated = db
    .prepare(
      `SELECT tool_name, input_summary, COUNT(*) AS n
         FROM tool_calls ${where}
        ${where ? 'AND' : 'WHERE'} input_summary IS NOT NULL AND length(input_summary) > 12
        GROUP BY tool_name, input_summary
       HAVING n >= 8
        ORDER BY n DESC
        LIMIT 1`,
    )
    .all(...args) as Array<{ tool_name: string; input_summary: string; n: number }>;

  for (const r of repeated) {
    hints.push({
      kind: 'cost',
      title: `The same ${r.tool_name} call ran ${r.n} times with identical input`,
      detail:
        `Repeating an identical call re-sends the whole context each time. If the result does ` +
        `not change, capture it once - a note in CLAUDE.md, or a file the agent can read - ` +
        `rather than re-deriving it.`,
      weight: r.n * 3,
    });
  }

  // ---- Cost: long sessions. Context is re-sent every turn, so a session that
  // runs all day pays for its own history repeatedly. This is the single
  // biggest lever most users have and the least obvious.
  const long = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM sessions ${where}
        ${where ? 'AND' : 'WHERE'} total_tokens_in > 2000000`,
    )
    .get(...args) as { n: number };

  if (long.n > 0) {
    hints.push({
      kind: 'cost',
      title: `${long.n} session${long.n === 1 ? '' : 's'} exceeded 2M input tokens`,
      detail:
        `Every turn re-sends the whole conversation, so a long session pays for its own history ` +
        `again and again - which is why cache reads dominate most totals. Running /clear between ` +
        `unrelated tasks is usually the largest single saving available.`,
      weight: 60,
    });
  }

  // ---- Speed: a slow tool is worth flagging separately from an expensive one,
  // since waiting is a cost the dollar figure never shows.
  // Tools whose duration is dominated by waiting for a human, not by work.
  // AskUserQuestion averaging 35 minutes says the user went to lunch; calling
  // that a performance problem would be advice nobody can act on.
  const HUMAN_PACED = ['AskUserQuestion', 'ExitPlanMode', 'TaskOutput'];
  const placeholders = HUMAN_PACED.map(() => '?').join(', ');

  const slow = db
    .prepare(
      `SELECT tool_name, AVG(duration_ms) AS avg_ms, COUNT(*) AS n
         FROM tool_calls ${where}
        ${where ? 'AND' : 'WHERE'} duration_ms IS NOT NULL
          AND tool_name NOT IN (${placeholders})
        GROUP BY tool_name
       HAVING n >= 10 AND avg_ms > 20000
        ORDER BY avg_ms * n DESC
        LIMIT 1`,
    )
    .all(...args, ...HUMAN_PACED) as Array<{ tool_name: string; avg_ms: number; n: number }>;

  for (const t of slow) {
    const totalMin = (t.avg_ms * t.n) / 60000;
    hints.push({
      kind: 'speed',
      title: `${t.tool_name} averages ${(t.avg_ms / 1000).toFixed(0)}s per call, ${totalMin.toFixed(0)} minutes total`,
      detail:
        `Waiting is a cost the dollar figure never shows. If these are builds or test runs, ` +
        `narrowing what they execute - a single test file rather than the suite - usually helps ` +
        `more than anything else here.`,
      weight: Math.min(35, totalMin / 2),
    });
  }

  // ---- Hygiene: an unpriced model makes every total a floor rather than a
  // number, which quietly undermines everything else on the page.
  const uncosted = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM tool_calls ${where}
        ${where ? 'AND' : 'WHERE'} cost_usd IS NULL AND status <> 'pending'`,
    )
    .get(...args) as { n: number };

  if (uncosted.n > 0 && pct(uncosted.n, totals.calls) > 20) {
    hints.push({
      kind: 'hygiene',
      title: `${num(uncosted.n)} calls (${pct(uncosted.n, totals.calls).toFixed(0)}%) have no price for their model`,
      detail:
        `Those calls are missing from every total on this page, so the figures are a floor rather ` +
        `than a total. Add the model to ~/.agentobs/pricing.json, or run "agentobs init" to top ` +
        `the table up with models added since you installed.`,
      weight: 25,
    });
  }

  // ---- Hygiene: a dollar budget on a subscription enforces nothing.
  const plan = detectPlan();
  if (plan.kind === 'subscription') {
    const dollarBudgets = db
      .prepare(`SELECT COUNT(*) AS n FROM budgets WHERE limit_usd IS NOT NULL`)
      .get() as { n: number };
    const tokenBudgets = db
      .prepare(`SELECT COUNT(*) AS n FROM budgets WHERE limit_tokens IS NOT NULL`)
      .get() as { n: number };

    if (dollarBudgets.n > 0 && tokenBudgets.n === 0) {
      hints.push({
        kind: 'hygiene',
        title: `Your budgets are in dollars, but ${plan.label ?? 'your plan'} bills a flat fee`,
        detail:
          `A dollar limit cannot bind on a subscription - the cost figure here is an API-equivalent, ` +
          `not a bill. The limit that actually applies is the rolling 5-hour window: ` +
          `agentobs budget set --block5h 200000 --tokens`,
        weight: 70,
      });
    }
  }

  // Ranked, then capped: three good hints get read, twelve get ignored.
  return hints.sort((a, b) => b.weight - a.weight).slice(0, 4);
}
