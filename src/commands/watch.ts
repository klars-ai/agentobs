/**
 * `agentobs watch <file>` - JSONL adapter entrypoint.
 */
import { watchJsonl } from '../adapters/jsonl-watcher.js';

export interface WatchOptions {
  agent?: string;
  follow?: boolean;
}

export async function watch(file: string, opts: WatchOptions = {}): Promise<void> {
  let seen = 0;
  console.log(`Watching ${file} (agent: ${opts.agent ?? 'generic'}) — Ctrl-C to stop.`);
  await watchJsonl(file, {
    agentName: opts.agent,
    follow: opts.follow !== false,
    onEvent: () => {
      seen += 1;
      // Rewrite one line rather than scrolling: this runs in the foreground
      // for the length of a session.
      process.stdout.write(`\r  ${seen} event(s) ingested`);
    },
  });
  process.stdout.write('\n');
}
