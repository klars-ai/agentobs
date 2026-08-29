/**
 * `agentobs run -- <command...>` - process-wrap adapter entrypoint.
 */
import { runWrapped } from '../adapters/process-wrap.js';

export interface RunOptions {
  agent?: string;
}

export async function run(command: string[], opts: RunOptions = {}): Promise<void> {
  if (command.length === 0) {
    console.error('Nothing to run. Usage: agentobs run -- <command> [args...]');
    process.exitCode = 2;
    return;
  }
  const code = await runWrapped(command, { agentName: opts.agent });
  // Pass the wrapped process's exit code straight through, so wrapping a
  // command inside a script or CI job never changes whether it "passed".
  process.exitCode = code;
}
