/**
 * SQLite access layer.
 *
 * Uses node:sqlite (built into Node >=22.5) rather than better-sqlite3 on
 * purpose: better-sqlite3 is a native addon with no prebuilt binary for
 * current Node releases, so installing it demands a C++ toolchain (Visual
 * Studio on Windows). For a tool whose pitch is "npx agentobs init and
 * you're running", a compiler in the install path is disqualifying. The
 * built-in module has the same synchronous, prepared-statement API.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ensureHome, paths } from './paths.js';

export type Db = DatabaseSync;

let cached: DatabaseSync | null = null;

function schemaSql(): string {
  // schema.sql sits next to this file in both src/ (dev) and dist/ (built),
  // copied by scripts/copy-assets.mjs.
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, 'schema.sql'), 'utf8');
}

/**
 * Opens (and migrates) the local database, memoised per process.
 *
 * The hook adapter runs this on every single tool call the agent makes, so
 * the whole path has to stay well under the ~50ms budget - hence WAL, the
 * memoised handle, and NORMAL synchronous mode.
 */
export function openDb(file?: string): DatabaseSync {
  if (cached) return cached;
  ensureHome();
  const db = new DatabaseSync(file ?? paths.db());

  // WAL lets the dashboard read while a hook writes, instead of the two
  // blocking each other - the single most important setting here, since a
  // reader holding a lock would stall the agent's tool call.
  db.exec('PRAGMA journal_mode = WAL');
  // NORMAL trades a fsync per commit for speed. On a crash the worst case is
  // losing the last few observability rows, which is an acceptable loss for
  // a monitoring tool and not worth taxing every tool call to prevent.
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  // Migrate first: schema.sql creates partial indexes over columns like
  // synced_at, and CREATE INDEX fails outright if an older table lacks them.
  migrate(db);
  db.exec(schemaSql());
  migrate(db);
  ensureDeviceId(db);

  cached = db;
  return db;
}

/** Closes the memoised handle. Chiefly for tests and clean process exit. */
export function closeDb(): void {
  if (cached) {
    cached.close();
    cached = null;
  }
}

/**
 * Additive column migrations.
 *
 * schema.sql uses CREATE TABLE IF NOT EXISTS, which is right for a fresh
 * install but silently does nothing to an existing database - so a column
 * added in a later release never appears, and every query touching it fails
 * with "no such column" on upgrade. That is a broken upgrade for every
 * existing user, so new columns must be added here as well as in schema.sql.
 *
 * Each entry is idempotent: the column list is read first, and anything
 * already present is skipped.
 */
function migrate(db: DatabaseSync): void {
  const additions: Array<{ table: string; column: string; definition: string }> = [
    // sessions - every column added after the first release. The sync
    // columns are here too because schema.sql creates partial indexes over
    // them, and CREATE INDEX fails outright on a table that lacks them.
    { table: 'sessions', column: 'git_branch', definition: 'TEXT' },
    { table: 'sessions', column: 'blocked_count', definition: 'INTEGER NOT NULL DEFAULT 0' },
    { table: 'sessions', column: 'fidelity', definition: "TEXT NOT NULL DEFAULT 'rich'" },
    { table: 'sessions', column: 'exit_code', definition: 'INTEGER' },
    { table: 'sessions', column: 'model_hint', definition: 'TEXT' },
    { table: 'sessions', column: 'cwd', definition: 'TEXT' },
    { table: 'sessions', column: 'total_tokens_in', definition: 'INTEGER NOT NULL DEFAULT 0' },
    { table: 'sessions', column: 'total_tokens_out', definition: 'INTEGER NOT NULL DEFAULT 0' },
    { table: 'sessions', column: 'total_cost_usd', definition: 'REAL' },
    { table: 'sessions', column: 'tool_call_count', definition: 'INTEGER NOT NULL DEFAULT 0' },
    { table: 'sessions', column: 'error_count', definition: 'INTEGER NOT NULL DEFAULT 0' },
    { table: 'sessions', column: 'device_id', definition: 'TEXT' },
    { table: 'sessions', column: 'account_id', definition: 'TEXT' },
    { table: 'sessions', column: 'ended_at', definition: 'TEXT' },
    { table: 'sessions', column: 'synced_at', definition: 'TEXT' },

    { table: 'tool_calls', column: 'model', definition: 'TEXT' },
    { table: 'tool_calls', column: 'ended_at', definition: 'TEXT' },
    { table: 'tool_calls', column: 'synced_at', definition: 'TEXT' },

    { table: 'budgets', column: 'limit_tokens', definition: 'INTEGER' },
    { table: 'policy_decisions', column: 'synced_at', definition: 'TEXT' },
  ];

  for (const { table, column, definition } of additions) {
    try {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (columns.length === 0) continue; // table not created yet
      if (columns.some((c) => c.name === column)) continue;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } catch {
      // A migration must never stop the tool from opening. A missing column
      // degrades one feature; a throw here would break every command.
    }
  }
}

export function getMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

/**
 * This machine's stable identifier, minted once on first run. Used to
 * attribute sessions to a device in the team view without ever sending a
 * hostname or anything else personally identifying.
 */
export function ensureDeviceId(db: DatabaseSync): string {
  const existing = getMeta(db, 'device_id');
  if (existing) return existing;
  const id = randomUUID();
  setMeta(db, 'device_id', id);
  return id;
}

export { randomUUID as newId };
