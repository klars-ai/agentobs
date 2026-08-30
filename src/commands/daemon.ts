/**
 * `agentobs daemon` - keeps one process warm so hot paths skip Node startup.
 *
 * Handlers run against an already-open database, turning a ~1700ms cold
 * start into a ~1ms socket round trip.
 */
import { openDb } from '../core/db.js';
import { serve, socketPath, isRunning } from '../core/daemon.js';
import { checkBudgets } from '../core/budget.js';
import { forecastBudget } from '../core/forecast.js';
import { getSummary, type Range } from '../core/queries.js';

export interface DaemonOptions {
  /** Minutes of inactivity before exiting. 0 keeps it running forever. */
  idle?: string;
  quiet?: boolean;
}

function toRange(value: unknown): Range {
  return value === 'today' || value === '7d' || value === '30d' || value === 'all' ? value : 'today';
}

export async function daemon(opts: DaemonOptions = {}): Promise<void> {
  if (await isRunning()) {
    console.log(`A daemon is already running on ${socketPath()}`);
    return;
  }

  const db = openDb();
  const idleMinutes = Number(opts.idle ?? 60);

  const handlers = {
    /** Everything the statusline needs, in one round trip. */
    statusline: () => {
      const statuses = checkBudgets(db, { record: false });
      const tightest = [...statuses].sort((a, b) => b.ratio - a.ratio)[0];
      return {
        budget: tightest
          ? {
              period: tightest.budget.period,
              spent: tightest.spent,
              limit: tightest.limit,
              unit: tightest.unit,
              ratio: tightest.ratio,
              exceeded: tightest.exceeded,
              forecast: forecastBudget(db, tightest),
            }
          : null,
      };
    },

    budgets: () =>
      checkBudgets(db, { record: false }).map((s) => ({
        ...s,
        forecast: forecastBudget(db, s),
      })),

    summary: (req: { args?: Record<string, unknown> }) =>
      getSummary(db, toRange(req.args?.range)),
  };

  await serve(handlers, {
    idleTimeoutMs: idleMinutes > 0 ? idleMinutes * 60_000 : 0,
    onListening: (path) => {
      if (opts.quiet) return;
      console.log(`AgentObs daemon listening on ${path}`);
      console.log(
        idleMinutes > 0
          ? `  Exits after ${idleMinutes} min idle. Ctrl-C to stop.\n`
          : '  Ctrl-C to stop.\n',
      );
    },
  });
}
