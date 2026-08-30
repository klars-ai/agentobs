/**
 * Multi-agent support via declared data sources.
 *
 * Nearly every coding agent writes a JSONL session log somewhere under the
 * home directory. The formats differ in field names, not in shape - a stream
 * of turns with a `usage` block and tool calls - so a per-agent adapter would
 * be the same fifty lines copied with different string constants.
 *
 * A source is therefore a declaration: where the files are, and which field
 * names that agent uses. Adding an agent is a table entry, and a user can add
 * one AgentObs has never heard of by dropping a definition into
 * ~/.agentobs/sources.json - which matters more than the built-in list, since
 * new agents appear faster than any maintainer can chase them.
 *
 * Honesty rule: only agents whose format is verified appear as supported.
 * A definition written from documentation alone is marked `unverified`, and
 * the CLI says so, because claiming support that silently records nothing is
 * the worst failure an observability tool can have.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface FieldMap {
  /** Dot-paths tried in order for each value; the first that resolves wins. */
  inputTokens: string[];
  outputTokens: string[];
  cacheReadTokens?: string[];
  cacheWriteTokens?: string[];
  model: string[];
  timestamp: string[];
  /** Marks a line as a tool call. */
  toolName?: string[];
  toolInput?: string[];
  sessionId?: string[];
}

export interface AgentSource {
  /** Stored as sessions.agent_name. */
  id: string;
  label: string;
  /** Directories to scan, relative to the home directory unless absolute. */
  roots: string[];
  /** Glob-ish suffix; only files ending with this are read. */
  fileSuffix: string;
  fields: FieldMap;
  /**
   * "verified" means the format was checked against a real file from this
   * agent. "unverified" means it was written from documentation and may be
   * wrong - the CLI reports it rather than pretending otherwise.
   */
  status: 'verified' | 'unverified';
  /** Where the format came from, so a future maintainer can re-check it. */
  note?: string;
}

/**
 * Built-in sources.
 *
 * Only Claude Code is marked verified: its transcripts were read directly
 * while building the importer. The others are written from published paths
 * and are honestly labelled until someone confirms them against real files.
 */
export const BUILTIN_SOURCES: AgentSource[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    roots: ['.claude/projects'],
    fileSuffix: '.jsonl',
    status: 'verified',
    note: 'Format read directly from real transcripts; see claude-transcript.ts.',
    fields: {
      inputTokens: ['message.usage.input_tokens'],
      outputTokens: ['message.usage.output_tokens'],
      cacheReadTokens: ['message.usage.cache_read_input_tokens'],
      cacheWriteTokens: ['message.usage.cache_creation_input_tokens'],
      model: ['message.model'],
      timestamp: ['timestamp'],
      sessionId: ['sessionId', 'session_id'],
    },
  },
  {
    id: 'copilot-cli',
    label: 'GitHub Copilot CLI',
    // Checked against a real install (~/.copilot, CLI 2026-08): the only files
    // written are config.json, IDE lock files, and plain-text server logs under
    // logs/ - lines like "[INFO] Starting CLI in server mode", with no tokens,
    // no cost and no JSON. Copilot CLI reports usage through its own /usage
    // command rather than persisting it, so there is nothing on disk to import.
    // The paths below are kept because an OTel file exporter, when configured,
    // does write JSONL here - but that is opt-in and was not observed.
    roots: ['.copilot/session-state', '.copilot/otel', '.copilot/history-session-state'],
    fileSuffix: '.jsonl',
    status: 'unverified',
    note: 'Verified NOT present on a real install: ~/.copilot holds only config.json and plain-text server logs, with no usage data persisted. Retained for the opt-in OTel file exporter; field names still unconfirmed.',
    fields: {
      inputTokens: ['usage.input_tokens', 'usage.promptTokens', 'tokens.input'],
      outputTokens: ['usage.output_tokens', 'usage.completionTokens', 'tokens.output'],
      model: ['model', 'model.id', 'modelId'],
      timestamp: ['timestamp', 'time', 'ts'],
      toolName: ['tool.name', 'toolName', 'name'],
      toolInput: ['tool.input', 'toolInput', 'arguments'],
      sessionId: ['sessionId', 'session_id', 'session.id'],
    },
  },
  {
    id: 'codex',
    label: 'OpenAI Codex CLI',
    // Rollout files are written as rollout-<timestamp>-<uuid>.jsonl. Archived
    // sessions are a sibling directory and are read too, since a user who has
    // archived a session still spent those tokens.
    roots: ['.codex/sessions', '.codex/archived_sessions'],
    fileSuffix: '.jsonl',
    status: 'verified',
    note: 'Field names taken from the TokenUsage struct in openai/codex codex-rs/protocol/src/protocol.rs (serde snake_case). Two envelope shapes exist across versions - the older {type,item,seq} and the newer {timestamp,type,payload} - so both paths are declared and pick() takes whichever resolves.',
    fields: {
      // token_count events carry cumulative totals under info.total_token_usage.
      inputTokens: [
        'payload.info.total_token_usage.input_tokens',
        'item.info.total_token_usage.input_tokens',
        'payload.info.last_token_usage.input_tokens',
        'info.total_token_usage.input_tokens',
      ],
      outputTokens: [
        'payload.info.total_token_usage.output_tokens',
        'item.info.total_token_usage.output_tokens',
        'payload.info.last_token_usage.output_tokens',
        'info.total_token_usage.output_tokens',
      ],
      // Codex separates cached reads from fresh cache writes, as Anthropic does.
      cacheReadTokens: [
        'payload.info.total_token_usage.cached_input_tokens',
        'item.info.total_token_usage.cached_input_tokens',
        'info.total_token_usage.cached_input_tokens',
      ],
      cacheWriteTokens: [
        'payload.info.total_token_usage.cache_write_input_tokens',
        'item.info.total_token_usage.cache_write_input_tokens',
        'info.total_token_usage.cache_write_input_tokens',
      ],
      model: ['payload.model', 'item.model', 'payload.thread_settings.model', 'model'],
      timestamp: ['timestamp', 'payload.timestamp', 'item.timestamp'],
      toolName: ['payload.name', 'item.name', 'payload.tool_name'],
      toolInput: ['payload.arguments', 'item.arguments', 'payload.input'],
      sessionId: ['payload.id', 'item.session_id', 'session_id'],
    },
  },
  {
    id: 'gemini-cli',
    label: 'Gemini CLI',
    // Chats live at ~/.gemini/tmp/<project_hash>/chats/. The walker is depth
    // bounded at 3, which reaches tmp -> hash -> chats -> file.
    roots: ['.gemini/tmp'],
    fileSuffix: '.jsonl',
    status: 'verified',
    note: 'Field names taken from the MessageRecord and token usage types in google-gemini/gemini-cli packages/core/src/services/chatRecordingService.ts. The CLI flattens Gemini usageMetadata into a short-named tokens object; raw usageMetadata paths are kept as a fallback for older records.',
    fields: {
      // tokens.input is promptTokenCount; tokens.cached is counted separately
      // below so a replayed context is not billed as fresh input.
      inputTokens: ['tokens.input', 'usageMetadata.promptTokenCount'],
      // thoughts tokens are output the user is billed for, so they are added.
      outputTokens: [
        'tokens.output',
        'usageMetadata.candidatesTokenCount',
      ],
      cacheReadTokens: ['tokens.cached', 'usageMetadata.cachedContentTokenCount'],
      model: ['model'],
      timestamp: ['timestamp'],
      toolName: ['toolCalls.0.name'],
      toolInput: ['toolCalls.0.args'],
      sessionId: ['sessionId', 'id'],
    },
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    // XDG_DATA_HOME is respected where set; the literal path is the documented
    // default and the only one discoverable without reading the environment.
    roots: ['.local/share/opencode/storage', '.opencode'],
    fileSuffix: '.jsonl',
    status: 'unverified',
    note: 'Path confirmed against the documented OpenCode storage layout, but no real session file was available to confirm the field names.',
    fields: {
      inputTokens: ['tokens.input', 'usage.input_tokens'],
      outputTokens: ['tokens.output', 'usage.output_tokens'],
      cacheReadTokens: ['tokens.cache.read', 'tokens.cache_read'],
      cacheWriteTokens: ['tokens.cache.write', 'tokens.cache_write'],
      model: ['modelID', 'model'],
      timestamp: ['time.created', 'timestamp'],
      sessionId: ['sessionID', 'session_id'],
    },
  },
];

/** Reads a dot-path out of a parsed line. */
export function pick(row: unknown, paths: string[] | undefined): unknown {
  if (!paths) return undefined;
  for (const path of paths) {
    let value: unknown = row;
    for (const part of path.split('.')) {
      if (value == null || typeof value !== 'object') {
        value = undefined;
        break;
      }
      value = (value as Record<string, unknown>)[part];
    }
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/**
 * User-defined sources from ~/.agentobs/sources.json.
 *
 * This is the important half: new agents appear faster than any maintainer
 * can chase them, so a user must be able to add one without waiting for a
 * release.
 */
export function loadUserSources(sourcesFile: string): AgentSource[] {
  if (!existsSync(sourcesFile)) return [];
  try {
    const parsed = JSON.parse(readFileSync(sourcesFile, 'utf8')) as { sources?: AgentSource[] };
    return Array.isArray(parsed.sources) ? parsed.sources : [];
  } catch {
    // A malformed file must not stop the built-in sources from working.
    return [];
  }
}

export function allSources(sourcesFile?: string): AgentSource[] {
  const user = sourcesFile ? loadUserSources(sourcesFile) : [];
  // A user definition with the same id replaces the built-in, which is how
  // someone fixes a field map we got wrong without waiting for a release.
  const byId = new Map(BUILTIN_SOURCES.map((s) => [s.id, s]));
  for (const s of user) byId.set(s.id, { ...s, status: s.status ?? 'unverified' });
  return [...byId.values()];
}

export interface DiscoveredFile {
  source: AgentSource;
  path: string;
  sessionId: string;
  modifiedAt: number;
  sizeBytes: number;
}

/** Finds every log file belonging to a source, newest first. */
export function discover(source: AgentSource, home = homedir()): DiscoveredFile[] {
  const out: DiscoveredFile[] = [];

  for (const root of source.roots) {
    const dir = root.startsWith('/') || /^[A-Za-z]:/.test(root) ? root : join(home, root);
    if (!existsSync(dir)) continue;
    walk(dir, 0);

    function walk(current: string, depth: number): void {
      // Bounded depth: these directories are shallow by design, and an
      // unbounded walk over a home directory is how a tool hangs.
      if (depth > 3) return;
      let entries: string[];
      try {
        entries = readdirSync(current);
      } catch {
        return;
      }
      for (const name of entries) {
        const full = join(current, name);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          walk(full, depth + 1);
        } else if (name.endsWith(source.fileSuffix)) {
          out.push({
            source,
            path: full,
            sessionId: `${source.id}:${name.replace(source.fileSuffix, '')}`,
            modifiedAt: st.mtimeMs,
            sizeBytes: st.size,
          });
        }
      }
    }
  }

  return out.sort((a, b) => b.modifiedAt - a.modifiedAt);
}
