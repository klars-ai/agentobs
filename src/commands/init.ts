/**
 * `agentobs init` - first-run setup, with nothing left for the user to do.
 *
 * The earlier version printed a JSON block and asked the user to hand-merge it
 * into ~/.claude/settings.json. That is where people give up, and where they
 * break things: a settings.json with a stray comma stops Claude Code from
 * starting at all. So init now writes it for them, backs the file up first,
 * and reports exactly what it touched.
 *
 * It also imports existing history, because a dashboard with no data in it is
 * indistinguishable from a broken install.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { ensureDeviceId, openDb } from '../core/db.js';
import { ensureHome, paths } from '../core/paths.js';
import { DEFAULT_PRICING, writeDefaultPricing } from '../core/pricing.js';
import { writeDefaultPolicy } from '../core/policy-engine.js';
import { hookCommandPath, renderHookSettings } from './hook-config.js';
import { installHooks } from './install-hooks.js';

export interface InitOptions {
  force?: boolean;
  /** Print the hook config instead of installing it. */
  printHooks?: boolean;
  /**
   * commander turns `--no-hooks` into `hooks: false` and `--no-import` into
   * `import: false` - NOT noHooks/noImport. Reading the wrong key meant both
   * flags were silently ignored.
   */
  hooks?: boolean;
  import?: boolean;
  /** Install into a project's .claude/ rather than the user's. */
  project?: string;
}

export async function init(opts: InitOptions = {}): Promise<void> {
  const home = ensureHome();
  // Do NOT close here: the import below reopens the same file, and closing
  // and immediately reopening left the WAL lock held long enough that every
  // transcript failed with "database is locked".
  const db = openDb();
  const deviceId = ensureDeviceId(db);

  let pricingAdded: string[] = [];
  if (opts.force && existsSync(paths.pricing())) {
    writeFileSync(paths.pricing(), `${JSON.stringify(DEFAULT_PRICING, null, 2)}\n`, 'utf8');
  } else {
    // Tops up an existing table with models it lacks, so someone who installed
    // before a model shipped is not left with blank costs and no explanation.
    pricingAdded = writeDefaultPricing().added;
  }

  // A starter policy costs nothing and means the guardrails are real from the
  // first minute rather than a feature the user has to go and discover.
  const policyExisted = existsSync(paths.policy());
  writeDefaultPolicy();

  console.log(`AgentObs initialised.

  Home      ${home}
  Database  ${paths.db()}
  Pricing   ${paths.pricing()}${pricingAdded.length > 0 ? ` (added ${pricingAdded.length} new model${pricingAdded.length === 1 ? '' : 's'})` : ''}
  Policy    ${paths.policy()}${policyExisted ? ' (kept your existing rules)' : ' (starter rules)'}
  Device    ${deviceId}
`);

  if (opts.printHooks) {
    console.log(`Add this to ~/.claude/settings.json:\n`);
    console.log(renderHookSettings(hookCommandPath()));
    return;
  }

  if (opts.hooks !== false) {
    try {
      const r = installHooks({ projectDir: opts.project, force: opts.force });

      if (r.alreadyCurrent) {
        console.log(`Hooks already configured in ${r.settingsPath}\n`);
      } else if (r.installed.length > 0) {
        console.log(`Hooks installed in ${r.settingsPath}`);
        console.log(`  events : ${r.installed.join(', ')}`);
        if (r.backupPath) console.log(`  backup : ${r.backupPath}`);
        console.log('');
      }

      for (const s of r.skipped) {
        console.log(`  Skipped ${s.event}: ${s.reason}`);
      }
      // PreToolUse is not one hook among four - it is the only one that can
      // refuse a call. Skipping it leaves budgets and policy installed,
      // configurable, and completely inert. Reporting it as a plain "skipped"
      // would let someone set a limit and believe they were protected.
      if (r.skipped.some((s) => s.event === 'PreToolUse')) {
        console.log(`
  Without PreToolUse, AgentObs cannot block anything. Budgets and policy
  rules will still record and warn, but never refuse a call. To enforce:

    agentobs install-hooks --force

  which adds our hook alongside the existing one rather than replacing it.`);
      }
      if (r.skipped.length > 0) console.log('');

      if (r.installed.length > 0) {
        console.log('Restart Claude Code for the hooks to take effect.\n');
      }
    } catch (err) {
      // Never leave the user stuck: fall back to the printed block, which is
      // what they would have had anyway.
      console.log(`Could not update your settings automatically:
  ${(err as Error).message}

Add this to ~/.claude/settings.json yourself:
`);
      console.log(renderHookSettings(hookCommandPath()));
      console.log('');
    }
  }

  // Import last: it is the slow step, and it is also the one that makes the
  // dashboard worth opening straight away.
  if (opts.import !== false) {
    try {
      const { importCommand } = await import('./import.js');
      console.log('Importing your recent Claude Code history...\n');
      await importCommand({ days: 7 });
    } catch {
      console.log('No Claude Code history found to import (that is fine).\n');
    }
  }

  console.log(`Next:
  agentobs dashboard          open the dashboard at http://127.0.0.1:4300
  agentobs budget set --daily 5     warn when today's spend passes $5
  agentobs forecast           when will you hit your limit?

Nothing leaves this machine. Tool inputs are truncated and secret-redacted
before they are written to disk.`);
}
