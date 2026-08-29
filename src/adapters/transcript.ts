/**
 * Token usage recovery from a Claude Code transcript.
 *
 * Claude Code's hook payloads carry no token or cost fields - verified
 * against the hooks reference, and the reason nothing in the hook path ever
 * sets a token count. The transcript JSONL the agent writes for itself does
 * carry per-message `usage` blocks, so that is where real numbers come from.
 *
 * The trade-off this accepts: usage is per assistant *message*, not per tool
 * call, so it is attributed to the session rather than split across the
 * individual calls inside it. Session-level cost is therefore accurate;
 * per-tool-call cost stays null for hook-sourced data rather than being
 * fabricated by dividing a total.
 */
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { DatabaseSync } from 'node:sqlite';
import { computeCost } from '../core/pricing.js';

export interface TranscriptUsage {
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  model: string | null;
  /** Messages that carried a usage block - 0 means nothing was found. */
  messages: number;
}

interface UsageBlock {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * Sums the usage blocks in a transcript.
 *
 * Streams line-by-line rather than reading the file: a long session's
 * transcript can be tens of megabytes, and this runs inside a SessionEnd hook
 * with a tight time budget.
 */
export async function readTranscriptUsage(file: string): Promise<TranscriptUsage> {
  const total: TranscriptUsage = {
    tokensIn: 0,
    tokensOut: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    model: null,
    messages: 0,
  };
  if (!existsSync(file)) return total;

  const rl = createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // a partially-flushed final line is normal while tailing
    }

    // The shape has moved between versions, so check both the top level and
    // a nested `message` object rather than assuming one layout.
    const message = (row.message ?? row) as Record<string, unknown>;
    const usage = message.usage as UsageBlock | undefined;
    if (!usage || typeof usage !== 'object') continue;

    total.tokensIn += usage.input_tokens ?? 0;
    total.tokensOut += usage.output_tokens ?? 0;
    total.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
    total.cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
    total.messages += 1;

    const model = message.model;
    if (typeof model === 'string' && model) total.model = model;
  }

  return total;
}

/**
 * Writes recovered usage onto the session row.
 *
 * Cost counts cache-read tokens at the full input rate, which slightly
 * over-states spend for cache-heavy sessions. That direction is deliberate:
 * pricing.json has no cache tier for most models, and over-reporting is the
 * safer error for a spend figure. It is also why the number is only claimed
 * as session-level.
 */
export async function attachTranscriptUsage(
  db: DatabaseSync,
  sessionId: string,
  transcriptPath: string,
): Promise<TranscriptUsage> {
  const usage = await readTranscriptUsage(transcriptPath);
  if (usage.messages === 0) return usage;

  const billableIn = usage.tokensIn + usage.cacheReadTokens + usage.cacheCreationTokens;
  const cost = computeCost(usage.model, billableIn, usage.tokensOut);

  db.prepare(
    `UPDATE sessions
        SET total_tokens_in = ?, total_tokens_out = ?, total_cost_usd = ?,
            updated_at = ?, synced_at = NULL
      WHERE id = ?`,
  ).run(billableIn, usage.tokensOut, cost, new Date().toISOString(), sessionId);

  return usage;
}
