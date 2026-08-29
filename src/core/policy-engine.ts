/**
 * Guardrail policy engine.
 *
 * Evaluates a proposed tool call against ~/.agentobs/policy.json and returns
 * a decision the PreToolUse hook enforces. Two properties matter more than
 * features here:
 *
 *  1. Fail open, loudly. A malformed policy file must never wedge the user's
 *     agent - a broken guardrail that blocks all work is worse than no
 *     guardrail. Parse errors degrade to default-allow and are reported.
 *  2. Predictable matching. Users must be able to reason about what a rule
 *     will do before it fires, which is what `agentobs policy test` is for.
 *     First matching rule wins, in file order.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { paths } from './paths.js';

export type Decision = 'allow' | 'block' | 'needs_approval';

export interface RuleMatch {
  /** Tool name; exact (case-insensitive) or "*" for any. */
  tool?: string;
  /** Glob matched against the command string of a Bash-like call. */
  command_pattern?: string;
  /** Glob matched against a file path argument. */
  path_pattern?: string;
}

export interface PolicyRule {
  /** Stable identifier shown in the dashboard and audit trail. */
  name?: string;
  match: RuleMatch;
  decision: Decision;
  /** Shown to the user (and the agent) when this rule blocks a call. */
  message?: string;
}

export interface Policy {
  rules: PolicyRule[];
  default_decision: Decision;
}

export const DEFAULT_POLICY: Policy = {
  rules: [
    {
      name: 'no-recursive-force-delete',
      match: { tool: 'Bash', command_pattern: '*rm -rf*' },
      decision: 'block',
      message: 'Recursive force-delete is blocked by AgentObs policy.',
    },
    {
      name: 'protect-env-files',
      match: { tool: '*', path_pattern: '**/.env*' },
      decision: 'needs_approval',
      message: 'Editing .env files needs a human decision - they hold credentials.',
    },
    {
      name: 'no-force-push',
      match: { tool: 'Bash', command_pattern: '*git push*--force*' },
      decision: 'needs_approval',
      message: 'Force-push rewrites shared history.',
    },
    {
      name: 'no-curl-pipe-shell',
      match: { tool: 'Bash', command_pattern: '*curl*|*sh*' },
      decision: 'block',
      message: 'Piping a downloaded script straight into a shell is blocked.',
    },
  ],
  default_decision: 'allow',
};

export interface PolicyLoadResult {
  policy: Policy;
  /** Parse/validation problems. Non-empty means we fell back to default-allow. */
  errors: string[];
  source: 'file' | 'default' | 'none';
}

/**
 * Loads and validates the policy file.
 *
 * Returns errors rather than throwing: the caller is usually a hook running
 * inside the user's agent, where an exception would surface as an agent
 * failure rather than a policy problem.
 */
export function loadPolicy(file?: string): PolicyLoadResult {
  const target = file ?? paths.policy();
  if (!existsSync(target)) {
    // No policy configured is a legitimate state - observability without
    // enforcement is Phase A's whole product.
    return { policy: { rules: [], default_decision: 'allow' }, errors: [], source: 'none' };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(target, 'utf8'));
  } catch (err) {
    return {
      policy: { rules: [], default_decision: 'allow' },
      errors: [`policy.json is not valid JSON: ${(err as Error).message}`],
      source: 'default',
    };
  }

  const errors: string[] = [];
  const parsed = raw as Partial<Policy>;
  const rules: PolicyRule[] = [];

  if (!Array.isArray(parsed.rules)) {
    errors.push('policy.json must have a "rules" array');
  } else {
    parsed.rules.forEach((rule, i) => {
      const where = rule?.name ? `rule "${rule.name}"` : `rule #${i + 1}`;
      if (!rule || typeof rule !== 'object') {
        errors.push(`${where} is not an object`);
        return;
      }
      if (!rule.match || typeof rule.match !== 'object') {
        errors.push(`${where} is missing a "match" object`);
        return;
      }
      if (!isDecision(rule.decision)) {
        errors.push(
          `${where} has an invalid decision "${rule.decision}" (allow|block|needs_approval)`,
        );
        return;
      }
      if (!rule.match.tool && !rule.match.command_pattern && !rule.match.path_pattern) {
        // A rule matching on nothing would fire on every call - almost
        // certainly a typo, and a destructive one if the decision is block.
        errors.push(`${where} has no match criteria; it would match every tool call`);
        return;
      }
      rules.push({ ...rule, name: rule.name ?? `rule-${i + 1}` } as PolicyRule);
    });
  }

  const fallback = isDecision(parsed.default_decision) ? parsed.default_decision : 'allow';
  if (parsed.default_decision !== undefined && !isDecision(parsed.default_decision)) {
    errors.push(`invalid default_decision "${parsed.default_decision}", using "allow"`);
  }

  return {
    policy: { rules, default_decision: fallback },
    errors,
    source: errors.length && rules.length === 0 ? 'default' : 'file',
  };
}

function isDecision(value: unknown): value is Decision {
  return value === 'allow' || value === 'block' || value === 'needs_approval';
}

export function writeDefaultPolicy(file?: string): string {
  const target = file ?? paths.policy();
  if (!existsSync(target)) {
    writeFileSync(target, `${JSON.stringify(DEFAULT_POLICY, null, 2)}\n`, 'utf8');
  }
  return target;
}

/**
 * Sentinel standing in for `**` between the two star-replacement passes.
 * NUL is used because it cannot legitimately appear in a policy pattern -
 * a printable placeholder (a space, say) would collide with patterns that
 * contain it, such as `*rm -rf*`.
 */
const DOUBLE_STAR = '\u0000';

/**
 * Minimal glob matcher, hand-rolled rather than pulling in a glob dependency:
 * this runs on the hot path of every tool call and the pattern surface is tiny.
 *
 * The regex is anchored, so a pattern must match the whole string. An
 * unanchored `rm -rf` would otherwise fire on `confirm -rfx`.
 *
 * `mode` decides what a bare `*` means, and getting it wrong is a security
 * bug in both directions:
 *
 *  - 'path'    - `*` stays within one segment, `**` crosses them. The normal
 *                glob contract users expect from a pattern like `**\/.env*`.
 *  - 'command' - `*` crosses `/` freely. A shell command is not a path; under
 *                path semantics `*rm -rf*` fails to match `rm -rf /` purely
 *                because the argument contains a slash, silently letting
 *                through the exact command the rule exists to stop.
 */
export function globMatch(
  pattern: string,
  value: string,
  mode: 'path' | 'command' = 'path',
): boolean {
  // A leading `**/` must also match a bare filename at the root: the whole
  // point of `**\/.env*` is protecting `.env`, and that file most often sits
  // in the working directory with no directory prefix at all. Standard glob
  // implementations make this prefix optional for the same reason.
  const optionalLeadingDirs = mode === 'path' && pattern.startsWith('**/');
  const body = optionalLeadingDirs ? pattern.slice(3) : pattern;

  const escaped = body.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const singleStar = mode === 'command' ? '.*' : '[^/]*';
  const rx = escaped
    .split('**')
    .join(DOUBLE_STAR)
    .split('*')
    .join(singleStar)
    .split(DOUBLE_STAR)
    .join('.*')
    .split('?')
    .join('.');

  const prefix = optionalLeadingDirs ? '(?:.*/)?' : '';
  return new RegExp(`^${prefix}${rx}$`, 'i').test(value);
}

export interface ToolCallContext {
  tool: string;
  /** Shell command for Bash-like tools. */
  command?: string | null;
  /** File path for Edit/Write/Read-like tools. */
  path?: string | null;
  /** Raw tool input, used as a fallback when command/path aren't broken out. */
  raw?: unknown;
}

export interface PolicyVerdict {
  decision: Decision;
  rule: PolicyRule | null;
  message: string | null;
}

/**
 * Evaluates a tool call. First matching rule wins, in file order, so a user
 * can put a narrow allow above a broad block and have it behave the way
 * reading top-to-bottom suggests.
 */
export function evaluate(policy: Policy, ctx: ToolCallContext): PolicyVerdict {
  for (const rule of policy.rules) {
    if (matches(rule.match, ctx)) {
      return {
        decision: rule.decision,
        rule,
        message: rule.message ?? defaultMessage(rule),
      };
    }
  }
  return { decision: policy.default_decision, rule: null, message: null };
}

function matches(match: RuleMatch, ctx: ToolCallContext): boolean {
  if (match.tool && match.tool !== '*') {
    if (match.tool.toLowerCase() !== ctx.tool.toLowerCase()) return false;
  }

  if (match.command_pattern) {
    const command = ctx.command ?? extractString(ctx.raw);
    if (!command || !globMatch(match.command_pattern, command, 'command')) return false;
  }

  if (match.path_pattern) {
    const path = ctx.path ?? extractString(ctx.raw);
    if (!path) return false;
    // Compare with forward slashes so one pattern works on Windows too - a
    // rule written as **\/.env* must not silently miss C:\repo\.env.
    if (!globMatch(match.path_pattern, path.replace(/\\/g, '/'))) return false;
  }

  return true;
}

/** Best-effort string view of an arbitrary tool input, for pattern matching. */
function extractString(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw === 'string') return raw;
  try {
    return JSON.stringify(raw);
  } catch {
    return null;
  }
}

function defaultMessage(rule: PolicyRule): string {
  return rule.decision === 'block'
    ? `Blocked by AgentObs policy rule "${rule.name}".`
    : `Rule "${rule.name}" requires approval before this can run.`;
}

/**
 * Pulls the command/path out of a tool input payload.
 *
 * Agents name these fields inconsistently (command vs cmd, file_path vs path
 * vs filename), so we check the known aliases rather than assuming one shape:
 * a missed field means a guardrail silently fails to match.
 */
export function contextFromToolInput(tool: string, input: unknown): ToolCallContext {
  const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const pick = (...keys: string[]): string | null => {
    for (const key of keys) {
      const val = obj[key];
      if (typeof val === 'string' && val.length > 0) return val;
    }
    return null;
  };
  return {
    tool,
    command: pick('command', 'cmd', 'script', 'shell_command'),
    path: pick('file_path', 'path', 'filename', 'notebook_path', 'target_file'),
    raw: input,
  };
}
