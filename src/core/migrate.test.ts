import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const home = mkdtempSync(join(tmpdir(), 'agentobs-migrate-'));
process.env.AGENTOBS_HOME = home;

const { openDb, closeDb } = await import('./db.js');

test.after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

test('an older database gains new columns on open', () => {
  // Regression: schema.sql uses CREATE TABLE IF NOT EXISTS, which does
  // nothing to an existing table. A column added in a later release never
  // appeared, and every query touching it failed with "no such column" -
  // a broken upgrade for every existing install.
  const file = join(home, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      agent_name TEXT NOT NULL,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  old.close();

  const db = openDb(file);
  const columns = (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map(
    (c) => c.name,
  );

  assert.ok(columns.includes('model_hint'), 'model_hint should be added on upgrade');
  assert.ok(columns.includes('git_branch'), 'git_branch should be added on upgrade');
  assert.ok(columns.includes('blocked_count'), 'blocked_count should be added on upgrade');
});

test('migrating twice is a no-op, not an error', () => {
  // ALTER TABLE ADD COLUMN throws if the column exists, so the guard has to
  // hold on every subsequent open - which is every single command.
  assert.doesNotThrow(() => {
    closeDb();
    openDb(join(home, 'old.db'));
  });
});
