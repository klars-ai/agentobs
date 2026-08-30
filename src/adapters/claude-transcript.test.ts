/**
 * Tests for per-call cost attribution in the transcript importer.
 *
 * The rule being guarded is narrow and worth stating: usage is reported per
 * assistant message, so a call only gets a cost when its message issued exactly
 * one call. Measured across 25 real transcripts that is 4,088 of 4,088 - but
 * the moment a message issues two, dividing the total would be inventing a
 * number, which is the thing this project refuses to do. So it stays null.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'agentobs-transcript-'));
process.env.AGENTOBS_HOME = home;
mkdirSync(home, { recursive: true });

const { openDb } = await import('../core/db.js');
const { importTranscript } = await import('./claude-transcript.js');
const { DEFAULT_PRICING } = await import('../core/pricing.js');

// A known price so the assertions can be exact rather than "greater than zero".
writeFileSync(join(home, 'pricing.json'), JSON.stringify(DEFAULT_PRICING), 'utf8');

test.after(() => {
  // Windows keeps the SQLite file handle open past the last test, so removing
  // the directory throws EPERM and fails the run for a reason unrelated to any
  // assertion. Best-effort cleanup: a temp directory is the OS's to reclaim.
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* leave it to the OS */
  }
});

/** Writes a transcript of `lines` and imports it. */
async function importLines(name: string, lines: unknown[]): Promise<ReturnType<typeof openDb>> {
  const path = join(home, `${name}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf8');
  const db = openDb();
  await importTranscript(db, {
    path,
    sessionId: name,
    project: 'test',
    modifiedAt: Date.now(),
    sizeBytes: 0,
  });
  return db;
}

const assistant = (id: string, usage: Record<string, number>, tools: string[]) => ({
  timestamp: '2026-08-30T10:00:00.000Z',
  cwd: '/tmp/project',
  message: {
    model: 'claude-opus-5',
    usage,
    content: tools.map((name, i) => ({
      type: 'tool_use',
      id: `${id}-${i}`,
      name,
      input: { command: 'echo hi' },
    })),
  },
});

const result = (id: string, i = 0) => ({
  timestamp: '2026-08-30T10:00:01.000Z',
  message: {
    content: [{ type: 'tool_result', tool_use_id: `${id}-${i}`, content: 'ok' }],
  },
});

test('a message with one tool call gets that call costed exactly', async () => {
  const db = await importLines('single', [
    assistant('a', { input_tokens: 1000, output_tokens: 500 }, ['Bash']),
    result('a'),
  ]);

  const row = db.prepare('SELECT tokens_in, tokens_out, cost_usd FROM tool_calls WHERE id = ?').get(
    'a-0',
  ) as { tokens_in: number; tokens_out: number; cost_usd: number };

  assert.equal(row.tokens_in, 1000);
  assert.equal(row.tokens_out, 500);
  // Opus 5: $15/Mtok in, $75/Mtok out.
  assert.ok(Math.abs(row.cost_usd - (1000 / 1e6) * 15 - (500 / 1e6) * 75) < 1e-9);
});

test('cache writes count as input; cache reads never do', async () => {
  const db = await importLines('cache', [
    assistant(
      'b',
      {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 900,
        // Replayed context. Counting this per call would attach the whole
        // conversation to every single tool call.
        cache_read_input_tokens: 500_000,
      },
      ['Read'],
    ),
    result('b'),
  ]);

  const row = db.prepare('SELECT tokens_in FROM tool_calls WHERE id = ?').get('b-0') as {
    tokens_in: number;
  };
  assert.equal(row.tokens_in, 1000, 'input + cache write, and nothing else');
});

test('a message with two tool calls leaves both uncosted', async () => {
  // The line this file exists to hold. Splitting 1,500 tokens across two calls
  // would produce two plausible numbers that are not true of either.
  const db = await importLines('multi', [
    assistant('c', { input_tokens: 1000, output_tokens: 500 }, ['Bash', 'Read']),
    result('c', 0),
    result('c', 1),
  ]);

  for (const id of ['c-0', 'c-1']) {
    const row = db.prepare('SELECT tokens_in, cost_usd FROM tool_calls WHERE id = ?').get(id) as {
      tokens_in: number | null;
      cost_usd: number | null;
    };
    assert.equal(row.tokens_in, null, `${id} should carry no tokens`);
    assert.equal(row.cost_usd, null, `${id} should carry no cost`);
  }
});

test('session totals still come from every message, costed calls or not', async () => {
  const db = await importLines('totals', [
    assistant('d', { input_tokens: 1000, output_tokens: 500 }, ['Bash']),
    result('d'),
    // A message with two calls contributes to the session but not per-call.
    assistant('e', { input_tokens: 200, output_tokens: 100 }, ['Read', 'Edit']),
    result('e', 0),
    result('e', 1),
  ]);

  const s = db
    .prepare('SELECT total_tokens_in, total_tokens_out FROM sessions WHERE id = ?')
    .get('totals') as { total_tokens_in: number; total_tokens_out: number };

  assert.equal(s.total_tokens_in, 1200, 'both messages counted at session level');
  assert.equal(s.total_tokens_out, 600);
});

test('an unpriced model leaves cost null while keeping tokens', async () => {
  const path = join(home, 'unpriced.jsonl');
  writeFileSync(
    path,
    [
      JSON.stringify({
        timestamp: '2026-08-30T10:00:00.000Z',
        message: {
          model: 'some-model-that-does-not-exist',
          usage: { input_tokens: 1000, output_tokens: 500 },
          content: [{ type: 'tool_use', id: 'z-0', name: 'Bash', input: {} }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-08-30T10:00:01.000Z',
        message: { content: [{ type: 'tool_result', tool_use_id: 'z-0', content: 'ok' }] },
      }),
    ].join('\n'),
    'utf8',
  );

  const db = openDb();
  await importTranscript(db, {
    path,
    sessionId: 'unpriced',
    project: 'test',
    modifiedAt: Date.now(),
    sizeBytes: 0,
  });

  const row = db.prepare('SELECT tokens_in, cost_usd FROM tool_calls WHERE id = ?').get('z-0') as {
    tokens_in: number;
    cost_usd: number | null;
  };
  assert.equal(row.tokens_in, 1000, 'tokens are known even when the price is not');
  assert.equal(row.cost_usd, null, 'unknown price is null, never zero');
});
