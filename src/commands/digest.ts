/**
 * `agentobs digest` - a period summary worth reading.
 *
 * Stats answers "what are the totals"; a digest answers "what should I know".
 * It leads with spend, names the most expensive day and project, and reports
 * anything blocked - the handful of facts that would actually change what
 * someone does next.
 */
import { openDb } from '../core/db.js';
import {
  getProjects,
  getSummary,
  getTimeline,
  getToolsBreakdown,
  rangeLabel,
  type Range,
} from '../core/queries.js';
import { checkBudgets } from '../core/budget.js';

export interface DigestOptions {
  since?: string;
  json?: boolean;
}

const money = (v: number | null): string => (v === null ? '—' : `$${v.toFixed(2)}`);
const pct = (n: number): string => `${Math.round(n * 100)}%`;

function toRange(value: string | undefined): Range {
  return value === 'today' || value === '7d' || value === '30d' || value === 'all' ? value : '7d';
}

export async function digest(opts: DigestOptions = {}): Promise<void> {
  const db = openDb();
  const range = toRange(opts.since);

  const summary = getSummary(db, range);
  const timeline = getTimeline(db, range);
  const tools = getToolsBreakdown(db, range);
  const projects = getProjects(db, range);
  const budgets = checkBudgets(db, { record: false });

  if (opts.json) {
    console.log(JSON.stringify({ summary, timeline, tools, projects, budgets }, null, 2));
    return;
  }

  if (summary.sessions === 0) {
    console.log(`\n  Nothing recorded for ${range}.\n\n  Try "agentobs import" to pull in your Claude Code history.\n`);
    return;
  }

  const label = rangeLabel(range);
  const busiest = [...timeline].sort((a, b) => b.calls - a.calls)[0];
  const priciest = [...timeline]
    .filter((t) => t.cost_usd !== null)
    .sort((a, b) => (b.cost_usd ?? 0) - (a.cost_usd ?? 0))[0];
  const topTool = tools[0];
  const topProject = projects[0];
  const share = topTool && summary.tool_calls > 0 ? topTool.calls / summary.tool_calls : 0;

  const lines: string[] = [
    '',
    `  ${label} · ${money(summary.total_cost_usd)} across ${summary.sessions} session${summary.sessions === 1 ? '' : 's'}`,
    '',
    `  ${summary.tool_calls.toLocaleString()} tool calls · ${(summary.tokens_in + summary.tokens_out).toLocaleString()} tokens · ${pct(summary.error_rate)} errors`,
  ];

  if (topTool) {
    lines.push(`  Most used: ${topTool.tool_name} (${topTool.calls} calls, ${pct(share)} of all)`);
  }
  if (topProject && projects.length > 1) {
    lines.push(`  Top project: ${topProject.project} (${money(topProject.cost_usd)})`);
  }
  if (priciest) {
    lines.push(`  Priciest day: ${priciest.bucket} (${money(priciest.cost_usd)})`);
  } else if (busiest) {
    lines.push(`  Busiest: ${busiest.bucket} (${busiest.calls} calls)`);
  }

  if (summary.blocked > 0) {
    lines.push('', `  ${summary.blocked} call${summary.blocked === 1 ? '' : 's'} blocked by policy.`);
  }

  // Budgets are the actionable part: a digest that does not mention an
  // exceeded limit has buried the one thing worth acting on.
  const overspent = budgets.filter((b) => b.exceeded);
  if (overspent.length > 0) {
    lines.push('');
    for (const b of overspent) {
      lines.push(
        `  OVER BUDGET: ${money(b.spent)} against a ${money(b.limit)} ${b.budget.period} limit` +
          (b.budget.action === 'block' ? ' (blocking)' : ''),
      );
    }
  } else if (budgets.length > 0) {
    const tightest = [...budgets].sort((a, b) => b.ratio - a.ratio)[0];
    lines.push('', `  Budget: ${pct(tightest.ratio)} of the ${tightest.budget.period} limit used.`);
  }

  if (summary.uncosted_calls > 0) {
    lines.push(
      '',
      `  Note: ${summary.uncosted_calls} call(s) have no price for their model, so the`,
      '  cost above under-reports. Add it to ~/.agentobs/pricing.json.',
    );
  }

  lines.push('');
  console.log(lines.join('\n'));
}
