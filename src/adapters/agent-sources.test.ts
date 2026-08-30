/**
 * Field-map tests for the declared agent sources.
 *
 * These exist because the failure they guard against is silent. A wrong dot-path
 * does not throw - `pick` simply returns undefined, the importer records zero
 * tokens, and the user sees an empty report that looks like "no usage yet"
 * rather than "we cannot read this format". That is the worst failure an
 * observability tool can have, so every source marked `verified` gets a sample
 * line shaped like the real thing and an assertion that the numbers come out.
 *
 * The samples are built from the upstream type definitions cited in each
 * source's `note`, not invented. When an agent changes its format these tests
 * are what should fail.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_SOURCES, pick, type AgentSource } from './agent-sources.js';

const byId = (id: string): AgentSource => {
  const source = BUILTIN_SOURCES.find((s) => s.id === id);
  assert.ok(source, `no built-in source with id ${id}`);
  return source;
};

test('every source declares the fields the importer requires', () => {
  for (const source of BUILTIN_SOURCES) {
    assert.ok(source.fields.inputTokens.length > 0, `${source.id}: no inputTokens paths`);
    assert.ok(source.fields.outputTokens.length > 0, `${source.id}: no outputTokens paths`);
    assert.ok(source.fields.timestamp.length > 0, `${source.id}: no timestamp paths`);
    assert.ok(source.roots.length > 0, `${source.id}: no roots`);
    // An unverified source must say why, so a future maintainer can re-check it.
    if (source.status === 'unverified') {
      assert.ok(source.note, `${source.id}: unverified sources must carry a note`);
    }
  }
});

test('claude-code: reads a real transcript line', () => {
  const { fields } = byId('claude-code');
  const line = {
    timestamp: '2026-08-30T10:00:00.000Z',
    sessionId: 'abc-123',
    message: {
      model: 'claude-opus-4-20250514',
      usage: {
        input_tokens: 12,
        output_tokens: 340,
        cache_read_input_tokens: 48_000,
        cache_creation_input_tokens: 1_200,
      },
    },
  };

  assert.equal(pick(line, fields.inputTokens), 12);
  assert.equal(pick(line, fields.outputTokens), 340);
  assert.equal(pick(line, fields.cacheReadTokens), 48_000);
  assert.equal(pick(line, fields.cacheWriteTokens), 1_200);
  assert.equal(pick(line, fields.model), 'claude-opus-4-20250514');
  assert.equal(pick(line, fields.sessionId), 'abc-123');
});

test('codex: reads the current {timestamp,type,payload} envelope', () => {
  const { fields } = byId('codex');
  // Shaped from TokenUsage in openai/codex codex-rs/protocol/src/protocol.rs.
  const line = {
    timestamp: '2026-08-30T10:00:00.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 900,
          cached_input_tokens: 400,
          cache_write_input_tokens: 120,
          output_tokens: 210,
          reasoning_output_tokens: 64,
          total_tokens: 1_694,
        },
      },
    },
  };

  assert.equal(pick(line, fields.inputTokens), 900);
  assert.equal(pick(line, fields.outputTokens), 210);
  assert.equal(pick(line, fields.cacheReadTokens), 400);
  assert.equal(pick(line, fields.cacheWriteTokens), 120);
});

test('codex: still reads the older {type,item,seq} envelope', () => {
  const { fields } = byId('codex');
  // Older builds wrapped the payload as `item` with a sequence number. Both
  // shapes are declared, so a user on either version is read correctly.
  const line = {
    type: 'token_count',
    seq: 4,
    item: {
      info: { total_token_usage: { input_tokens: 55, output_tokens: 22 } },
    },
  };

  assert.equal(pick(line, fields.inputTokens), 55);
  assert.equal(pick(line, fields.outputTokens), 22);
});

test('gemini-cli: reads the flattened tokens object', () => {
  const { fields } = byId('gemini-cli');
  // Shaped from MessageRecord in google-gemini/gemini-cli
  // packages/core/src/services/chatRecordingService.ts.
  const line = {
    id: 'm-1',
    type: 'gemini',
    timestamp: '2026-08-30T10:00:00.000Z',
    model: 'gemini-2.5-pro',
    tokens: { input: 1_200, output: 340, cached: 8_000, thoughts: 50, tool: 10, total: 9_600 },
    toolCalls: [{ name: 'run_shell_command', args: { command: 'ls' } }],
  };

  assert.equal(pick(line, fields.inputTokens), 1_200);
  assert.equal(pick(line, fields.outputTokens), 340);
  assert.equal(pick(line, fields.cacheReadTokens), 8_000);
  assert.equal(pick(line, fields.model), 'gemini-2.5-pro');
  // Array indices resolve through the same dot-path walk.
  assert.equal(pick(line, fields.toolName), 'run_shell_command');
});

test('gemini-cli: falls back to raw usageMetadata on older records', () => {
  const { fields } = byId('gemini-cli');
  const line = {
    timestamp: '2026-08-30T10:00:00.000Z',
    usageMetadata: {
      promptTokenCount: 77,
      candidatesTokenCount: 33,
      cachedContentTokenCount: 500,
    },
  };

  assert.equal(pick(line, fields.inputTokens), 77);
  assert.equal(pick(line, fields.outputTokens), 33);
  assert.equal(pick(line, fields.cacheReadTokens), 500);
});

test('a line with no usage resolves to nothing, not zero', () => {
  // The importer counts these as unrecognised so it can report a format
  // mismatch. Returning 0 here would let a wrong field map look like a quiet
  // session instead of a bug.
  for (const source of BUILTIN_SOURCES) {
    const unrelated = { hello: 'world', nested: { other: 1 } };
    assert.equal(pick(unrelated, source.fields.inputTokens), undefined, source.id);
    assert.equal(pick(unrelated, source.fields.outputTokens), undefined, source.id);
  }
});

test('copilot-cli stays unverified until a real file confirms it', () => {
  const source = byId('copilot-cli');
  // A real install was checked and holds no usage data at all. Marking this
  // verified would promise an import that silently records nothing.
  assert.equal(source.status, 'unverified');
  assert.match(source.note ?? '', /not present|unconfirmed/i);
});
