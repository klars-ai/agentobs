/**
 * Route smoke tests.
 *
 * These exist because of a one-word bug that unit tests could never catch:
 * `/api/daily` ended its case with `break` where every other case used
 * `return`, so it fell through into the next route, wrote a second response,
 * and killed the whole server with ERR_HTTP_HEADERS_SENT. The query was
 * correct and every query test passed; the dashboard showed an empty tab and
 * the process was gone.
 *
 * So the assertion here is deliberately shallow and deliberately broad: hit
 * every route, twice, and require the server to still be answering afterwards.
 * A route that crashes the process fails on the next request rather than its
 * own, which is exactly why the second pass matters.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const home = mkdtempSync(join(tmpdir(), 'agentobs-routes-'));
process.env.AGENTOBS_HOME = home;

const { startDashboard } = await import('./index.js');

const ROUTES = [
  '/api/summary',
  '/api/daily',
  '/api/timeline',
  '/api/tools-breakdown',
  '/api/tool-calls',
  '/api/sessions',
  '/api/models',
  '/api/projects',
  '/api/agents',
  '/api/approvals',
  '/api/budgets',
  '/api/policy',
  '/api/health',
];

let close: () => void;
let base: string;

test.before(async () => {
  // Port 0 lets the OS pick, so the suite never collides with a dashboard the
  // developer happens to be running.
  const started = await startDashboard({ port: 0, host: '127.0.0.1' });
  close = started.close;
  base = `http://127.0.0.1:${started.port}`;
});

test.after(() => {
  close?.();
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* the OS reclaims a temp dir */
  }
});

test('every route answers with JSON on every range', async () => {
  for (const range of ['today', '7d', '30d', 'all']) {
    for (const route of ROUTES) {
      const res = await fetch(`${base}${route}?range=${range}`);
      assert.equal(res.status, 200, `${route}?range=${range} returned ${res.status}`);
      // Parsing proves the body is complete: a route that wrote twice produces
      // two concatenated JSON documents, which JSON.parse rejects.
      await res.json();
    }
  }
});

test('the server is still alive after hitting every route', async () => {
  // The real symptom of the fallthrough: the crash surfaces on the *next*
  // request, not the one that caused it.
  for (const route of ROUTES) {
    await fetch(`${base}${route}?range=30d`).catch(() => undefined);
  }

  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200, 'server died while serving the routes above');
});

test('an unknown route is a clean 404, not a crash', async () => {
  const res = await fetch(`${base}/api/does-not-exist`);
  assert.equal(res.status, 404);

  const after = await fetch(`${base}/api/health`);
  assert.equal(after.status, 200, 'a 404 must not take the server down');
});
