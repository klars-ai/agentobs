import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_POLICY,
  evaluate,
  globMatch,
  contextFromToolInput,
  loadPolicy,
  type Policy,
} from './policy-engine.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('globMatch is anchored, so a pattern cannot match a substring by accident', () => {
  // The bug this guards: an unanchored "rm -rf" would fire on "confirm -rfx".
  assert.ok(globMatch('*rm -rf*', 'sudo rm -rf /tmp/x', 'command'));
  assert.ok(!globMatch('rm -rf', 'confirm -rfx', 'command'));
  assert.ok(globMatch('rm -rf', 'RM -RF', 'command'), 'matching is case-insensitive');
});

test('command mode lets * cross a slash, path mode does not', () => {
  // A shell command is not a path. Under path semantics `*rm -rf*` fails to
  // match `rm -rf /` purely because of the slash - silently letting through
  // the exact command the rule exists to stop.
  assert.ok(globMatch('*rm -rf*', 'rm -rf /var/data', 'command'));
  assert.ok(!globMatch('*rm -rf*', 'rm -rf /var/data', 'path'));
});

test('globMatch handles * within a segment and ** across segments', () => {
  assert.ok(globMatch('**/.env*', 'app/config/.env.local'));
  assert.ok(globMatch('**/.env*', '.env'));
  assert.ok(globMatch('*.ts', 'index.ts'));
  assert.ok(!globMatch('*.ts', 'src/index.ts'), 'single star must not cross a / in path mode');
  assert.ok(globMatch('**/*.ts', 'src/deep/index.ts'));
  assert.ok(globMatch('file?.txt', 'file1.txt'));
});

test('globMatch escapes regex metacharacters in the pattern', () => {
  // A pattern like "a.b" must match a literal dot, not any character.
  assert.ok(globMatch('a.b', 'a.b'));
  assert.ok(!globMatch('a.b', 'axb'));
  assert.ok(globMatch('cost(usd)', 'cost(usd)'));
});

test('the default policy blocks rm -rf', () => {
  const verdict = evaluate(
    DEFAULT_POLICY,
    contextFromToolInput('Bash', { command: 'rm -rf node_modules' }),
  );
  assert.equal(verdict.decision, 'block');
  assert.equal(verdict.rule?.name, 'no-recursive-force-delete');
  assert.ok(verdict.message);
});

test('the default policy leaves ordinary commands alone', () => {
  const verdict = evaluate(DEFAULT_POLICY, contextFromToolInput('Bash', { command: 'npm test' }));
  assert.equal(verdict.decision, 'allow');
  assert.equal(verdict.rule, null);
});

test('.env edits need approval on both POSIX and Windows paths', () => {
  for (const p of ['/repo/.env', 'C:\\repo\\.env.production', 'app/.env.local']) {
    const verdict = evaluate(DEFAULT_POLICY, contextFromToolInput('Edit', { file_path: p }));
    assert.equal(verdict.decision, 'needs_approval', `expected approval for ${p}`);
  }
});

test('force-push needs approval', () => {
  const verdict = evaluate(
    DEFAULT_POLICY,
    contextFromToolInput('Bash', { command: 'git push --force origin main' }),
  );
  assert.equal(verdict.decision, 'needs_approval');
});

test('first matching rule wins, in file order', () => {
  const policy: Policy = {
    rules: [
      { name: 'narrow-allow', match: { tool: 'Bash', command_pattern: '*rm -rf ./tmp*' }, decision: 'allow' },
      { name: 'broad-block', match: { tool: 'Bash', command_pattern: '*rm -rf*' }, decision: 'block' },
    ],
    default_decision: 'allow',
  };
  assert.equal(
    evaluate(policy, contextFromToolInput('Bash', { command: 'rm -rf ./tmp/cache' })).rule?.name,
    'narrow-allow',
  );
  assert.equal(
    evaluate(policy, contextFromToolInput('Bash', { command: 'rm -rf /' })).rule?.name,
    'broad-block',
  );
});

test('a tool-only rule matches any input for that tool', () => {
  const policy: Policy = {
    rules: [{ name: 'no-web', match: { tool: 'WebFetch' }, decision: 'block' }],
    default_decision: 'allow',
  };
  assert.equal(evaluate(policy, contextFromToolInput('WebFetch', { url: 'x' })).decision, 'block');
  assert.equal(evaluate(policy, contextFromToolInput('Bash', { command: 'ls' })).decision, 'allow');
});

test('command aliases are all recognised', () => {
  // Agents name this field inconsistently; a missed alias means a guardrail
  // silently fails to match a command it was written to stop.
  for (const key of ['command', 'cmd', 'script', 'shell_command']) {
    const ctx = contextFromToolInput('Bash', { [key]: 'rm -rf /' });
    assert.equal(evaluate(DEFAULT_POLICY, ctx).decision, 'block', `alias ${key} not matched`);
  }
});

test('path aliases are all recognised', () => {
  for (const key of ['file_path', 'path', 'filename', 'target_file']) {
    const ctx = contextFromToolInput('Edit', { [key]: '/app/.env' });
    assert.equal(evaluate(DEFAULT_POLICY, ctx).decision, 'needs_approval', `alias ${key} missed`);
  }
});

test('default_decision applies when nothing matches', () => {
  const policy: Policy = { rules: [], default_decision: 'block' };
  assert.equal(evaluate(policy, contextFromToolInput('Bash', { command: 'ls' })).decision, 'block');
});

test('a malformed policy file fails open, with errors reported', () => {
  // A broken guardrail that blocks all work is worse than no guardrail.
  const dir = mkdtempSync(join(tmpdir(), 'agentobs-policy-'));
  const file = join(dir, 'policy.json');
  try {
    writeFileSync(file, '{ this is not json');
    const result = loadPolicy(file);
    assert.equal(result.policy.default_decision, 'allow');
    assert.ok(result.errors.length > 0, 'parse failure must be reported');
    assert.equal(evaluate(result.policy, contextFromToolInput('Bash', { command: 'rm -rf /' })).decision, 'allow');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a rule with no match criteria is rejected, not applied to everything', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentobs-policy-'));
  const file = join(dir, 'policy.json');
  try {
    writeFileSync(
      file,
      JSON.stringify({ rules: [{ name: 'oops', match: {}, decision: 'block' }], default_decision: 'allow' }),
    );
    const result = loadPolicy(file);
    assert.equal(result.policy.rules.length, 0, 'match-everything rule must be dropped');
    assert.ok(result.errors.some((e) => e.includes('every tool call')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an invalid decision value is rejected with a clear error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentobs-policy-'));
  const file = join(dir, 'policy.json');
  try {
    writeFileSync(
      file,
      JSON.stringify({
        rules: [{ name: 'typo', match: { tool: 'Bash' }, decision: 'blok' }],
        default_decision: 'allow',
      }),
    );
    const result = loadPolicy(file);
    assert.equal(result.policy.rules.length, 0);
    assert.ok(result.errors.some((e) => e.includes('blok')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing policy file is a valid state (observability without enforcement)', () => {
  const result = loadPolicy(join(tmpdir(), 'definitely-does-not-exist-policy.json'));
  assert.equal(result.source, 'none');
  assert.equal(result.errors.length, 0);
  assert.equal(result.policy.default_decision, 'allow');
});
