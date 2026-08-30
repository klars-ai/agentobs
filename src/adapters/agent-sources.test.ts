import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'agentobs-sources-'));
process.env.AGENTOBS_HOME = home;

const { pick, discover, allSources, BUILTIN_SOURCES } = await import('./agent-sources.js');

test.after(() => rmSync(home, { recursive: true, force: true }));

test('pick resolves dot-paths and falls through alternatives', () => {
  const row = { message: { usage: { input_tokens: 42 } } };
  assert.equal(pick(row, ['message.usage.input_tokens']), 42);
  // Field-name variation between agents is the whole reason for a list.
  assert.equal(pick(row, ['usage.input', 'message.usage.input_tokens']), 42);
  assert.equal(pick(row, ['nope.missing']), undefined);
  assert.equal(pick(null, ['a.b']), undefined);
});

test('only Claude Code claims a verified format', () => {
  // Claiming support that silently records nothing is the worst failure an
  // observability tool can have, so unverified sources must say so.
  const verified = BUILTIN_SOURCES.filter((s) => s.status === 'verified').map((s) => s.id);
  assert.deepEqual(verified, ['claude-code']);
  for (const s of BUILTIN_SOURCES) {
    if (s.status === 'unverified') assert.ok(s.note, `${s.id} should explain where its format came from`);
  }
});

test('discover finds log files under a source root', () => {
  const dir = join(home, 'logs', 'nested');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'a.jsonl'), '{}\n');
  writeFileSync(join(dir, 'ignored.txt'), 'nope');

  const found = discover(
    {
      id: 'test',
      label: 'Test',
      roots: [join(home, 'logs')],
      fileSuffix: '.jsonl',
      status: 'verified',
      fields: { inputTokens: [], outputTokens: [], model: [], timestamp: [] },
    },
    home,
  );

  assert.equal(found.length, 1, 'only the .jsonl file should match');
  assert.ok(found[0].sessionId.startsWith('test:'));
});

test('discover returns nothing for a root that does not exist', () => {
  const found = discover(
    {
      id: 'absent',
      label: 'Absent',
      roots: [join(home, 'no-such-dir')],
      fileSuffix: '.jsonl',
      status: 'unverified',
      fields: { inputTokens: [], outputTokens: [], model: [], timestamp: [] },
    },
    home,
  );
  assert.equal(found.length, 0);
});

test('a user source with an existing id replaces the built-in', () => {
  // This is how someone fixes a field map we got wrong without waiting for a
  // release - the point of the whole config-driven design.
  const file = join(home, 'sources.json');
  writeFileSync(
    file,
    JSON.stringify({
      sources: [
        {
          id: 'copilot-cli',
          label: 'My Copilot',
          roots: ['custom'],
          fileSuffix: '.jsonl',
          status: 'verified',
          fields: { inputTokens: ['x'], outputTokens: ['y'], model: ['m'], timestamp: ['t'] },
        },
      ],
    }),
  );

  const sources = allSources(file);
  const copilot = sources.find((s) => s.id === 'copilot-cli')!;
  assert.equal(copilot.label, 'My Copilot', 'the user definition should win');
  assert.ok(sources.some((s) => s.id === 'claude-code'), 'built-ins should survive');
});

test('a malformed sources.json does not break the built-ins', () => {
  const file = join(home, 'broken.json');
  writeFileSync(file, '{ not json');
  assert.ok(allSources(file).length >= BUILTIN_SOURCES.length);
});
