/**
 * Container entrypoint for the hosted deployment (Dockerfile / docker-compose).
 *
 * Distinct from `agentobs dashboard`, which is the local single-user server:
 * this binds 0.0.0.0 because it sits behind Caddy inside a container network,
 * and it reads configuration from the environment rather than CLI flags.
 *
 * Note it currently serves the same local-first dashboard against the
 * container's own SQLite file. The team/account layer that uses DATABASE_URL
 * is not built yet - see docs/ROADMAP.md - so this deploys as a working
 * single-tenant instance rather than pretending to a multi-tenant one.
 */
import { startDashboard } from './index.js';

const port = Number(process.env.PORT ?? 8080);
// 0.0.0.0 is correct here and only here: the container is not directly
// exposed, Caddy terminates TLS in front of it, and the compose file never
// publishes this port to the host.
const host = process.env.HOST ?? '0.0.0.0';

// A token is always required on a non-loopback bind. Fail at startup rather
// than booting a server that answers every request with 401: a silently
// unauthorized container looks like a broken deploy, and the operator would
// have no hint that the missing variable is the cause.
const token = process.env.AGENTOBS_DASHBOARD_TOKEN ?? null;
if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && !token) {
  console.error(
    `agentobs: refusing to start on ${host} without AGENTOBS_DASHBOARD_TOKEN.\n` +
      `This server would be reachable beyond loopback, so a token is required.\n` +
      `Generate one with:  openssl rand -hex 32\n` +
      `Then set AGENTOBS_DASHBOARD_TOKEN in the deployment .env.`,
  );
  process.exit(1);
}

const { port: actual } = await startDashboard({ port, host, token });
console.log(`agentobs server listening on ${host}:${actual}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`received ${signal}, shutting down`);
    process.exit(0);
  });
}
