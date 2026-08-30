/**
 * Claude Code transcript adapter - the hook-free path to rich data.
 *
 * Claude Code writes a JSONL transcript per session under
 * `~/.claude/projects/<slug>/<session-id>.jsonl`, containing every assistant
 * message with its `usage` block and every `tool_use` / `tool_result` pair.
 * That is the same information the hooks would deliver, already on disk.
 *
 * Why this exists: hooks are the intended integration, but they depend on
 * Claude Code actually invoking the configured command, which cannot be
 * verified from inside AgentObs and has been observed silently not happening.
 * Reading the transcript needs no configuration at all, so `agentobs import`
 * works on a machine where hooks do not.
 *
 * Trade-off against hooks, stated plainly: this is after-the-fact. It cannot
 * block a tool call, so guardrails still require the hook. It also attributes
 * tokens per assistant message rather than per tool call, so per-call cost
 * stays null rather than being invented by dividing a total.
 */
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { computeCost } from '../core/pricing.js';
import {
  beginToolCall,
  completeToolCall,
  endSession,
  ensureSession,
  rollUpSession,
  startSession,
} from '../core/repo.js';

/** Root of Claude Code's per-project transcript directories. */
export function transcriptRoot(): string {
  return process.env.CLAUDE_CONFIG_DIR
    ? join(process.env.CLAUDE_CONFIG_DIR, 'projects')
    : join(homedir(), '.claude', 'projects');
}

export interface TranscriptFile {
  path: string;
  sessionId: string;
  project: string;
  modifiedAt: number;
  sizeBytes: number;
}

/** Every transcript on this machine, newest first. */
export function findTranscripts(root = transcriptRoot()): TranscriptFile[] {
  if (!existsSync(root)) return [];
  const out: TranscriptFile[] = [];

  for (const project of readdirSync(root)) {
    const dir = join(root, project);
    let entries: string[];
    try {
      if (!statSync(dir).isDirectory()) continue;
      entries = readdirSync(dir);
    } catch {
      continue; // unreadable directory - skip rather than abort the scan
    }
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(dir, name);
      try {
        const st = statSync(path);
        out.push({
          path,
          sessionId: name.replace(/\.jsonl$/, ''),
          project,
          modifiedAt: st.mtimeMs,
          sizeBytes: st.size,
        });
      } catch {
        /* vanished between readdir and stat - ignore */
      }
    }
  }
  return out.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

/**
 * Cache reads are billed at about a tenth of the normal input rate. Applying
 * the full rate to a long session's replayed context overstates it by roughly
 * an order of magnitude.
 */
const CACHE_READ_RATE = 0.1;

/** A cache write bills at 1.25x the normal input rate. */
const CACHE_WRITE_RATE = 1.25;

interface UsageBlock {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface ImportResult {
  sessionId: string;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  /** Context replayed each turn; billed at 0.1x, never summed into tokensIn. */
  cacheReadTokens: number;
  /** Context written to the cache; billed at 1.25x the input rate. */
  cacheWriteTokens: number;
  cost: number | null;
  model: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

/**
 * Imports one transcript into the local database.
 *
 * Idempotent: session and tool-call ids come from the transcript itself, and
 * the repository layer inserts with ON CONFLICT DO NOTHING, so re-importing a
 * growing transcript adds only what is new. That matters because a session's
 * file keeps being appended to while the session is live.
 */
export async function importTranscript(
  db: DatabaseSync,
  file: TranscriptFile,
): Promise<ImportResult> {
  const rl = createInterface({
    input: createReadStream(file.path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  const result: ImportResult = {
    sessionId: file.sessionId,
    toolCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: null,
    model: null,
    startedAt: null,
    endedAt: null,
  };

  // tool_use appears on an assistant message; its tool_result arrives later on
  // a user message. Hold the open calls so the pair can be joined.
  const pending = new Map<string, { name: string; startedAt: string }>();
  let sessionStarted = false;
  let cwd: string | null = null;

  for await (const line of rl) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // a partially-flushed final line is normal on a live session
    }

    const timestamp = typeof row.timestamp === 'string' ? row.timestamp : null;
    if (timestamp) {
      if (!result.startedAt) result.startedAt = timestamp;
      result.endedAt = timestamp;
    }
    if (typeof row.cwd === 'string' && !cwd) cwd = row.cwd;

    if (!sessionStarted && timestamp) {
      startSession(db, {
        id: file.sessionId,
        agentName: 'claude-code',
        cwd,
        fidelity: 'rich',
        startedAt: timestamp,
      });
      sessionStarted = true;
    }

    const message = (row.message ?? {}) as Record<string, unknown>;

    const usage = message.usage as UsageBlock | undefined;
    if (usage && typeof usage === 'object') {
      // Fresh input = uncached input + cache writes. A cache write is real
      // new content being sent for the first time (just stored for reuse), so
      // excluding it made "tokens in" absurd: 24K in against 4.6M out, when
      // real agent usage is heavily input-weighted. It is still tracked
      // separately for costing, since it bills at 1.25x.
      //
      // Cache *reads* stay out of this total: they replay the entire context
      // on every turn, so counting them would report the same tokens hundreds
      // of times (2.4 billion across three sessions).
      const cacheWrite = usage.cache_creation_input_tokens ?? 0;
      result.tokensIn += (usage.input_tokens ?? 0) + cacheWrite;
      result.tokensOut += usage.output_tokens ?? 0;
      result.cacheWriteTokens += cacheWrite;

      // cache_read is the whole conversation context replayed on every single
      // message, so it re-counts the same tokens on each turn - summing it
      // reported 413 million tokens for one session. It is tracked separately
      // and priced at the cache-read rate, never added to tokens_in, which
      // would make the headline token count meaningless.
      result.cacheReadTokens += usage.cache_read_input_tokens ?? 0;

      if (typeof message.model === 'string') result.model = message.model;
    }

    const content = message.content;
    if (!Array.isArray(content)) continue;

    for (const block of content as Array<Record<string, unknown>>) {
      if (block?.type === 'tool_use' && typeof block.id === 'string') {
        const name = typeof block.name === 'string' ? block.name : 'unknown';
        const at = timestamp ?? new Date().toISOString();
        ensureSession(db, file.sessionId, 'claude-code', cwd);
        beginToolCall(db, {
          id: block.id,
          sessionId: file.sessionId,
          toolName: name,
          input: block.input,
          startedAt: at,
        });
        pending.set(block.id, { name, startedAt: at });
        result.toolCalls += 1;
      }

      if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const isError = block.is_error === true;
        completeToolCall(db, block.tool_use_id, {
          status: isError ? 'error' : 'success',
          output: block.content,
          errorMessage: isError ? String(block.content).slice(0, 300) : null,
          endedAt: timestamp ?? undefined,
          // No per-call tokens: usage is reported per assistant message, and
          // splitting it across calls would be a fabricated number.
        });
        pending.delete(block.tool_use_id);
      }
    }
  }

  if (!sessionStarted) return result;

  // tokensIn already contains the cache-write tokens, so they are costed once
  // at the base rate here and only topped up by the extra 0.25x premium.
  const baseCost = computeCost(result.model, result.tokensIn, result.tokensOut);
  const readCost = computeCost(result.model, result.cacheReadTokens, 0);
  const writeCost = computeCost(result.model, result.cacheWriteTokens, 0);
  result.cost =
    baseCost === null
      ? null
      : baseCost +
        (readCost ?? 0) * CACHE_READ_RATE +
        (writeCost ?? 0) * (CACHE_WRITE_RATE - 1);

  // Session totals come from the transcript's own usage blocks, which are
  // authoritative - the per-call rows have no tokens to sum.
  db.prepare(
    `UPDATE sessions
        SET total_tokens_in = ?, total_tokens_out = ?, total_cost_usd = ?,
            ended_at = COALESCE(?, ended_at), updated_at = ?, synced_at = NULL
      WHERE id = ?`,
  ).run(
    result.tokensIn,
    result.tokensOut,
    result.cost,
    result.endedAt,
    new Date().toISOString(),
    file.sessionId,
  );

  // Recompute counts from the rows just inserted, then restore the token
  // totals, which rollUpSession would otherwise zero out (it sums per-call
  // tokens, and those are deliberately null here).
  rollUpSession(db, file.sessionId);
  db.prepare(
    `UPDATE sessions SET total_tokens_in = ?, total_tokens_out = ?, total_cost_usd = ? WHERE id = ?`,
  ).run(result.tokensIn, result.tokensOut, result.cost, file.sessionId);

  if (result.endedAt) endSession(db, file.sessionId, { endedAt: result.endedAt });

  return result;
}
