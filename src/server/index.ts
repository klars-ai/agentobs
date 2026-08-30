/**
 * Local dashboard server.
 *
 * Uses node:http directly rather than express/fastify: the routing surface is
 * a handful of GET endpoints, and a zero-dependency server keeps `npx
 * agentobs` install-fast and shrinks the supply-chain surface of a tool that
 * reads a developer's activity.
 *
 * Security posture: binds 127.0.0.1 by default, where same-machine access is
 * the same trust boundary as the database file itself. Binding anywhere else
 * requires a token (see requireToken), because the dashboard exposes tool
 * inputs and file paths across the network.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../core/db.js';
import {
  getPolicyDecisions,
  getRecentToolCalls,
  getModels,
  getProjects,
  getSessionDetail,
  getSessions,
  getSparklines,
  getSummary,
  getTimeline,
  getToolsBreakdown,
  type Range,
} from '../core/queries.js';
import { loadPolicy } from '../core/policy-engine.js';
import { checkBudgets } from '../core/budget.js';
import { costCaveat, costLabel, detectPlan } from '../core/plan.js';
import { listApprovals } from '../core/approvals.js';
import { allSources, discover } from '../adapters/agent-sources.js';
import { agentobsHome } from '../core/paths.js';
import { forecastBudget } from '../core/forecast.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export interface ServerOptions {
  port: number;
  host: string;
  /** Required when host is not loopback. */
  token?: string | null;
  db?: DatabaseSync;
}

function parseRange(value: string | null): Range {
  return value === 'today' || value === '7d' || value === '30d' || value === 'all' ? value : '7d';
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    // The dashboard renders tool inputs; never let a browser cache or a
    // proxy hold on to them.
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
}

export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/**
 * Constant-time token comparison.
 *
 * A plain `===` leaks the token's prefix through timing. That matters here
 * precisely because the non-loopback mode is the one exposed to a network.
 */
function tokenMatches(expected: string, provided: string | null): boolean {
  if (!provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createDashboardServer(opts: ServerOptions) {
  const db = opts.db ?? openDb();
  const requireToken = !isLoopback(opts.host);

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        json(res, { error: 'method not allowed' }, 405);
        return;
      }

      if (requireToken) {
        const supplied =
          url.searchParams.get('token') ??
          (req.headers.authorization?.startsWith('Bearer ')
            ? req.headers.authorization.slice(7)
            : null);
        if (!opts.token || !tokenMatches(opts.token, supplied)) {
          json(res, { error: 'unauthorized: pass ?token=<value> printed at startup' }, 401);
          return;
        }
      }

      const range = parseRange(url.searchParams.get('range'));

      switch (url.pathname) {
        case '/api/summary':
          // Sparklines ride along with the summary: the tiles need both, and
          // one request keeps the 5s poll to a single round trip.
          // The plan travels with the summary so the UI can label a cost
          // figure that is a list-price equivalent rather than a bill.
          json(res, {
            ...getSummary(db, range),
            sparklines: getSparklines(db, range),
            plan: detectPlan(),
            cost_caveat: costCaveat(),
            cost_label: costLabel(),
          });
          return;
        case '/api/timeline':
          json(res, getTimeline(db, range));
          return;
        case '/api/tools-breakdown':
          json(res, getToolsBreakdown(db, range));
          return;
        case '/api/tool-calls':
          json(res, {
            calls: getRecentToolCalls(db, {
              range,
              limit: Number(url.searchParams.get('limit') ?? 50),
              status: url.searchParams.get('status') ?? undefined,
              sessionId: url.searchParams.get('session') ?? undefined,
            }),
          });
          return;
        case '/api/sessions':
          json(res, {
            sessions: getSessions(db, {
              range,
              limit: Number(url.searchParams.get('limit') ?? 50),
            }),
          });
          return;
        case '/api/models':
          json(res, { models: getModels(db, range) });
          return;
        case '/api/agents': {
          const sources = allSources(join(agentobsHome(), 'sources.json'));
          json(res, {
            agents: sources.map((s) => {
              const files = discover(s);
              return {
                id: s.id,
                label: s.label,
                status: s.status,
                files: files.length,
                newest: files[0]?.modifiedAt ?? null,
              };
            }),
          });
          return;
        }
        case '/api/approvals':
          json(res, { approvals: listApprovals(db, { state: 'pending' }) });
          return;
        case '/api/projects':
          json(res, { projects: getProjects(db, range) });
          return;
        case '/api/session': {
          const id = url.searchParams.get('id');
          if (!id) {
            json(res, { error: 'missing id' }, 400);
            return;
          }
          json(res, getSessionDetail(db, id));
          return;
        }
        case '/api/budgets': {
          const statuses = checkBudgets(db, { record: false });
          json(res, {
            budgets: statuses.map((status) => ({
              ...status,
              forecast: forecastBudget(db, status),
            })),
          });
          return;
        }
        case '/api/policy':
          json(res, {
            ...loadPolicy(),
            decisions: getPolicyDecisions(db, { limit: 100 }),
          });
          return;
        case '/api/health':
          json(res, { ok: true, version: 1 });
          return;
      }

      await serveStatic(url.pathname, res);
    } catch (err) {
      json(res, { error: (err as Error).message }, 500);
    }
  });
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  // normalize + prefix check keeps a crafted "../.." from escaping the
  // public directory and serving arbitrary files off the user's disk.
  const target = normalize(join(PUBLIC_DIR, rel));
  if (!target.startsWith(PUBLIC_DIR) || !existsSync(target)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  const body = await readFile(target);
  res.writeHead(200, {
    'Content-Type': MIME[extname(target)] ?? 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

export function startDashboard(opts: ServerOptions): Promise<{ port: number; close: () => void }> {
  const server = createDashboardServer(opts);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : opts.port;
      resolve({ port, close: () => server.close() });
    });
  });
}
