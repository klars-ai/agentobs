/**
 * Tests for outbound webhooks.
 *
 * Two of these matter more than the rest. The URL test guards a real leak:
 * a Slack webhook carries its secret in the path, so allowing plain http to a
 * remote host would put that secret on the wire in clear text. The redaction
 * test guards the other direction - that a payload built from an agent's
 * activity cannot carry a key out to a third party.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  budgetExceededEvent,
  isSendableUrl,
  loadNotifyConfig,
  sendWebhook,
  type NotifyConfig,
} from './webhook.js';

test('https is allowed; plain http to a remote host is refused', () => {
  assert.equal(isSendableUrl('https://hooks.slack.com/services/T00/B00/xxxx'), true);
  assert.equal(isSendableUrl('https://example.com/hook'), true);

  // The secret lives in the path of a Slack webhook, so clear text is a leak.
  assert.equal(isSendableUrl('http://example.com/hook'), false);
  assert.equal(isSendableUrl('http://hooks.slack.com/services/T00/B00/xxxx'), false);

  // Loopback is fine: a local receiver is a legitimate bridge to a notifier.
  assert.equal(isSendableUrl('http://localhost:4599/hook'), true);
  assert.equal(isSendableUrl('http://127.0.0.1:4599/hook'), true);

  // Anything that is not http(s) cannot be posted to at all.
  assert.equal(isSendableUrl('file:///etc/passwd'), false);
  assert.equal(isSendableUrl('ftp://example.com/x'), false);
  assert.equal(isSendableUrl('not a url'), false);
});

test('config is absent, malformed, or empty -> notifications stay off', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentobs-notify-'));
  try {
    const file = join(dir, 'notify.json');

    // Nothing configured is the default state and must never send.
    assert.equal(loadNotifyConfig(file), null);

    // A stray comma must not throw inside the hook path.
    writeFileSync(file, '{ "targets": [ }', 'utf8');
    assert.equal(loadNotifyConfig(file), null);

    // A config whose only target is unusable is the same as no config.
    writeFileSync(file, JSON.stringify({ targets: [{ url: 'http://evil.example.com/x' }] }), 'utf8');
    assert.equal(loadNotifyConfig(file), null);

    // Explicitly disabled targets are filtered out too.
    writeFileSync(
      file,
      JSON.stringify({ targets: [{ url: 'https://example.com/x', enabled: false }] }),
      'utf8',
    );
    assert.equal(loadNotifyConfig(file), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a small limit is not reported as $0.00', () => {
  const event = budgetExceededEvent({
    name: 'daily',
    period: 'daily',
    spent: 5,
    limit: 0.0001,
    unit: 'usd',
    action: 'block',
  });
  // "$0.00 of $0.00" would read as a bug rather than a very small limit.
  assert.match(event.title, /\$5\.00 of \$0\.00010/);
  assert.ok(!/of \$0\.00\b/.test(event.title), event.title);
});

test('token budgets are described in tokens, not dollars', () => {
  const event = budgetExceededEvent({
    name: 'block5h',
    period: 'block5h',
    spent: 250_000,
    limit: 200_000,
    unit: 'tokens',
    action: 'warn',
  });
  assert.match(event.title, /250K tokens of 200K tokens/);
  assert.ok(!event.title.includes('$'), event.title);
});

/** Starts a throwaway receiver and returns what it was posted. */
async function withReceiver(
  run: (url: string, received: string[]) => Promise<void>,
): Promise<void> {
  const received: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push(body);
      res.writeHead(200);
      res.end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await run(`http://127.0.0.1:${port}/hook`, received);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('secrets in an event never reach the endpoint', async () => {
  await withReceiver(async (url, received) => {
    const config: NotifyConfig = {
      targets: [{ url, format: 'json' }],
      events: ['call_blocked'],
      timeoutMs: 2_000,
    };

    const delivered = await sendWebhook(
      {
        kind: 'call_blocked',
        title: 'AgentObs: call blocked',
        detail: 'Authorization: Bearer sk-ant-api03-REALSECRETVALUE0123456789',
      },
      config,
    );

    assert.equal(delivered, 1);
    assert.equal(received.length, 1);
    assert.ok(!received[0].includes('REALSECRETVALUE'), 'secret reached the endpoint');
    assert.match(received[0], /REDACTED/);
  });
});

test('only requested event kinds are sent', async () => {
  await withReceiver(async (url, received) => {
    const config: NotifyConfig = {
      targets: [{ url, format: 'json' }],
      events: ['budget_exceeded'],
      timeoutMs: 2_000,
    };

    // Not in `events`, so nothing should go out.
    const skipped = await sendWebhook({ kind: 'call_blocked', title: 'nope' }, config);
    assert.equal(skipped, 0);
    assert.equal(received.length, 0);

    const sent = await sendWebhook({ kind: 'budget_exceeded', title: 'yes' }, config);
    assert.equal(sent, 1);
    assert.equal(received.length, 1);
  });
});

test('slack format posts a bare {text}, which Discord also accepts', async () => {
  await withReceiver(async (url, received) => {
    await sendWebhook(
      { kind: 'budget_exceeded', title: 'Limit reached', detail: 'Calls are blocked.' },
      { targets: [{ url, format: 'slack' }], events: ['budget_exceeded'], timeoutMs: 2_000 },
    );
    const body = JSON.parse(received[0]) as { text: string };
    assert.equal(body.text, 'Limit reached\nCalls are blocked.');
  });
});

test('an unreachable endpoint resolves 0 rather than throwing', async () => {
  // The caller is a hook that has already made its decision; a dead endpoint
  // must not become an exception in the agent's path.
  const delivered = await sendWebhook(
    { kind: 'budget_exceeded', title: 'x' },
    {
      // Port 1 is reserved and refuses immediately.
      targets: [{ url: 'http://127.0.0.1:1/hook' }],
      events: ['budget_exceeded'],
      timeoutMs: 500,
    },
  );
  assert.equal(delivered, 0);
});

test('a hanging endpoint is abandoned at the timeout', async () => {
  const server = createServer(() => {
    /* accept the request and never answer */
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  try {
    const started = Date.now();
    const delivered = await sendWebhook(
      { kind: 'budget_exceeded', title: 'x' },
      { targets: [{ url: `http://127.0.0.1:${port}/hook` }], events: ['budget_exceeded'], timeoutMs: 300 },
    );
    const elapsed = Date.now() - started;

    assert.equal(delivered, 0);
    // Generous upper bound: the point is that it returns, not that it is fast.
    assert.ok(elapsed < 3_000, `took ${elapsed}ms, so the timeout did not fire`);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
