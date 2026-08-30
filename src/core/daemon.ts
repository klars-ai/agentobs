/**
 * Background daemon - the answer to Node's startup cost.
 *
 * Measured on a Windows machine: AgentObs's own work for a statusline render
 * is 0.10ms, but `node -e 0` alone costs ~1700ms because antivirus scans the
 * binary on every spawn. So 99.2% of the time went to starting Node, not to
 * anything this tool does. Rewriting the logic in a faster language would
 * optimise the 0.10ms and leave the 1700ms untouched.
 *
 * The fix is to stop starting Node repeatedly: one long-lived process holds
 * the database open, and hot paths (statusline, hook) become a socket write
 * plus a read. That is the same shape as ccusage's prebuilt binary - avoid
 * the runtime boot - reached without cross-compiling to six targets.
 *
 * Transport is a Unix socket / Windows named pipe: no port to collide, no
 * network surface, and OS-level permissions rather than a token.
 */
import { createServer, connect, type Socket } from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { agentobsHome } from './paths.js';

/**
 * Socket path, derived from AGENTOBS_HOME so two homes never share a daemon.
 *
 * Windows named pipes live in a global namespace and cannot be a filesystem
 * path; POSIX puts the socket in tmp rather than the home directory so a
 * synced or networked home does not carry a stale socket between machines.
 */
export function socketPath(): string {
  const key = createHash('sha256').update(agentobsHome()).digest('hex').slice(0, 12);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\agentobs-${key}`
    : join(tmpdir(), `agentobs-${key}.sock`);
}

export interface DaemonRequest {
  op: string;
  args?: Record<string, unknown>;
}

export type Handler = (req: DaemonRequest) => unknown;

/**
 * Sends one request to a running daemon.
 *
 * Returns null - rather than throwing - when no daemon is listening, so every
 * caller can fall back to doing the work in-process. A hot path must never
 * fail just because the daemon is not running.
 */
export function request(req: DaemonRequest, timeoutMs = 250): Promise<unknown | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: unknown | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let socket: Socket;
    try {
      socket = connect(socketPath());
    } catch {
      done(null);
      return;
    }

    // A hung daemon must not hang the status bar; fall back instead.
    const timer = setTimeout(() => {
      socket.destroy();
      done(null);
    }, timeoutMs);

    let buffer = '';
    socket.on('connect', () => socket.write(`${JSON.stringify(req)}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const index = buffer.indexOf('\n');
      if (index < 0) return;
      clearTimeout(timer);
      socket.end();
      try {
        done(JSON.parse(buffer.slice(0, index)));
      } catch {
        done(null);
      }
    });
    socket.on('error', () => {
      clearTimeout(timer);
      done(null);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      done(null);
    });
  });
}

/** True when a daemon is answering on this home's socket. */
export async function isRunning(): Promise<boolean> {
  return (await request({ op: 'ping' }, 200)) !== null;
}

export interface DaemonOptions {
  /** Exit after this long with no requests. 0 disables the timeout. */
  idleTimeoutMs?: number;
  onListening?: (path: string) => void;
}

/**
 * Starts the daemon. Resolves when it stops.
 *
 * Handlers run synchronously against an already-open database, which is what
 * makes a request ~0.1ms instead of ~1700ms.
 */
export function serve(handlers: Record<string, Handler>, opts: DaemonOptions = {}): Promise<void> {
  const path = socketPath();

  // A stale socket file survives a crash on POSIX and blocks binding. Windows
  // named pipes are reference-counted by the OS, so there is nothing to clean.
  if (process.platform !== 'win32' && existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      /* another daemon may hold it - listen() will report the real error */
    }
  }

  return new Promise((resolve, reject) => {
    let idleTimer: NodeJS.Timeout | undefined;
    const resetIdle = (): void => {
      if (!opts.idleTimeoutMs) return;
      clearTimeout(idleTimer);
      // Idle-exit keeps a forgotten daemon from living forever; the client
      // starts a new one on demand, so the user never notices.
      idleTimer = setTimeout(() => server.close(), opts.idleTimeoutMs);
    };

    const server = createServer((socket) => {
      resetIdle();
      let buffer = '';

      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let index: number;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line) continue;

          let response: unknown;
          try {
            const req = JSON.parse(line) as DaemonRequest;
            const handler = req.op === 'ping' ? () => ({ ok: true }) : handlers[req.op];
            response = handler ? handler(req) : { error: `unknown op: ${req.op}` };
          } catch (err) {
            // One bad request must not take the daemon down for everyone.
            response = { error: (err as Error).message };
          }
          socket.write(`${JSON.stringify(response)}\n`);
        }
      });

      socket.on('error', () => {
        /* client vanished mid-request - nothing to do */
      });
    });

    server.on('error', reject);
    server.on('close', () => {
      clearTimeout(idleTimer);
      resolve();
    });

    server.listen(path, () => {
      resetIdle();
      opts.onListening?.(path);
    });

    for (const sig of ['SIGINT', 'SIGTERM'] as const) {
      process.on(sig, () => server.close());
    }
  });
}
