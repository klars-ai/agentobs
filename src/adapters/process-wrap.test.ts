import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'agentobs-wrap-test-'));
process.env.AGENTOBS_HOME = home;

const { runWrapped } = await import('./process-wrap.js');
const { openDb, closeDb } = await import('../core/db.js');
const { getSessions } = await import('../core/queries.js');

test.after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

test('wraps a plain executable and records the session', async () => {
  const code = await runWrapped(['node', '-e', 'process.exit(0)'], { agentName: 'test-exe' });
  assert.equal(code, 0);
  const session = getSessions(openDb()).find((s) => s.agent_name === 'test-exe');
  assert.ok(session, 'session should be recorded');
  assert.equal(session.fidelity, 'coarse', 'process-wrap only sees the process');
});

test('passes through an argument containing spaces', async () => {
  // Regression: `shell: true` concatenates instead of escaping (Node DEP0190),
  // so an argument with a space was silently split - for an agent CLI that
  // means a corrupted prompt.
  const code = await runWrapped(
    ['node', '-e', 'if (process.argv[1] !== "a b c") process.exit(3)', 'a b c'],
    { agentName: 'test-spaces' },
  );
  assert.equal(code, 0, 'argument with spaces must arrive intact');
});

test('passes through the exit code unchanged', async () => {
  // Wrapping a command inside CI must not change whether it passed.
  const code = await runWrapped(['node', '-e', 'process.exit(7)'], { agentName: 'test-exit' });
  assert.equal(code, 7);
});

test('records a failed spawn rather than losing the attempt', async () => {
  const code = await runWrapped(['definitely-not-a-real-command-xyz'], { agentName: 'test-enoent' });
  assert.equal(code, 127, 'command-not-found maps to the shell convention');
  const session = getSessions(openDb()).find((s) => s.agent_name === 'test-enoent');
  assert.ok(session, 'a failed start should still be recorded');
});

test('runs a Windows .cmd shim whose path contains spaces', { skip: process.platform !== 'win32' }, async () => {
  // Regression: npm ships both `npm` (extensionless, unusable on Windows) and
  // `npm.cmd` in C:\Program Files\nodejs. Resolving the bare name first gave
  // ENOENT; then running the .cmd via `shell: true` broke on the space in
  // "Program Files". Both had to be fixed for `agentobs run -- npm ...` to work.
  const code = await runWrapped(['npm', '--version'], { agentName: 'test-cmd-shim' });
  assert.equal(code, 0, 'npm.cmd should run despite the space in its path');
});
