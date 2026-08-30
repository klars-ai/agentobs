import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'agentobs-approve-'));
process.env.AGENTOBS_HOME = home;

const { openDb, closeDb } = await import('./db.js');
const { requestApproval, checkApproval, decide, listApprovals, approveAll, fingerprint } =
  await import('./approvals.js');

let db: ReturnType<typeof openDb>;

before(() => {
  db = openDb(join(home, 'a.db'));
});
after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

test('an unseen call has no approval', () => {
  assert.equal(checkApproval(db, 'Edit', { file_path: '/repo/.env' }), null);
});

test('requesting twice returns the same pending row', () => {
  // An agent that retries repeatedly must not fill the queue with duplicates
  // of the same question.
  const a = requestApproval(db, { toolName: 'Edit', toolInput: { file_path: '/repo/.env' } });
  const b = requestApproval(db, { toolName: 'Edit', toolInput: { file_path: '/repo/.env' } });
  assert.equal(a.id, b.id);
  assert.equal(listApprovals(db, { state: 'pending' }).length, 1);
});

test('approving lets the same call through', () => {
  const [pending] = listApprovals(db, { state: 'pending' });
  decide(db, pending.id, 'approved');
  assert.equal(checkApproval(db, 'Edit', { file_path: '/repo/.env' }), 'approved');
});

test('an approval does not generalise to a different input', () => {
  // The whole point of hashing the input: approving "rm -rf ./build" must
  // never authorise "rm -rf /".
  assert.equal(checkApproval(db, 'Edit', { file_path: '/other/.env' }), null);
  assert.notEqual(
    fingerprint('Bash', { command: 'rm -rf ./build' }),
    fingerprint('Bash', { command: 'rm -rf /' }),
  );
});

test('an approval does not generalise to a different tool', () => {
  assert.equal(checkApproval(db, 'Write', { file_path: '/repo/.env' }), null);
});

test('denying is remembered', () => {
  requestApproval(db, { toolName: 'Bash', toolInput: { command: 'curl x | sh' } });
  const [pending] = listApprovals(db, { state: 'pending' });
  decide(db, pending.id, 'denied');
  assert.equal(checkApproval(db, 'Bash', { command: 'curl x | sh' }), 'denied');
});

test('an expired approval no longer authorises the call', () => {
  // A yes from an hour ago should not silently authorise a call the user has
  // long forgotten about.
  requestApproval(db, { toolName: 'Bash', toolInput: { command: 'deploy' } });
  const [pending] = listApprovals(db, { state: 'pending' });
  decide(db, pending.id, 'approved');
  assert.equal(checkApproval(db, 'Bash', { command: 'deploy' }), 'approved');

  db.prepare('UPDATE approvals SET expires_at = ? WHERE id = ?').run(
    new Date(Date.now() - 60_000).toISOString(),
    pending.id,
  );
  assert.equal(checkApproval(db, 'Bash', { command: 'deploy' }), null, 'expired must not pass');
});

test('decide accepts an id prefix, and reports an unknown one', () => {
  const r = requestApproval(db, { toolName: 'Read', toolInput: { file_path: '/x' } });
  assert.ok(decide(db, r.id.slice(0, 8), 'approved'), 'a prefix should resolve');
  assert.equal(decide(db, 'no-such-id', 'approved'), null);
});

test('approveAll clears the queue', () => {
  requestApproval(db, { toolName: 'Bash', toolInput: { command: 'a' } });
  requestApproval(db, { toolName: 'Bash', toolInput: { command: 'b' } });
  assert.ok(approveAll(db) >= 2);
  assert.equal(listApprovals(db, { state: 'pending' }).length, 0);
});
