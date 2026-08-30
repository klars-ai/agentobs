import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'agentobs-hooks-'));
process.env.AGENTOBS_HOME = join(home, 'agentobs');

const { installHooks, uninstallHooks } = await import('./install-hooks.js');

test.after(() => rmSync(home, { recursive: true, force: true }));

/** Creates a project dir whose .claude/settings.json holds `settings`. */
function project(name: string, settings: unknown): string {
  const dir = join(home, name);
  mkdirSync(join(dir, '.claude'), { recursive: true });
  if (settings !== undefined) {
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify(settings, null, 2));
  }
  return dir;
}

function read(dir: string): Record<string, any> {
  return JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'));
}

test('installs into a settings file that does not exist yet', () => {
  const dir = join(home, 'empty');
  mkdirSync(dir, { recursive: true });
  const r = installHooks({ projectDir: dir });
  assert.equal(r.installed.length, 4);
  assert.ok(read(dir).hooks.PreToolUse);
});

test('preserves everything else in an existing settings file', () => {
  // The whole point of writing the file for the user: if this loses their
  // permissions or theme, hand-editing would have been safer.
  const dir = project('populated', {
    permissions: { allow: ['Bash(npm:*)'] },
    theme: 'dark',
    hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: '/theirs.sh' }] }] },
  });
  installHooks({ projectDir: dir });
  const after = read(dir);

  assert.deepEqual(after.permissions, { allow: ['Bash(npm:*)'] });
  assert.equal(after.theme, 'dark');
  assert.equal(after.hooks.UserPromptSubmit[0].hooks[0].command, '/theirs.sh');
  assert.ok(after.hooks.PreToolUse, 'ours should be added alongside');
});

test('backs the file up before touching it', () => {
  const dir = project('backup', { theme: 'light' });
  const r = installHooks({ projectDir: dir });
  assert.ok(r.backupPath, 'a backup path should be reported');
  assert.equal(JSON.parse(readFileSync(r.backupPath!, 'utf8')).theme, 'light');
});

test('running twice is idempotent', () => {
  const dir = project('twice', {});
  installHooks({ projectDir: dir });
  const second = installHooks({ projectDir: dir });
  assert.equal(second.alreadyCurrent, true, 'a second run should change nothing');
  assert.equal(read(dir).hooks.PreToolUse.length, 1, 'must not stack duplicate entries');
});

test("refuses to replace someone else's hook on the same event", () => {
  // Silently clobbering another tool's guardrail would be the worst thing
  // this command could do.
  const dir = project('foreign', {
    hooks: { PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: '/guard.sh' }] }] },
  });
  const r = installHooks({ projectDir: dir });

  assert.ok(r.skipped.some((s) => s.event === 'PreToolUse'), 'PreToolUse should be skipped');
  assert.equal(read(dir).hooks.PreToolUse[0].hooks[0].command, '/guard.sh', 'theirs must survive');
  assert.ok(read(dir).hooks.SessionStart, 'other events should still install');
});

test('--force adds alongside a foreign hook rather than replacing it', () => {
  const dir = project('forced', {
    hooks: { PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: '/guard.sh' }] }] },
  });
  installHooks({ projectDir: dir, force: true });
  const entries = read(dir).hooks.PreToolUse;
  assert.equal(entries.length, 2, 'both hooks should be present');
  assert.equal(entries[0].hooks[0].command, '/guard.sh', 'theirs stays first');
});

test('refuses to touch a settings file that is not valid JSON', () => {
  // Rewriting an unparseable file would discard whatever is in it.
  const dir = join(home, 'broken');
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'settings.json'), '{ this is not json');
  assert.throws(() => installHooks({ projectDir: dir }), /not valid JSON/);
});

test('uninstall removes only our hooks', () => {
  const dir = project('uninstall', {
    theme: 'dark',
    hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: '/theirs.sh' }] }] },
  });
  installHooks({ projectDir: dir });
  uninstallHooks({ projectDir: dir });
  const after = read(dir);

  assert.equal(after.theme, 'dark');
  assert.equal(after.hooks.UserPromptSubmit[0].hooks[0].command, '/theirs.sh');
  assert.equal(after.hooks.PreToolUse, undefined, 'ours should be gone');
});
