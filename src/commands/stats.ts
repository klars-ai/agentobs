/**
 * `agentobs stats` - terminal summary.
 */
import { openDb } from '../core/db.js';
import { getHints } from '../core/advice.js';
import { costCaveat, costLabel, detectPlan } from '../core/plan.js';
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

  // On a subscription this figure is a list-price equivalent, not money anyone
  // will be charged. Presenting it unlabelled is how a Max user sees "$5,525
  // this week" and reasonably concludes the tool is broken.
  const plan = detectPlan();
  const caveat = costCaveat(plan);

  if (opts.json) {
    console.log(JSON.stringify({ summary, tools, plan }, null, 2));
    return;
  }

  // The label is wider on a subscription, so the column is sized to whichever
  // label is in use rather than to a fixed width that only suits one of them.
  const label = costLabel(plan);
  const pad = Math.max(label.length, 'Tool calls'.length) + 2;

  console.log(`
AgentObs · ${range}

  ${label.padEnd(pad)}${money(summary.total_cost_usd)}
  ${'Tool calls'.padEnd(pad)}${summary.tool_calls}
  ${'Sessions'.padEnd(pad)}${summary.sessions}
  ${'Errors'.padEnd(pad)}${summary.errors} (${(summary.error_rate * 100).toFixed(1)}%)
  ${'Blocked'.padEnd(pad)}${summary.blocked}
  ${'Tokens'.padEnd(pad)}${summary.tokens_in.toLocaleString()} in / ${summary.tokens_out.toLocaleString()} out`);

  if (caveat) {
    // Wrapped by hand: a single 150-character line in a terminal is unreadable,
    // and this is the sentence that stops the figure being misread.
    const [head, rest] = caveat.split(' Cap what actually binds you with token budgets: ');
    console.log(`\n  ${head}`);
    if (rest) console.log(`\n  Cap what actually binds you with token budgets:\n    ${rest}`);
  }

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

  // Hints last: the numbers above are what was asked for, and this is the
  // "so what". Nothing prints when there is nothing worth saying.
  const hints = getHints(db, range);
  if (hints.length > 0) {
    console.log('\n  Worth a look');
    console.log('  ' + '-'.repeat(46));
    for (const h of hints) {
      console.log(`  [${h.kind}] ${h.title}`);
      // Wrapped to a terminal width rather than printed as one long line.
      const words = h.detail.split(' ');
      let line = '   ';
      for (const w of words) {
        if ((line + w).length > 74) {
          console.log(line);
          line = '   ';
        }
        line += ` ${w}`;
      }
      if (line.trim()) console.log(line);
      console.log('');
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
