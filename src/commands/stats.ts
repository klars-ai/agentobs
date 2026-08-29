/**
 * `agentobs stats` - terminal summary.
 */
import { openDb } from '../core/db.js';
import { getSummary, getToolsBreakdown, type Range } from '../core/queries.js';

export interface StatsOptions {
  today?: boolean;
  since?: string;
  session?: string;
  json?: boolean;
}

function toRange(opts: StatsOptions): Range {
  if (opts.today) return 'today';
  const v = opts.since;
  return v === 'today' || v === '7d' || v === '30d' || v === 'all' ? v : '7d';
}

const money = (v: number | null): string => (v === null ? '—' : `$${v.toFixed(4)}`);

export async function stats(opts: StatsOptions): Promise<void> {
  const db = openDb();
  const range = toRange(opts);
  const summary = getSummary(db, range);
  const tools = getToolsBreakdown(db, range);

  if (opts.json) {
    console.log(JSON.stringify({ summary, tools }, null, 2));
    return;
  }

  console.log(`
AgentObs · ${range}

  Cost           ${money(summary.total_cost_usd)}
  Tool calls     ${summary.tool_calls}
  Sessions       ${summary.sessions}
  Errors         ${summary.errors} (${(summary.error_rate * 100).toFixed(1)}%)
  Blocked        ${summary.blocked}
  Tokens         ${summary.tokens_in.toLocaleString()} in / ${summary.tokens_out.toLocaleString()} out`);

  // State plainly when the cost total is incomplete rather than letting a
  // partial number read as the whole spend.
  if (summary.uncosted_calls > 0) {
    console.log(
      `\n  Note: ${summary.uncosted_calls} call(s) have no price for their model.\n        Add it to ~/.agentobs/pricing.json to include them in the total.`,
    );
  }

  if (tools.length > 0) {
    console.log('\n  Tool                 Calls   Errors      Cost');
    console.log('  ' + '-'.repeat(46));
    for (const t of tools.slice(0, 12)) {
      const name = t.tool_name.slice(0, 18).padEnd(18);
      const calls = String(t.calls).padStart(7);
      const errors = String(t.errors).padStart(8);
      const cost = money(t.cost_usd).padStart(10);
      console.log(`  ${name} ${calls} ${errors} ${cost}`);
    }
  }
  console.log('');
}
