/**
 * Tests for `agentobs agents:verify`.
 *
 * The verdict is the part worth guarding. A verification tool that says "works"
 * about a half-working field map is worse than no tool, because it converts an
 * unknown into false confidence - and silent under-reporting is the failure
 * this whole command exists to catch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifySource } from './verify-source.js';
import type { AgentSource } from '../adapters/agent-sources.js';

/** Writes JSONL lines into a throwaway directory and returns a source pointing at it. */
function fixture(lines: unknown[], fields: AgentSource['fields']): { dir: string; source: AgentSource } {
  const dir = mkdtempSync(join(tmpdir(), 'agentobs-verify-'));
  const logs = join(dir, 'sessions');
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, 's1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'), 'utf8');
  return {
    dir,
    source: {
      id: 'fixture',
      label: 'Fixture Agent',
      roots: [logs],
      fileSuffix: '.jsonl',
      status: 'unverified',
      fields,
    },
  };
}

const GOOD_FIELDS: AgentSource['fields'] = {
  inputTokens: ['usage.input_tokens'],
  outputTokens: ['usage.output_tokens'],
  model: ['model'],
  timestamp: ['timestamp'],
};

test('a correct field map reports usable and names the winning path', async () => {
  const { dir, source } = fixture(
    [
      { timestamp: '2026-08-30T10:00:00Z', model: 'm-1', usage: { input_tokens: 100, output_tokens: 50 } },
      { timestamp: '2026-08-30T10:01:00Z', model: 'm-1', usage: { input_tokens: 200, output_tokens: 75 } },
    ],
    GOOD_FIELDS,
  );
  try {
    const r = await verifySource(source);
    assert.equal(r.usable, true);
    assert.equal(r.linesParsed, 2);

    const input = r.fields.find((f) => f.field === 'inputTokens');
    assert.equal(input?.hits, 2);
    assert.equal(input?.resolvedPath, 'usage.input_tokens');
    assert.equal(input?.warning, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a map that reads input but not output is NOT usable', async () => {
  // The regression this file exists for: `some` instead of `every` here would
  // pass a source that silently halves every number it reports.
  const { dir, source } = fixture(
    [{ timestamp: '2026-08-30T10:00:00Z', usage: { input_tokens: 100, out: 50 } }],
    { ...GOOD_FIELDS, outputTokens: ['usage.output_tokens'] },
  );
  try {
    const r = await verifySource(source);
    assert.equal(r.usable, false, 'a half-resolving map must not report usable');

    const output = r.fields.find((f) => f.field === 'outputTokens');
    assert.equal(output?.hits, 0);
    assert.equal(output?.resolvedPath, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the first path that resolves wins, so fallbacks are reported honestly', async () => {
  const { dir, source } = fixture(
    [{ timestamp: '2026-08-30T10:00:00Z', usage: { in: 100, out: 50 } }],
    {
      // The documented path is listed first but is absent here; the fallback
      // is what actually fires, and the report must say so.
      inputTokens: ['usage.input_tokens', 'usage.in'],
      outputTokens: ['usage.output_tokens', 'usage.out'],
      timestamp: ['timestamp'],
      model: ['model'],
    },
  );
  try {
    const r = await verifySource(source);
    assert.equal(r.usable, true);
    assert.equal(r.fields.find((f) => f.field === 'inputTokens')?.resolvedPath, 'usage.in');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a path pointing at the wrong type is flagged, not counted as working', async () => {
  const { dir, source } = fixture(
    [
      {
        timestamp: '2026-08-30T10:00:00Z',
        // Points at the usage object rather than a number - resolves, but is
        // useless to the importer.
        usage: { input_tokens: { total: 100 }, output_tokens: 50 },
      },
    ],
    GOOD_FIELDS,
  );
  try {
    const r = await verifySource(source);
    const input = r.fields.find((f) => f.field === 'inputTokens');
    assert.ok(input?.warning, 'an object where a number belongs must warn');
    assert.match(input!.warning!, /expected a number/);
    assert.equal(r.usable, false, 'a type mismatch must not report usable');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unparseable timestamp is flagged', async () => {
  const { dir, source } = fixture(
    [{ timestamp: 'last tuesday', usage: { input_tokens: 1, output_tokens: 1 } }],
    GOOD_FIELDS,
  );
  try {
    const r = await verifySource(source);
    const ts = r.fields.find((f) => f.field === 'timestamp');
    assert.match(ts?.warning ?? '', /parseable date/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('non-JSON lines are counted, not crashed on', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentobs-verify-'));
  const logs = join(dir, 'sessions');
  mkdirSync(logs, { recursive: true });
  // A plain-text log, which is exactly what Copilot CLI writes.
  writeFileSync(join(logs, 's1.jsonl'), '2026-08-30 [INFO] server started\nnot json either\n', 'utf8');

  try {
    const r = await verifySource({
      id: 'fixture',
      label: 'Fixture',
      roots: [logs],
      fileSuffix: '.jsonl',
      status: 'unverified',
      fields: GOOD_FIELDS,
    });
    assert.equal(r.linesParsed, 0);
    assert.equal(r.linesUnparseable, 2);
    assert.equal(r.usable, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an agent that is not installed is reported, not treated as broken', async () => {
  const r = await verifySource({
    id: 'absent',
    label: 'Absent Agent',
    roots: [join(tmpdir(), 'agentobs-definitely-not-here')],
    fileSuffix: '.jsonl',
    status: 'unverified',
    fields: GOOD_FIELDS,
  });
  assert.equal(r.filesFound, 0);
  assert.equal(r.linesParsed, 0);
  // Not usable, but the caller distinguishes "absent" from "wrong" by filesFound.
  assert.equal(r.usable, false);
});
