/**
 * `agentobs prune` - drop old data.
 *
 * The database grows forever otherwise: a busy month of imports put ~16k tool
 * calls and tens of MB into it during development. Nobody needs last year's
 * individual tool inputs, but they do want the cost history - so pruning
 * removes per-call detail while leaving session totals intact by default.
 */
import { statSync } from 'node:fs';
import { openDb } from '../core/db.js';
import { paths } from '../core/paths.js';

export interface PruneOptions {
  /** Delete data older than this many days. */
  olderThan?: string | number;
  /** Remove whole sessions too, not just their tool calls. */
  sessions?: boolean;
  /** Report what would be removed, delete nothing. */
  dryRun?: boolean;
  yes?: boolean;
}

const mb = (bytes: number): string => `${(bytes / 1048576).toFixed(1)} MB`;

export async function prune(opts: PruneOptions = {}): Promise<void> {
  const days = Number(opts.olderThan ?? 90);
  if (!Number.isFinite(days) || days < 1) {
    console.error('--older-than must be a number of days, e.g. --older-than 90');
    process.exitCode = 2;
    return;
  }

  const db = openDb();
  const cutoff = new Date(Date.now() - days * 864e5).toISOString();
  const sizeBefore = statSync(paths.db()).size;

  const counts = {
    toolCalls: (
      db.prepare('SELECT COUNT(*) AS n FROM tool_calls WHERE started_at < ?').get(cutoff) as {
        n: number;
      }
    ).n,
    sessions: (
      db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE started_at < ?').get(cutoff) as {
        n: number;
      }
    ).n,
    decisions: (
      db.prepare('SELECT COUNT(*) AS n FROM policy_decisions WHERE decided_at < ?').get(cutoff) as {
        n: number;
      }
    ).n,
  };

  if (counts.toolCalls === 0 && counts.decisions === 0 && (!opts.sessions || counts.sessions === 0)) {
    console.log(`\n  Nothing older than ${days} days. Database is ${mb(sizeBefore)}.\n`);
    return;
  }

  console.log(`
  Older than ${days} days:

    tool calls        ${counts.toolCalls.toLocaleString()}
    policy decisions  ${counts.decisions.toLocaleString()}
    sessions          ${counts.sessions.toLocaleString()}${opts.sessions ? '' : '  (kept - use --sessions to remove)'}

  Database is currently ${mb(sizeBefore)}.`);

  if (opts.dryRun) {
    console.log('\n  Dry run: nothing was deleted.\n');
    return;
  }

  if (!opts.yes) {
    // Deleting history is irreversible and there is no undo, so an explicit
    // confirmation is the right default for a non-interactive CLI.
    console.log(`
  Nothing deleted. Re-run with --yes to confirm:

    agentobs prune --older-than ${days}${opts.sessions ? ' --sessions' : ''} --yes
`);
    return;
  }

  // Order matters: children before parents, or the foreign key on
  // tool_calls.session_id would reject the session delete.
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM policy_decisions WHERE decided_at < ?').run(cutoff);
    db.prepare('DELETE FROM tool_calls WHERE started_at < ?').run(cutoff);
    if (opts.sessions) {
      db.prepare('DELETE FROM sessions WHERE started_at < ?').run(cutoff);
    }
    db.prepare('DELETE FROM approvals WHERE requested_at < ?').run(cutoff);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    console.error(`Nothing was deleted: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  // VACUUM actually returns the space; without it SQLite keeps the pages and
  // the file never shrinks, which makes prune look like it did nothing.
  db.exec('VACUUM');

  const sizeAfter = statSync(paths.db()).size;
  console.log(`
  Pruned. Database ${mb(sizeBefore)} -> ${mb(sizeAfter)}.
`);
}
