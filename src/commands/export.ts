/**
 * `agentobs export` - CSV/JSON extraction.
 *
 * Exported summaries are already redacted, because redaction happens on write
 * rather than on read. An export can therefore be shared or attached to a
 * ticket without a separate scrubbing step.
 */
import { writeFileSync } from 'node:fs';
import { openDb } from '../core/db.js';
import { getPolicyDecisions, getRecentToolCalls, getSessions, type Range } from '../core/queries.js';

export interface ExportOptions {
  format: string;
  out?: string;
  table?: string;
  since?: string;
}

function toRange(value: string | undefined): Range {
  return value === 'today' || value === '7d' || value === '30d' || value === 'all' ? value : 'all';
}

/**
 * RFC 4180 CSV escaping.
 *
 * Tool inputs routinely contain commas, quotes and newlines, so every field is
 * quoted and inner quotes doubled - a naive join would silently corrupt the
 * column layout of any row containing a shell command.
 */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  return `"${str.replace(/"/g, '""')}"`;
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => csvCell(row[h])).join(','));
  }
  return lines.join('\n') + '\n';
}

export async function exportData(opts: ExportOptions): Promise<void> {
  const format = opts.format.toLowerCase();
  if (format !== 'csv' && format !== 'json') {
    console.error(`Unsupported format "${opts.format}". Use csv or json.`);
    process.exitCode = 2;
    return;
  }

  const db = openDb();
  const range = toRange(opts.since);
  const table = opts.table ?? 'tool-calls';

  let rows: Record<string, unknown>[];
  switch (table) {
    case 'sessions':
      rows = getSessions(db, { range, limit: 500 }) as unknown as Record<string, unknown>[];
      break;
    case 'policy-decisions':
      rows = getPolicyDecisions(db, { limit: 500 }) as Record<string, unknown>[];
      break;
    case 'tool-calls':
      rows = getRecentToolCalls(db, { range, limit: 500 }) as unknown as Record<string, unknown>[];
      break;
    default:
      console.error(`Unknown table "${table}". Use sessions, tool-calls, or policy-decisions.`);
      process.exitCode = 2;
      return;
  }

  const body = format === 'json' ? `${JSON.stringify(rows, null, 2)}\n` : toCsv(rows);

  if (opts.out) {
    writeFileSync(opts.out, body, 'utf8');
    console.log(`Wrote ${rows.length} row(s) to ${opts.out}`);
  } else {
    process.stdout.write(body);
  }
}
