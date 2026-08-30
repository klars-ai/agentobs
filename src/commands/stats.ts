/**
 * `agentobs stats` - terminal summary.
 */
import { openDb } from '../core/db.js';
import { getModels, getSummary, getToolsBreakdown, type Range } from '../core/queries.js';

export interface StatsOptions {
  today?: boolean;
  since?: string;
  until?: string;
  session?: string;
  json?: boolean;
  /** Per-model cost breakdown. */
  breakdown?: boolean;
}

function toRange(opts: StatsOptions): Range {
  if (opts.today) return 'today';
  const v = opts.since;
  return v === 'today' || v === '7d' || v === '30d' || v === 'all' ? v : '7d';
}

/**
 * Fixed 4dp rendered $3.50 as "$3.5000", which reads as a machine dump rather
 * than money. Sub-cent precision still matters below a cent - a $0.004 day is
 * not a $0.00 day - so small values keep the extra digits and larger ones do
 * not. Same reasoning as budgetAmount, applied to totals rather than limits.
 */
const money = (v: number | null): string => {
  if (v === null) return '—';
  if (v === 0) return '$0.00';
  if (Math.abs(v) < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
};

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

  // A zero tool-call count next to a non-zero session count is the single most
  // confusing thing a new user sees - it reads as a broken install. Say which
  // integration produced the data and what it can and cannot see.
  if (summary.tool_calls === 0 && summary.coarse_sessions > 0) {
    const n = summary.coarse_sessions;
    console.log(
      [
        '',
        `  Why the zeros: all ${n} session${n === 1 ? '' : 's'} came from "agentobs run"`,
        '  (process-wrap), which observes a process from the outside - it records',
        '  duration and exit code, but cannot see individual tool calls or tokens.',
        '',
        '  For per-tool-call detail and cost, use the Claude Code hook (see',
        '  "agentobs init") or ingest a structured log with "agentobs watch".',
      ].join(String.fromCharCode(10)),
    );
  } else if (summary.coarse_sessions > 0 && summary.rich_sessions > 0) {
    // Mixed data: the totals are real but under-count, since coarse sessions
    // contribute no tool calls or tokens of their own.
    console.log(
      [
        '',
        `  Note: ${summary.coarse_sessions} of ${summary.sessions} sessions are coarse (process-wrap),`,
        '  so they add no tool calls or tokens to these totals.',
      ].join(String.fromCharCode(10)),
    );
  }

  // State plainly when the cost total is incomplete rather than letting a
  // partial number read as the whole spend.
  if (summary.uncosted_calls > 0) {
    console.log(
      `\n  Note: ${summary.uncosted_calls} call(s) have no price for their model.\n        Add it to ~/.agentobs/pricing.json to include them in the total.`,
    );
  }

  if (opts.breakdown) {
    const models = getModels(db, range);
    if (models.length > 0) {
      console.log('');
      console.log('  Model                          Calls        Tokens       Cost');
      console.log('  ' + '-'.repeat(62));
      for (const m of models.slice(0, 10)) {
        console.log(
          `  ${m.model.slice(0, 28).padEnd(28)} ${String(m.calls).padStart(7)} ` +
            `${m.tokens.toLocaleString().padStart(13)} ${money(m.cost_usd).padStart(10)}`,
        );
      }
    }
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
