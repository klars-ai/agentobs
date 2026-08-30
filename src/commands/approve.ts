/**
 * `agentobs approvals` / `approve` / `deny` - decide on held calls.
 */
import { openDb } from '../core/db.js';
import { approveAll, decide, listApprovals } from '../core/approvals.js';

function relative(iso: string): string {
  const secs = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  return `${Math.round(secs / 3600)}h ago`;
}

export async function approvals(opts: { all?: boolean } = {}): Promise<void> {
  const db = openDb();
  const rows = listApprovals(db, opts.all ? {} : { state: 'pending' });

  if (rows.length === 0) {
    console.log(
      opts.all ? '\n  No approval requests recorded.\n' : '\n  Nothing waiting for approval.\n',
    );
    return;
  }

  console.log('');
  for (const r of rows) {
    const mark = r.state === 'pending' ? '?' : r.state === 'approved' ? 'y' : 'n';
    console.log(`  [${mark}] ${r.id.slice(0, 8)}  ${r.tool_name.padEnd(10)} ${relative(r.requested_at)}`);
    if (r.rule_matched) console.log(`      rule: ${r.rule_matched}`);
    if (r.input_summary) console.log(`      ${r.input_summary.slice(0, 90)}`);
  }

  const pending = rows.filter((r) => r.state === 'pending').length;
  if (pending > 0) {
    console.log(`
  ${pending} waiting.  agentobs approve <id>   |   agentobs deny <id>
                       agentobs approve --all`);
  }
  console.log('');
}

export async function approve(id: string | undefined, opts: { all?: boolean } = {}): Promise<void> {
  const db = openDb();

  if (opts.all) {
    const n = approveAll(db);
    console.log(
      n === 0
        ? 'Nothing was waiting for approval.'
        : `Approved ${n} request(s). Ask the agent to retry — approvals last 60 minutes.`,
    );
    return;
  }

  if (!id) {
    console.error('Which one? Run "agentobs approvals" to list them, or use --all.');
    process.exitCode = 2;
    return;
  }

  const r = decide(db, id, 'approved');
  if (!r) {
    console.error(`No approval request matching "${id}".`);
    process.exitCode = 1;
    return;
  }
  console.log(`Approved ${r.tool_name} (${r.id.slice(0, 8)}).
Ask the agent to retry the same call — the approval is remembered for 60 minutes.`);
}

export async function deny(id: string): Promise<void> {
  const db = openDb();
  const r = decide(db, id, 'denied');
  if (!r) {
    console.error(`No approval request matching "${id}".`);
    process.exitCode = 1;
    return;
  }
  console.log(`Denied ${r.tool_name} (${r.id.slice(0, 8)}).`);
}
