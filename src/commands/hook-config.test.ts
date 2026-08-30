import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { buildHookSettings, hookCommandPath } from './hook-config.js';

test('the hook command is executable on this platform', () => {
  // Regression: init printed the extensionless bin/agentobs-hook path on
  // Windows, which cmd.exe cannot execute ("not recognized as an internal or
  // external command"). Claude Code swallows that, so the hook silently never
  // ran and nothing was ever recorded - which looks like "no agent activity"
  // rather than a broken install.
  const cmd = hookCommandPath();
  assert.ok(cmd.length > 0);

  if (process.platform === 'win32') {
    assert.ok(
      /\.(cmd|bat|exe)$/i.test(cmd),
      `Windows needs an executable extension, got: ${cmd}`,
    );
  }

  // An absolute path must actually exist; a bare name is the PATH fallback.
  const isAbsolute = /^([A-Za-z]:[\/]|\/)/.test(cmd);
  if (isAbsolute) {
    assert.ok(existsSync(cmd), `hook path does not exist: ${cmd}`);
  }
});

test('the generated settings block has the shape Claude Code expects', () => {
  const settings = buildHookSettings('/path/to/agentobs-hook') as {
    hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>>;
  };

  for (const event of ['PreToolUse', 'PostToolUse', 'SessionStart', 'SessionEnd']) {
    const groups = settings.hooks[event];
    assert.ok(Array.isArray(groups), `${event} must be an array`);
    assert.equal(groups[0].hooks[0].type, 'command');
    assert.equal(groups[0].hooks[0].command, '/path/to/agentobs-hook');
  }

  // An empty matcher means "every tool"; a hand-listed subset would silently
  // miss MCP tools and anything added later.
  assert.equal(settings.hooks.PreToolUse[0].matcher, '');
  assert.equal(settings.hooks.PostToolUse[0].matcher, '');
});

test('the settings block serialises to valid JSON', () => {
  // It is printed for the user to paste; a serialisation bug would hand them
  // a broken settings file. Windows backslashes must survive the round trip.
  const rendered = JSON.stringify(buildHookSettings('C:\npm\agentobs-hook.cmd'), null, 2);
  const parsed = JSON.parse(rendered);
  assert.equal(parsed.hooks.PreToolUse[0].hooks[0].command, 'C:\npm\agentobs-hook.cmd');
});
