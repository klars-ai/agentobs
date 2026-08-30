/**
 * Tests for the tool descriptions.
 *
 * The rule worth guarding is the negative one: an unknown tool must get no
 * description at all. MCP servers contribute arbitrary tool names, and a
 * plausible-sounding sentence invented about one would be exactly the
 * fabrication this project refuses everywhere else - and harder to spot,
 * because it would read perfectly well.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeTool, TOOL_INFO } from './tool-info.js';

/** Tool names actually observed in transcripts on a real machine. */
const OBSERVED = [
  'Bash',
  'Read',
  'Edit',
  'Write',
  'Grep',
  'Glob',
  'AskUserQuestion',
  'TodoWrite',
  'Monitor',
  'PowerShell',
  'Agent',
  'ScheduleWakeup',
  'ToolSearch',
  'WebFetch',
  'WebSearch',
  'TaskStop',
  'TaskOutput',
  'Artifact',
  'Skill',
  'EnterPlanMode',
  'ExitPlanMode',
  'SendUserFile',
  'SendMessage',
  'Workflow',
];

test('every tool seen in real transcripts has a description', () => {
  const missing = OBSERVED.filter((name) => describeTool(name) === null);
  assert.deepEqual(missing, [], `no description for: ${missing.join(', ')}`);
});

test('lookup is case-insensitive, since names vary by source', () => {
  assert.ok(describeTool('bash'));
  assert.ok(describeTool('Bash'));
  assert.ok(describeTool('BASH'));
});

test('an unknown tool gets nothing, not a guess', () => {
  assert.equal(describeTool('SomeToolWeHaveNeverSeen'), null);
  assert.equal(describeTool(''), null);
});

test('an MCP tool names its server rather than inventing a purpose', () => {
  const info = describeTool('mcp__github__create_issue');
  assert.ok(info, 'an MCP tool should say something');
  assert.match(info!.description, /"github" MCP server/);
  // The important half: it admits what it does not know.
  assert.match(info!.description, /does not know what this tool does/);
});

test('descriptions explain why the agent reaches for the tool', () => {
  // "Runs a shell command" alone does not answer "why 11,266 times".
  assert.match(TOOL_INFO.bash.description, /almost everything/i);
  // Reads are the usual cause of context growth, which is the actionable part.
  assert.match(TOOL_INFO.read.description, /context/i);
});

test('every description is a real sentence, not a stub', () => {
  for (const [name, info] of Object.entries(TOOL_INFO)) {
    assert.ok(info.description.length > 30, `${name} has a stub description`);
    assert.match(info.description, /\.$/, `${name} description does not end in a full stop`);
    assert.ok(info.category, `${name} has no category`);
  }
});
