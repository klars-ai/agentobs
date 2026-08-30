/**
 * `agentobs projects` - spend grouped by working directory.
 *
 * Answers "which repo is burning my budget", which is the first question
 * anyone juggling several codebases asks. Uses the cwd already recorded per
 * session, so it needs no new data collection.
 */
import { openDb } from '../core/db.js';
import { getProjects, type Range } from '../core/queries.js';

export interface ProjectsOptions {
  since?: string;
  json?: boolean;
}

const money = (v: number | null): string => (v === null ? '—' : `$${v.toFixed(2)}`);

function toRange(value: string | undefined): Range {
  return value === 'today' || value === '7d' || value === '30d' || value === 'all' ? value : '7d';
}

export async function projects(opts: ProjectsOptions = {}): Promise<void> {
  const db = openDb();
  const rows = getProjects(db, toRange(opts.since));

  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log('\n  No sessions recorded yet. Try "agentobs import".\n');
    return;
  }

  const total = rows.reduce((sum, r) => sum + (r.cost_usd ?? 0), 0);

  console.log('\n  Project              Sessions   Calls       Cost   Share\n  ' + '-'.repeat(58));
  for (const r of rows.slice(0, 20)) {
    const share = total > 0 ? `${Math.round(((r.cost_usd ?? 0) / total) * 100)}%` : '—';
    console.log(
      `  ${r.project.slice(0, 20).padEnd(20)} ${String(r.sessions).padStart(8)} ` +
        `${String(r.tool_calls).padStart(7)} ${money(r.cost_usd).padStart(10)} ${share.padStart(7)}`,
    );
  }
  console.log(`\n  ${rows.length} project(s) · ${money(total)} total\n`);
}
