/**
 * Imports any agent whose log is declared in agent-sources.ts.
 *
 * Deliberately conservative: a source whose field map does not match the real
 * file produces zero tokens rather than wrong ones, and the caller reports
 * that as "no usage data found" instead of a confident zero. An observability
 * tool that silently under-reports is worse than one that admits it cannot
 * read a format.
 */
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { DatabaseSync } from 'node:sqlite';
import { computeCost } from '../core/pricing.js';
import { beginToolCall, completeToolCall, endSession, startSession } from '../core/repo.js';
import { pick, type DiscoveredFile } from './agent-sources.js';

export interface GenericImportResult {
  sessionId: string;
  agent: string;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  cost: number | null;
  model: string | null;
  linesRead: number;
  /** Lines that parsed as JSON but matched no known field - the mismatch signal. */
  linesUnrecognised: number;
}

const num = (value: unknown): number => {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
};

export async function importGenericLog(
  db: DatabaseSync,
  file: DiscoveredFile,
): Promise<GenericImportResult> {
  const { source } = file;
  const result: GenericImportResult = {
    sessionId: file.sessionId,
    agent: source.id,
    toolCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
    cost: null,
    model: null,
    linesRead: 0,
    linesUnrecognised: 0,
  };

  if (!existsSync(file.path)) return result;

  const rl = createInterface({
    input: createReadStream(file.path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let started = false;
  let lastTimestamp: string | null = null;
  let seq = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // a partially-written final line is normal on a live session
    }
    result.linesRead += 1;

    const ts = pick(row, source.fields.timestamp);
    const timestamp = typeof ts === 'string' ? ts : new Date().toISOString();
    lastTimestamp = timestamp;

    if (!started) {
      startSession(db, {
        id: file.sessionId,
        agentName: source.id,
        fidelity: 'rich',
        startedAt: timestamp,
      });
      started = true;
    }

    const inTok = num(pick(row, source.fields.inputTokens));
    const outTok = num(pick(row, source.fields.outputTokens));
    // Cache writes are fresh content; cache reads replay the same context on
    // every turn and are excluded, exactly as in the Claude Code importer.
    const cacheWrite = num(pick(row, source.fields.cacheWriteTokens));

    const model = pick(row, source.fields.model);
    if (typeof model === 'string' && model) result.model = model;

    const toolName = pick(row, source.fields.toolName);
    const hasUsage = inTok > 0 || outTok > 0 || cacheWrite > 0;

    if (hasUsage) {
      result.tokensIn += inTok + cacheWrite;
      result.tokensOut += outTok;
    }

    if (typeof toolName === 'string' && toolName) {
      const id = `${file.sessionId}:${seq++}`;
      beginToolCall(db, {
        id,
        sessionId: file.sessionId,
        toolName,
        input: pick(row, source.fields.toolInput),
        startedAt: timestamp,
        model: typeof model === 'string' ? model : null,
      });
      completeToolCall(db, id, { status: 'success', endedAt: timestamp });
      result.toolCalls += 1;
    }

    if (!hasUsage && !toolName) result.linesUnrecognised += 1;
  }

  if (!started) return result;

  result.cost = computeCost(result.model, result.tokensIn, result.tokensOut);

  db.prepare(
    `UPDATE sessions
        SET total_tokens_in = ?, total_tokens_out = ?, total_cost_usd = ?,
            model_hint = COALESCE(?, model_hint), updated_at = ?, synced_at = NULL
      WHERE id = ?`,
  ).run(
    result.tokensIn,
    result.tokensOut,
    result.cost,
    result.model,
    new Date().toISOString(),
    file.sessionId,
  );

  if (lastTimestamp) endSession(db, file.sessionId, { endedAt: lastTimestamp });

  return result;
}
