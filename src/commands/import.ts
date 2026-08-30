/**
 * `agentobs import` - read Claude Code's own transcripts, no hooks required.
 *
 * This is the fallback when hooks are not firing, and the fastest way to get
 * real data on a fresh install: everything Claude Code has already done is
 * sitting on disk waiting to be read.
 */
import { openDb } from '../core/db.js';
import { findTranscripts, importTranscript, transcriptRoot } from '../adapters/claude-transcript.js';

export interface ImportOptions {
  /** Keep watching for new activity instead of exiting after one pass. */
  watch?: boolean;
  /** Only import transcripts modified within this many days. */
  days?: string | number;
  /** Import every transcript found, however old. */
  all?: boolean;
  /** List what would be imported without writing anything. */
  dryRun?: boolean;
  /** Import one specific session id. */
  session?: string;
}

const money = (v: number | null): string => (v === null ? '—' : `$${v.toFixed(4)}`);

export async function importCommand(opts: ImportOptions = {}): Promise<void> {
  const all = findTranscripts();

  if (all.length === 0) {
    console.error(`No Claude Code transcripts found under:
  ${transcriptRoot()}

Claude Code writes one JSONL file per session there. If you have used it on
this machine, check the path above exists; set CLAUDE_CONFIG_DIR if your
install keeps its config somewhere else.`);
    process.exitCode = 1;
    return;
  }

  const days = opts.all ? Infinity : Number(opts.days ?? 7);
  const cutoff = Number.isFinite(days) ? Date.now() - days * 864e5 : 0;
  const selected = opts.session
    ? all.filter((t) => t.sessionId === opts.session)
    : all.filter((t) => t.modifiedAt >= cutoff);

  if (selected.length === 0) {
    console.log(
      `Found ${all.length} transcript(s), but none in the last ${days} day(s).\n` +
        `Use --all to import everything, or --days <n> for a wider window.`,
    );
    return;
  }

  if (opts.dryRun) {
    console.log(`Would import ${selected.length} transcript(s):\n`);
    for (const t of selected) {
      const age = Math.round((Date.now() - t.modifiedAt) / 36e5);
      console.log(
        `  ${t.sessionId.slice(0, 8)}  ${t.project.padEnd(24).slice(0, 24)}  ` +
          `${String(Math.round(t.sizeBytes / 1024)).padStart(6)}KB  ${age}h ago`,
      );
    }
    return;
  }

  const db = openDb();
  console.log(`Importing ${selected.length} transcript(s) from ${transcriptRoot()}\n`);

  let calls = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost: number | null = null;

  for (const t of selected) {
    try {
      const r = await importTranscript(db, t);
      calls += r.toolCalls;
      tokensIn += r.tokensIn;
      tokensOut += r.tokensOut;
      cacheRead += r.cacheReadTokens;
      cacheWrite += r.cacheWriteTokens;
      if (r.cost !== null) cost = (cost ?? 0) + r.cost;
      console.log(
        `  ${t.sessionId.slice(0, 8)}  ${String(r.toolCalls).padStart(5)} calls  ` +
          `${String(r.tokensIn + r.tokensOut).padStart(9)} tokens  ${money(r.cost).padStart(10)}`,
      );
    } catch (err) {
      // One unreadable transcript should not abandon the rest of the import.
      console.log(`  ${t.sessionId.slice(0, 8)}  skipped: ${(err as Error).message}`);
    }
  }

  // Break the cost down. On a long session the cache-read line dominates -
  // the whole context is replayed on every turn, so it can reach billions of
  // tokens. That is genuine billing, but a single unexplained total looks
  // like a bug, so show where it comes from.
  if (opts.watch) {
    await followTranscripts(db, selected.map((t) => t.path));
    return;
  }

  console.log(`
  ${selected.length} session(s) · ${calls} tool calls

  Fresh input     ${tokensIn.toLocaleString().padStart(15)} tokens
  Output          ${tokensOut.toLocaleString().padStart(15)} tokens
  Cache write     ${cacheWrite.toLocaleString().padStart(15)} tokens  (billed 1.25x input)
  Cache read      ${cacheRead.toLocaleString().padStart(15)} tokens  (billed 0.10x input)
  ${'-'.repeat(52)}
  Estimated cost  ${money(cost).padStart(15)}

Cache reads replay the conversation context on every turn, so a long
session accumulates far more of them than fresh tokens - that line
usually dominates the total. Prices come from ~/.agentobs/pricing.json;
edit them if yours differ.

Run "agentobs stats --today" or "agentobs dashboard" to see it.

Note: imported data is historical, so guardrails cannot block anything
retroactively. Blocking still requires the PreToolUse hook.`);
}

/**
 * Re-imports the newest transcripts on an interval.
 *
 * This is the hook-free path to *live* data: Claude Code appends to its
 * transcript as the session runs, and importTranscript is idempotent (ids come
 * from the transcript, inserts are ON CONFLICT DO NOTHING), so re-reading a
 * growing file only adds what is new.
 *
 * Polling rather than fs.watch: a transcript is appended to constantly, watch
 * events would fire far more often than there is work to do, and polling is
 * also what survives network shares and container mounts.
 */
/** Newline, kept as a constant so no escape sequence appears in a template. */
const EOL = String.fromCharCode(10);

async function followTranscripts(
  db: ReturnType<typeof openDb>,
  initialPaths: string[],
): Promise<void> {
  const INTERVAL_MS = 5000;
  console.log(`
  Watching ${initialPaths.length} transcript(s) — Ctrl-C to stop.
  New activity appears within ${INTERVAL_MS / 1000}s. No hooks required.
`);

  let stop = false;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      stop = true;
      console.log(EOL + '  Stopped.');
      process.exit(0);
    });
  }

  let lastTotal = 0;
  while (!stop) {
    // Re-scan every pass: a session started after `watch` began should be
    // picked up without restarting the command.
    const current = findTranscripts().filter((t) => Date.now() - t.modifiedAt < 864e5);
    let calls = 0;
    for (const t of current) {
      try {
        const r = await importTranscript(db, t);
        calls += r.toolCalls;
      } catch {
        // A transcript being written mid-read is normal; the next pass
        // picks it up.
      }
    }
    if (calls !== lastTotal) {
      const now = new Date().toLocaleTimeString();
      process.stdout.write(`  ${now} - ${calls} tool calls across ${current.length} session(s)   `);
      lastTotal = calls;
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}
