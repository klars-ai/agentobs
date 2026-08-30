/**
 * `agentobs watch <file>` - JSONL adapter entrypoint.
 */
import { watchJsonl } from '../adapters/jsonl-watcher.js';

export interface WatchOptions {
  agent?: string;
  follow?: boolean;
}

export async function watch(file: string | undefined, opts: WatchOptions = {}): Promise<void> {
  if (!file) {
    console.error(`No file given.

  Usage:  agentobs watch <file.jsonl>

  Tails a newline-delimited JSON log and records what it describes. Each
  line is one JSON object with a "type" field:

    {"type":"session_start","session_id":"s1","agent":"my-agent"}
    {"type":"tool_call_start","session_id":"s1","id":"t1","tool":"Bash",
     "input":{"command":"npm test"}}
    {"type":"tool_call_end","id":"t1","status":"success",
     "tokens_in":1200,"tokens_out":300,"model":"claude-sonnet-4"}
    {"type":"session_end","session_id":"s1","exit_code":0}

  Examples:
    agentobs watch ./agent.jsonl
    agentobs watch ./agent.jsonl --agent my-agent --no-follow

  Unlike "agentobs run", this records full per-tool-call detail: tool
  names, inputs, tokens and cost.`);
    process.exitCode = 2;
    return;
  }

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
