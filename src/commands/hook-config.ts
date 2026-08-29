/**
 * Generates the Claude Code hook settings block.
 *
 * Shape verified against Claude Code's hooks reference: a `hooks` object keyed
 * by event name, each holding matcher groups whose `hooks` array carries
 * `{ type: "command", command }`. The matcher is a pipe-separated list of
 * literal tool names (or a regex); an empty matcher means "every tool".
 *
 * One binary serves every event and branches on `hook_event_name`, which keeps
 * the user's settings file short and means an upgrade never requires them to
 * re-paste a different set of commands.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

/**
 * Absolute path to the agentobs-hook entrypoint.
 *
 * An absolute path is used rather than the bare command name because Claude
 * Code runs hooks with a non-login shell whose PATH often omits the npm global
 * bin directory - the most common reason a hook silently never fires.
 */
export function hookCommandPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/commands -> package root
  const candidate = resolve(here, '..', '..', 'bin', 'agentobs-hook');
  if (existsSync(candidate)) return candidate;
  return 'agentobs-hook';
}

/** The events worth hooking, with the matcher each one needs. */
const EVENTS: Array<{ event: string; matcher?: string }> = [
  // Empty matcher: observe (and police) every tool, not a hand-listed subset
  // that would silently miss MCP tools and anything added in future.
  { event: 'PreToolUse', matcher: '' },
  { event: 'PostToolUse', matcher: '' },
  { event: 'SessionStart' },
  { event: 'SessionEnd' },
];

export function buildHookSettings(command: string): Record<string, unknown> {
  const hooks: Record<string, unknown[]> = {};
  for (const { event, matcher } of EVENTS) {
    const group: Record<string, unknown> = {};
    if (matcher !== undefined) group.matcher = matcher;
    group.hooks = [{ type: 'command', command }];
    hooks[event] = [group];
  }
  return { hooks };
}

export function renderHookSettings(command: string): string {
  // Quote the path for JSON; Windows paths carry backslashes that must escape.
  return JSON.stringify(buildHookSettings(command), null, 2);
}

/** Path to the user-level Claude Code settings file, for messaging only. */
export function claudeSettingsPath(homeDir: string): string {
  return join(homeDir, '.claude', 'settings.json');
}
