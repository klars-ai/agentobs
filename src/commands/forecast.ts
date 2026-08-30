/**
 * `agentobs forecast` - when will I hit my limit?
 *
 * The question a read-only tool cannot answer, because it needs both the
 * usage and the limit. Also runs as a live watch, which is how it becomes
 * useful mid-task rather than something you remember to check afterwards.
 */
import { openDb } from '../core/db.js';
import { checkBudgets, type BudgetStatus } from '../core/budget.js';
import { forecastBudget, humanDuration, projectedTime, type Forecast } from '../core/forecast.js';

export interface ForecastOptions {
  /** Refresh continuously instead of printing once. */
  watch?: boolean;
  json?: boolean;
}

function amount(value: number, unit: 'usd' | 'tokens'): string {
  if (unit === 'tokens') {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
    return String(Math.round(value));
  }
  return `$${value.toFixed(2)}`;
}

function bar(ratio: number, width = 24): string {
  const filled = Math.min(width, Math.max(0, Math.round(ratio * width)));
  return `[${'#'.repeat(filled)}${'.'.repeat(width - filled)}]`;
}

function render(rows: Array<{ status: BudgetStatus; forecast: Forecast }>): string {
  const out: string[] = [''];

  for (const { status, forecast } of rows) {
    const unit = status.unit;
    const pct = Math.round(status.ratio * 100);

    out.push(
      `  ${status.budget.period.toUpperCase()}  ${amount(status.spent, unit)} of ` +
        `${amount(status.limit, unit)}  (${pct}%)`,
    );
    out.push(`  ${bar(status.ratio)}`);

    if (status.exceeded) {
      out.push(
        `  LIMIT REACHED${status.budget.action === 'block' ? ' - tool calls are being blocked.' : '.'}`,
      );
    } else if (forecast.minutesToLimit !== null && forecast.willExceed) {
      // The line this whole feature exists for.
      out.push(
        `  At ${amount(forecast.ratePerHour, unit)}/hour you hit the limit in ` +
          `${humanDuration(forecast.minutesToLimit)} (~${projectedTime(forecast.minutesToLimit)}),`,
      );
      out.push(`  ${humanDuration(forecast.minutesRemaining)} before the period resets.`);
    } else if (forecast.confidence === 'none') {
      out.push(`  ${forecast.note ?? 'Not enough activity to project a rate yet.'}`);
    } else {
      out.push(
        `  At ${amount(forecast.ratePerHour, unit)}/hour you finish the period at ` +
          `~${amount(forecast.projectedTotal, unit)} - inside the limit.`,
      );
    }

    if (forecast.note && forecast.confidence === 'low') {
      out.push(`  (${forecast.note})`);
    }
    out.push('');
  }

  return out.join('\n');
}

export async function forecast(opts: ForecastOptions = {}): Promise<void> {
  const db = openDb();

  const compute = (): Array<{ status: BudgetStatus; forecast: Forecast }> =>
    // record:false - a forecast must not consume the one-shot budget alert
    // that the hook path relies on.
    checkBudgets(db, { record: false }).map((status) => ({
      status,
      forecast: forecastBudget(db, status),
    }));

  const rows = compute();

  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log(`No budgets set, so there is nothing to forecast.

  agentobs budget set --block5h 200000 --tokens   your 5-hour window
  agentobs budget set --daily 5                   a daily spend limit

A forecast needs a limit as well as usage - that is exactly why a
read-only usage tool cannot tell you when you will run out.`);
    return;
  }

  if (!opts.watch) {
    console.log(render(rows));
    return;
  }

  console.log('  Forecasting - Ctrl-C to stop.\n');
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      process.stdout.write('\n');
      process.exit(0);
    });
  }

  // Repaint in place so the terminal shows a live gauge rather than a
  // scrolling log nobody reads.
  for (;;) {
    const text = render(compute());
    process.stdout.write('\x1b[2J\x1b[H');
    process.stdout.write(`  AgentObs forecast - ${new Date().toLocaleTimeString()}\n${text}`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
}
