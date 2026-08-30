import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'agentobs-daemon-'));
process.env.AGENTOBS_HOME = home;

const { serve, request, isRunning, socketPath } = await import('./daemon.js');

test.after(() => rmSync(home, { recursive: true, force: true }));

test('returns null when no daemon is listening, rather than throwing', async () => {
  // Every hot path falls back to doing the work in-process, so a missing
  // daemon must be a null - never an exception that breaks the status bar.
  assert.equal(await request({ op: 'ping' }, 150), null);
  assert.equal(await isRunning(), false);
});

test('serves requests and echoes handler results', async () => {
  let stop: (() => void) | undefined;
  const running = serve(
    {
      double: (req) => ({ value: Number(req.args?.n ?? 0) * 2 }),
    },
    {
      idleTimeoutMs: 0,
      onListening: () => {
        stop = () => process.emit('SIGTERM');
      },
    },
  );

  // Give the listener a moment to bind.
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(await isRunning(), true, 'ping should answer once listening');

  const result = (await request({ op: 'double', args: { n: 21 } })) as { value: number };
  assert.equal(result.value, 42);

  const unknown = (await request({ op: 'nope' })) as { error: string };
  assert.match(unknown.error, /unknown op/);

  stop?.();
  await running;
});

test('a handler that throws does not take the daemon down', async () => {
  let stop: (() => void) | undefined;
  const running = serve(
    {
      boom: () => {
        throw new Error('handler exploded');
      },
      ok: () => ({ fine: true }),
    },
    { idleTimeoutMs: 0, onListening: () => (stop = () => process.emit('SIGTERM')) },
  );
  await new Promise((r) => setTimeout(r, 150));

  const failed = (await request({ op: 'boom' })) as { error: string };
  assert.match(failed.error, /exploded/);

  // The daemon serves other clients after one bad request.
  const after = (await request({ op: 'ok' })) as { fine: boolean };
  assert.equal(after.fine, true, 'daemon should survive a throwing handler');

  stop?.();
  await running;
});

test('the socket path is derived from AGENTOBS_HOME', () => {
  // Two homes must never share a daemon, or one project's budgets would be
  // reported against another's database.
  const first = socketPath();
  process.env.AGENTOBS_HOME = join(home, 'other');
  const second = socketPath();
  process.env.AGENTOBS_HOME = home;
  assert.notEqual(first, second);
});
