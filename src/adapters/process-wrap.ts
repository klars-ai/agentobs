/**
 * Process-wrap adapter: `agentobs run -- <command...>`.
 *
 * The universal fallback. It works with any agent CLI - present or future,
 * instrumented or not - because it observes the process rather than the
 * agent. What it gets in exchange for that generality is coarse data:
 * start, end, duration, exit code, and nothing about individual tool calls.
 *
 * That limit is recorded as fidelity='coarse' and shown in the dashboard, so
 * a coarse session is never mistaken for a detailed one.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent } from './types.js';
import { createSink } from './sink.js';

export interface RunOptions {
  /** Recorded as sessions.agent_name; defaults to the executable's name. */
  agentName?: string;
  cwd?: string;
}

/** Best-effort current git branch; null outside a repo. */
function currentBranch(cwd: string): string | null {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: 1000,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Runs a command under observation, returning its exit code.
 *
 * stdio is inherited so the wrapped agent stays fully interactive - the user
 * should not be able to tell AgentObs is in the middle. That is also why we
 * never buffer or parse the output here.
 */
export async function runWrapped(command: string[], opts: RunOptions = {}): Promise<number> {
  if (command.length === 0) throw new Error('no command given to run');

  const cwd = opts.cwd ?? process.cwd();
  const agentName = opts.agentName ?? command[0].replace(/\.(exe|cmd|bat)$/i, '');
  const sessionId = randomUUID();
  const sink = createSink(agentName);

  sink({
    type: 'session_start',
    sessionId,
    agentName,
    cwd,
    gitBranch: currentBranch(cwd),
    fidelity: 'coarse',
  } satisfies AgentEvent);

  return new Promise<number>((resolve) => {
    // On Windows, resolve the executable ourselves rather than reaching for
    // `shell: true`. Under a shell, arguments are concatenated instead of
    // escaped (Node DEP0190), so any argument containing a space or a quote
    // is silently mangled before the wrapped agent ever sees it - which for
    // an agent CLI means a corrupted prompt.
    //
    // Resolving the .cmd/.bat shim directly keeps npm-installed CLIs working
    // (`agentobs run -- claude`) while spawn still escapes each argument.
    const executable = process.platform === 'win32' ? resolveWindowsExecutable(command[0]) : command[0];

    const child = spawn(executable, command.slice(1), {
      cwd,
      stdio: 'inherit',
      // A .cmd shim is a batch script, so it does need a shell interpreter -
      // but only for the shim itself, and cmd.exe applies its own escaping.
      shell: /\.(cmd|bat)$/i.test(executable),
      windowsHide: true,
    });

    const finish = (code: number): void => {
      sink({ type: 'session_end', sessionId, exitCode: code } satisfies AgentEvent);
      resolve(code);
    };

    child.on('error', (err) => {
      // Spawn failure (command not found) - record it as a failed session
      // rather than losing the attempt entirely.
      console.error(`[agentobs] failed to start ${command[0]}: ${err.message}`);
      finish(127);
    });

    child.on('close', (code, signal) => {
      // A signal-terminated process reports code=null; map it to the shell
      // convention (128 + signal number) so the stored value is never null
      // for a run that genuinely ended.
      if (code === null && signal) {
        finish(128 + (signalNumber(signal) ?? 0));
        return;
      }
      finish(code ?? 0);
    });

    // Forward interrupts so Ctrl-C reaches the agent rather than only
    // killing the wrapper and orphaning it.
    for (const sig of ['SIGINT', 'SIGTERM'] as const) {
      process.on(sig, () => {
        if (!child.killed) child.kill(sig);
      });
    }
  });
}

/**
 * Finds the real file behind a bare command name on Windows.
 *
 * Windows has no execvp: `spawn("npm")` fails because the thing on PATH is
 * `npm.cmd`, not `npm`. The usual workaround is `shell: true`, but that
 * disables argument escaping (see the call site). Walking PATH + PATHEXT
 * ourselves keeps both properties: bare names resolve, and arguments stay
 * escaped.
 *
 * Falls back to the original name when nothing matches, so spawn produces its
 * normal ENOENT rather than this function inventing a different failure.
 */
function resolveWindowsExecutable(command: string): string {
  if (command.includes('/') || command.includes('\\')) return command;

  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const dirs = (process.env.PATH ?? '').split(';').filter(Boolean);

  for (const dir of dirs) {
    for (const ext of ['', ...exts]) {
      const candidate = join(dir, command + ext.toLowerCase());
      if (existsSync(candidate)) return candidate;
      const upper = join(dir, command + ext);
      if (existsSync(upper)) return upper;
    }
  }
  return command;
}

function signalNumber(signal: NodeJS.Signals): number | null {
  const table: Partial<Record<NodeJS.Signals, number>> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGKILL: 9,
    SIGTERM: 15,
  };
  return table[signal] ?? null;
}
