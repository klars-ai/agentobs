/**
 * Generic JSONL adapter: `agentobs watch <file>`.
 *
 * Tails a newline-delimited JSON log and maps each line to an AgentEvent.
 * This is the integration path for any agent that can be made to write a
 * structured log but has no hook system, and it is also how a user can pipe
 * a custom or in-house agent into AgentObs without writing TypeScript.
 *
 * Field names are matched leniently (snake_case and camelCase, several
 * common aliases) because the whole point is ingesting logs this project
 * does not control.
 */
import { createReadStream, existsSync, statSync, watch } from 'node:fs';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { AgentEvent } from './types.js';
import { createSink } from './sink.js';

type Row = Record<string, unknown>;

const str = (row: Row, ...keys: string[]): string | null => {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'string' && v) return v;
  }
  return null;
};

const num = (row: Row, ...keys: string[]): number | null => {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
};

/**
 * Maps one JSONL row to an AgentEvent, or null if it isn't one we recognise.
 *
 * Unrecognised lines are skipped silently rather than treated as errors: a
 * real agent log interleaves many record types, and warning on each would
 * bury the user in noise for lines that are simply not ours.
 */
export function parseLine(line: string, fallbackSession: string, agentName: string): AgentEvent | null {
  let row: Row;
  try {
    row = JSON.parse(line) as Row;
  } catch {
    return null;
  }
  if (!row || typeof row !== 'object') return null;

  const type = str(row, 'type', 'event', 'event_type', 'eventType');
  const sessionId = str(row, 'session_id', 'sessionId', 'session') ?? fallbackSession;
  const timestamp = str(row, 'timestamp', 'time', 'ts', 'started_at') ?? undefined;

  switch (type) {
    case 'session_start':
    case 'session-start':
    case 'start':
      return {
        type: 'session_start',
        sessionId,
        agentName: str(row, 'agent', 'agent_name', 'agentName') ?? agentName,
        cwd: str(row, 'cwd', 'working_dir', 'workingDirectory'),
        fidelity: 'rich',
        timestamp,
      };

    case 'session_end':
    case 'session-end':
    case 'end':
      return {
        type: 'session_end',
        sessionId,
        exitCode: num(row, 'exit_code', 'exitCode'),
        timestamp,
      };

    case 'tool_call':
    case 'tool_use':
    case 'tool': {
      // A single complete tool-call record: synthesise the start/end pair so
      // downstream code only ever deals with one shape.
      const id = str(row, 'id', 'tool_call_id', 'toolCallId') ?? randomUUID();
      return {
        type: 'tool_call_start',
        sessionId,
        toolCallId: id,
        toolName: str(row, 'tool', 'tool_name', 'toolName', 'name') ?? 'unknown',
        input: row.input ?? row.tool_input ?? row.arguments ?? null,
        model: str(row, 'model'),
        timestamp,
      };
    }

    case 'tool_call_start':
    case 'tool_start':
      return {
        type: 'tool_call_start',
        sessionId,
        toolCallId: str(row, 'id', 'tool_call_id', 'toolCallId') ?? randomUUID(),
        toolName: str(row, 'tool', 'tool_name', 'toolName', 'name') ?? 'unknown',
        input: row.input ?? row.tool_input ?? row.arguments ?? null,
        model: str(row, 'model'),
        timestamp,
      };

    case 'tool_call_end':
    case 'tool_end':
    case 'tool_result': {
      const status = str(row, 'status', 'result');
      return {
        type: 'tool_call_end',
        toolCallId: str(row, 'id', 'tool_call_id', 'toolCallId') ?? '',
        status: status === 'error' || row.error ? 'error' : 'success',
        output: row.output ?? row.result ?? row.tool_response ?? null,
        tokensIn: num(row, 'tokens_in', 'tokensIn', 'input_tokens', 'prompt_tokens'),
        tokensOut: num(row, 'tokens_out', 'tokensOut', 'output_tokens', 'completion_tokens'),
        model: str(row, 'model'),
        errorMessage: str(row, 'error', 'error_message', 'errorMessage'),
        timestamp,
      };
    }

    default:
      return null;
  }
}

export interface WatchOptions {
  agentName?: string;
  /** Read the whole file first, then follow. Default true. */
  fromStart?: boolean;
  /** Keep following after EOF (tail -f). Default true. */
  follow?: boolean;
  onEvent?: (event: AgentEvent) => void;
}

/**
 * Tails a JSONL file, feeding parsed events into the local database.
 *
 * Tracks a byte offset and re-reads only what was appended. A file that
 * shrinks is treated as truncated/rotated and re-read from zero, which is
 * the behaviour a user expects from `tail -F` and avoids silently emitting
 * garbage from a stale offset.
 */
export async function watchJsonl(file: string, opts: WatchOptions = {}): Promise<void> {
  const agentName = opts.agentName ?? 'generic';
  const follow = opts.follow ?? true;
  const sink = createSink(agentName);
  const fallbackSession = randomUUID();

  if (!existsSync(file)) throw new Error(`file not found: ${file}`);

  let offset = opts.fromStart === false ? statSync(file).size : 0;
  let reading = false;

  const drain = async (): Promise<void> => {
    if (reading) return; // a watch event during a read would double-process
    reading = true;
    try {
      const size = statSync(file).size;
      if (size < offset) offset = 0; // truncated or rotated
      if (size === offset) return;

      const stream = createReadStream(file, { start: offset, encoding: 'utf8' });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.trim()) continue;
        const event = parseLine(line, fallbackSession, agentName);
        if (event) {
          sink(event);
          opts.onEvent?.(event);
        }
      }
      offset = size;
    } finally {
      reading = false;
    }
  };

  await drain();
  if (!follow) return;

  const watcher = watch(file, { persistent: true }, () => {
    void drain();
  });

  // Poll as well as watch: fs.watch misses appends on some filesystems
  // (network shares, certain Docker mounts) where the tool is likely to be
  // pointed at a log written by another container.
  const poll = setInterval(() => void drain(), 2000);

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      watcher.close();
      clearInterval(poll);
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}
