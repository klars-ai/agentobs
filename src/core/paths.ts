/**
 * Filesystem layout for the AgentObs home directory.
 *
 * Everything lives under one directory so uninstalling is `rm -rf ~/.agentobs`
 * and backing up is copying it. AGENTOBS_HOME overrides the location, which
 * both the test suite and CI rely on to avoid touching a developer's real data.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

export function agentobsHome(): string {
  return process.env.AGENTOBS_HOME || join(homedir(), '.agentobs');
}

export const paths = {
  home: agentobsHome,
  db: () => join(agentobsHome(), 'agentobs.db'),
  pricing: () => join(agentobsHome(), 'pricing.json'),
  policy: () => join(agentobsHome(), 'policy.json'),
  auth: () => join(agentobsHome(), 'auth.json'),
  logs: () => join(agentobsHome(), 'logs'),
  hookLog: () => join(agentobsHome(), 'logs', 'hook.log'),
};

/** Creates the home directory tree if absent. Safe to call repeatedly. */
export function ensureHome(): string {
  const home = agentobsHome();
  mkdirSync(home, { recursive: true });
  mkdirSync(paths.logs(), { recursive: true });
  return home;
}
