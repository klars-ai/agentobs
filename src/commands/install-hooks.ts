/**
 * Writes AgentObs hooks into the user's Claude Code settings.
 *
 * The alternative - printing JSON and asking someone to hand-merge it into a
 * file that already has content - is where most people give up. It is also
 * where they make mistakes: a settings.json with a trailing comma stops
 * Claude Code from loading at all.
 *
 * Safety rules, because this edits a file the user did not write:
 *  - always back up first, with the path reported
 *  - never touch anything but the four hook entries AgentObs owns
 *  - refuse rather than clobber a foreign hook on the same event
 *  - validate the result parses before replacing the original
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { hookCommandPath } from './hook-config.js';

export interface InstallResult {
  settingsPath: string;
  backupPath: string | null;
  installed: string[];
  skipped: Array<{ event: string; reason: string }>;
  alreadyCurrent: boolean;
}

const EVENTS: Array<{ event: string; matcher?: string }> = [
  { event: 'PreToolUse', matcher: '' },
  { event: 'PostToolUse', matcher: '' },
  { event: 'SessionStart' },
  { event: 'SessionEnd' },
];

/**
 * Where Claude Code keeps the settings file we install hooks into.
 *
 * CLAUDE_CONFIG_DIR must be honoured here for the same reason the transcript
 * importer honours it: a user who has relocated their Claude Code config would
 * otherwise get hooks written to a settings file Claude Code never reads, and
 * the failure is silent - `init` reports success, and nothing is ever recorded.
 * The two paths disagreeing is worse than either choice on its own.
 */
export function claudeSettingsFile(projectDir?: string): string {
  if (projectDir) return join(projectDir, '.claude', 'settings.json');
  const configured = process.env.CLAUDE_CONFIG_DIR;
  return configured
    ? join(configured, 'settings.json')
    : join(homedir(), '.claude', 'settings.json');
}

/** True when this hook entry is one of ours. */
function isAgentObsHook(entry: unknown): boolean {
  const cmd = (entry as { command?: unknown })?.command;
  return typeof cmd === 'string' && /agentobs-hook/i.test(cmd);
}

export function installHooks(opts: { projectDir?: string; force?: boolean } = {}): InstallResult {
  const settingsPath = claudeSettingsFile(opts.projectDir);
  const command = hookCommandPath();

  const result: InstallResult = {
    settingsPath,
    backupPath: null,
    installed: [],
    skipped: [],
    alreadyCurrent: false,
  };

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    const raw = readFileSync(settingsPath, 'utf8');
    try {
      settings = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch (err) {
      // Refuse to touch a file we cannot parse: rewriting it would discard
      // whatever the user has in there.
      throw new Error(
        `${settingsPath} is not valid JSON (${(err as Error).message}). ` +
          `Fix or move it, then run this again.`,
      );
    }

    // Back up before any write. Timestamped so repeated runs never overwrite
    // an earlier backup.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    result.backupPath = `${settingsPath}.agentobs-bak-${stamp}`;
    copyFileSync(settingsPath, result.backupPath);
  } else {
    mkdirSync(dirname(settingsPath), { recursive: true });
  }

  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  let changed = false;

  for (const { event, matcher } of EVENTS) {
    const existing = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];

    // Someone else's hook on this event is theirs, not ours to replace.
    const foreign = existing.filter((group) => {
      const inner = (group as { hooks?: unknown[] })?.hooks ?? [];
      return Array.isArray(inner) && inner.some((h) => !isAgentObsHook(h));
    });
    const ours = existing.filter((group) => {
      const inner = (group as { hooks?: unknown[] })?.hooks ?? [];
      return Array.isArray(inner) && inner.every((h) => isAgentObsHook(h));
    });

    if (foreign.length > 0 && !opts.force) {
      result.skipped.push({
        event,
        reason: 'another hook is already configured here (use --force to add alongside it)',
      });
      continue;
    }

    const alreadyCorrect =
      ours.length === 1 &&
      JSON.stringify(((ours[0] as { hooks?: unknown[] }).hooks ?? [])[0]) ===
        JSON.stringify({ type: 'command', command });

    if (alreadyCorrect && foreign.length === 0) continue;

    const group: Record<string, unknown> = {};
    if (matcher !== undefined) group.matcher = matcher;
    group.hooks = [{ type: 'command', command }];

    // Keep foreign hooks, replace only ours.
    hooks[event] = [...foreign, group];
    result.installed.push(event);
    changed = true;
  }

  if (!changed) {
    result.alreadyCurrent = result.skipped.length === 0;
    return result;
  }

  settings.hooks = hooks;

  const serialised = `${JSON.stringify(settings, null, 2)}\n`;
  // Parse what we are about to write. A malformed settings.json stops Claude
  // Code from starting, so this must never be the thing that breaks it.
  JSON.parse(serialised);
  writeFileSync(settingsPath, serialised, 'utf8');

  return result;
}

/** Removes only the hook entries AgentObs owns. */
export function uninstallHooks(opts: { projectDir?: string } = {}): InstallResult {
  const settingsPath = claudeSettingsFile(opts.projectDir);
  const result: InstallResult = {
    settingsPath,
    backupPath: null,
    installed: [],
    skipped: [],
    alreadyCurrent: false,
  };

  if (!existsSync(settingsPath)) return result;

  const raw = readFileSync(settingsPath, 'utf8');
  const settings = (raw.trim() ? JSON.parse(raw) : {}) as Record<string, unknown>;
  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (!hooks) return result;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  result.backupPath = `${settingsPath}.agentobs-bak-${stamp}`;
  copyFileSync(settingsPath, result.backupPath);

  for (const event of Object.keys(hooks)) {
    const kept = (hooks[event] as unknown[]).filter((group) => {
      const inner = (group as { hooks?: unknown[] })?.hooks ?? [];
      return !(Array.isArray(inner) && inner.length > 0 && inner.every((h) => isAgentObsHook(h)));
    });
    if (kept.length !== (hooks[event] as unknown[]).length) result.installed.push(event);
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }

  if (Object.keys(hooks).length === 0) delete settings.hooks;
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return result;
}
