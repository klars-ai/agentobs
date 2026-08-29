/**
 * `agentobs init` - first-run setup.
 *
 * Creates the home directory, the database, a starter pricing table, and
 * prints the exact Claude Code hook block for the user to paste. The printed
 * config is the whole onboarding experience, so it is copy-paste ready with
 * absolute paths already filled in rather than placeholders to edit.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { closeDb, ensureDeviceId, openDb } from '../core/db.js';
import { ensureHome, paths } from '../core/paths.js';
import { DEFAULT_PRICING, writeDefaultPricing } from '../core/pricing.js';
import { hookCommandPath, renderHookSettings } from './hook-config.js';

export interface InitOptions {
  force?: boolean;
}

export async function init(opts: InitOptions = {}): Promise<void> {
  const home = ensureHome();
  const db = openDb();
  const deviceId = ensureDeviceId(db);
  closeDb();

  if (opts.force && existsSync(paths.pricing())) {
    writeFileSync(paths.pricing(), `${JSON.stringify(DEFAULT_PRICING, null, 2)}\n`, 'utf8');
  } else {
    writeDefaultPricing();
  }

  console.log(`AgentObs initialised.

  Home      ${home}
  Database  ${paths.db()}
  Pricing   ${paths.pricing()}
  Device    ${deviceId}

Next: add this to your Claude Code settings so tool calls are recorded.
File: ~/.claude/settings.json  (or .claude/settings.json for one project)
`);

  console.log(renderHookSettings(hookCommandPath()));

  console.log(`
Then:
  agentobs dashboard          open the dashboard at http://127.0.0.1:4300
  agentobs run -- <command>   observe any other agent CLI (coarse detail)
  agentobs policy init        add guardrails that can block risky tool calls

Nothing leaves this machine. Tool inputs are truncated and secret-redacted
before they are written to disk.`);
}
