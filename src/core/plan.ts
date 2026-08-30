/**
 * Which Claude plan this machine is signed in to.
 *
 * This exists because of a real and badly misleading bug: AgentObs computed
 * cost from token counts at API list price and presented the result as spend.
 * On a subscription that number is not spend at all - a Max 5x user was shown
 * "$5,525.61 this week" when their actual outlay was a fixed monthly fee. The
 * arithmetic was right and the label was wrong, which is the worse of the two
 * failures because it looks authoritative.
 *
 * Claude Code records the plan in ~/.claude.json under oauthAccount. Reading
 * it costs nothing and lets the UI say what a figure means: real money on an
 * API key, and a list-price equivalent on a subscription.
 *
 * Nothing here is sent anywhere, and a missing or unreadable file simply means
 * "unknown", which is reported as such rather than guessed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type PlanKind = 'subscription' | 'api' | 'unknown';

export interface PlanInfo {
  kind: PlanKind;
  /** Raw tier string as Claude Code reports it, e.g. "default_claude_max_5x". */
  tier: string | null;
  /** Human label for the UI, e.g. "Claude Max 5x". */
  label: string | null;
}

/** Where Claude Code keeps its account state. */
function claudeConfigFile(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir ? join(dir, '.claude.json') : join(homedir(), '.claude.json');
}

/** Turns `default_claude_max_5x` into `Claude Max 5x`. */
export function tierLabel(tier: string | null): string | null {
  if (!tier) return null;
  const cleaned = tier.replace(/^default_/, '').replace(/_/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned
    .split(' ')
    .map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

let cache: PlanInfo | null = null;

/**
 * Reads the plan, memoised. Never throws: a malformed config must not break a
 * hook, and an unknown plan is a perfectly good answer.
 */
export function detectPlan(force = false): PlanInfo {
  if (cache && !force) return cache;

  const unknown: PlanInfo = { kind: 'unknown', tier: null, label: null };
  const file = claudeConfigFile();
  if (!existsSync(file)) {
    cache = unknown;
    return cache;
  }

  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      oauthAccount?: { organizationRateLimitTier?: string | null; seatTier?: string | null };
    };
    const account = parsed?.oauthAccount;
    if (!account) {
      // Signed in with an API key rather than an OAuth subscription: cost
      // figures then are real dollars.
      cache = { kind: 'api', tier: null, label: null };
      return cache;
    }

    const tier = account.organizationRateLimitTier ?? account.seatTier ?? null;
    cache = {
      kind: 'subscription',
      tier,
      label: tierLabel(tier),
    };
    return cache;
  } catch {
    cache = unknown;
    return cache;
  }
}

/** Test seam. */
export function __resetPlanCache(): void {
  cache = null;
}

/**
 * One line explaining what a cost figure means on this machine.
 *
 * Returned as null on an API plan, where a dollar figure needs no caveat.
 */
export function costCaveat(plan: PlanInfo = detectPlan()): string | null {
  if (plan.kind !== 'subscription') return null;
  const which = plan.label ?? 'your plan';
  return `You pay a flat fee on ${which} — this is what the same usage would cost on the API, not a bill. Cap what actually binds you with token budgets: agentobs budget set --block5h 200000 --tokens`;
}

/**
 * What to call the cost figure in a heading.
 *
 * "Spend" is a lie on a subscription: nobody spent it. Naming the number for
 * what it is costs one word and stops the headline contradicting the caveat
 * printed underneath it.
 */
export function costLabel(plan: PlanInfo = detectPlan()): string {
  return plan.kind === 'subscription' ? 'API-equivalent usage' : 'Spend';
}
