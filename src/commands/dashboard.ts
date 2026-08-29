/**
 * `agentobs dashboard` - serves the local UI.
 */
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { isLoopback, startDashboard } from '../server/index.js';

export interface DashboardOptions {
  port: string | number;
  host: string;
  token?: string;
  open?: boolean;
}

export async function dashboard(opts: DashboardOptions): Promise<void> {
  const port = Number(opts.port) || 4300;
  const host = opts.host || '127.0.0.1';
  const loopback = isLoopback(host);

  // Binding beyond loopback exposes tool inputs and file paths to the local
  // network, so it always requires a token. One is minted rather than
  // refusing outright, because sharing a dashboard on a trusted LAN is a
  // legitimate thing to want.
  const token = loopback ? null : (opts.token ?? randomBytes(16).toString('hex'));

  const { port: actual } = await startDashboard({ port, host, token });
  const url = `http://${loopback ? '127.0.0.1' : host}:${actual}${token ? `?token=${token}` : ''}`;

  console.log(`AgentObs dashboard: ${url}`);
  if (!loopback) {
    console.log(`
  Bound to ${host} - reachable from your network.
  A token is required; it is already in the URL above.
  Never expose this to the public internet.`);
  }
  console.log('\nPress Ctrl-C to stop.');

  if (opts.open !== false) openBrowser(url);
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    // Detached and unref'd so the browser process never keeps the server
    // alive, and a headless box without a browser fails silently rather than
    // taking the dashboard down with it.
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* no browser available - the URL is printed above */
  }
}
