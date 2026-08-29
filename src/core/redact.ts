/**
 * Secret redaction for anything that lands in input_summary/output_summary.
 *
 * This runs before a summary is written to disk or pushed to the cloud, and
 * it is the single reason a hosted tier is trustworthy enough to use: an
 * agent's tool calls routinely contain exactly the credentials that would be
 * most damaging to leak (a `Bash` call exporting an API key, an `Edit`
 * writing a .env file, a curl carrying an Authorization header).
 *
 * Design posture is deliberately over-eager. A false positive costs a user
 * some readability in one dashboard row; a false negative writes a live
 * credential to a database and possibly into a shared team view. Those costs
 * are not symmetric, so when a token merely *looks* like a secret, it goes.
 *
 * Ordering matters: vendor-specific patterns run before the generic
 * structural ones so a recognisable key is labelled by provider
 * (`[REDACTED:aws-access-key-id]`) rather than the vague
 * `[REDACTED:assignment]`. That makes an audit of "what did we nearly leak"
 * far more actionable. The structural rules then skip any value that already
 * carries a marker, so they can never relabel a precise hit.
 */

export interface RedactionRule {
  name: string;
  pattern: RegExp;
  /**
   * 1-based index of the capture group holding the secret. When set, only
   * that group is replaced and the surrounding context (`KEY=`, `Bearer `)
   * survives, which keeps the row readable. When unset the whole match goes.
   */
  group?: number;
}

/**
 * Vendor-specific credential shapes, matched on distinctive prefixes and so
 * effectively free of false positives.
 */
const VENDOR_RULES: RedactionRule[] = [
  { name: 'aws-access-key-id', pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { name: 'anthropic-api-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'openai-api-key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { name: 'github-token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g },
  { name: 'gitlab-token', pattern: /\bglpat-[A-Za-z0-9_-]{18,}/g },
  { name: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'stripe-key', pattern: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { name: 'resend-key', pattern: /\bre_[A-Za-z0-9_-]{16,}/g },
  { name: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { name: 'sendgrid-key', pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g },
  { name: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{30,}/g },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { name: 'private-key-block', pattern: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g },
];

/**
 * A secret-ish *name*. The structural rules below key off this rather than
 * the value's shape, which is what catches the long tail no vendor list can
 * (`DB_PASSWORD=hunter2`, `--token abc`, `"client_secret": "..."`).
 */
const SENSITIVE_NAME =
  String.raw`[A-Za-z0-9_.-]*(?:passwd|password|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth|credential|session[_-]?id|cookie|passphrase|signing[_-]?key|webhook[_-]?secret|dsn)[A-Za-z0-9_.-]*`;

/** Value shapes: a quoted string, or a bare run of non-delimiter chars. */
const QUOTED_OR_BARE = String.raw`"[^"\n]{4,}"|'[^'\n]{4,}'|[^\s,;"'\n})]{4,}`;

/** Skips a value a vendor rule already replaced, so labels stay precise. */
const NOT_ALREADY_REDACTED = String.raw`(?!\[REDACTED:)`;

const STRUCTURAL_RULES: RedactionRule[] = [
  // Authorization: Bearer <token>. Must run BEFORE `assignment`: the header
  // name "Authorization" itself matches SENSITIVE_NAME, so assignment would
  // otherwise consume the scheme word `Bearer` as the value and leave the
  // real credential sitting in the clear after it.
  {
    name: 'auth-header',
    pattern: new RegExp(
      String.raw`\b(Bearer|Basic|Token)(\s+)${NOT_ALREADY_REDACTED}([A-Za-z0-9_\-.=+/]{8,})`,
      'gi',
    ),
    group: 3,
  },
  // KEY=value, KEY: value, "key": "value"
  {
    name: 'assignment',
    pattern: new RegExp(
      String.raw`("?\b${SENSITIVE_NAME}"?\s*[:=]\s*)${NOT_ALREADY_REDACTED}(${QUOTED_OR_BARE})`,
      'gi',
    ),
    group: 2,
  },
  // CLI flags: --token abc, --api-key=abc
  {
    name: 'cli-flag',
    pattern: new RegExp(
      String.raw`(--?${SENSITIVE_NAME}[=\s]+)${NOT_ALREADY_REDACTED}("[^"\n]{4,}"|'[^'\n]{4,}'|[^\s"'\n]{4,})`,
      'gi',
    ),
    group: 2,
  },
  // Credentials embedded in a URL: proto://user:pass@host
  //
  // The userinfo halves exclude '[' and ']' so this cannot re-wrap a marker
  // a vendor rule already inserted. A plain NOT_ALREADY_REDACTED lookahead
  // is not enough here: "[REDACTED:github-token]" itself contains a ':',
  // so the rule would read "[REDACTED" as the username and re-redact the
  // rest into an unreadable "[REDACTED:[REDACTED:url-credentials]".
  {
    name: 'url-credentials',
    pattern: new RegExp(
      String.raw`(:\/\/[^\s:@/\[\]]{1,64}:)${NOT_ALREADY_REDACTED}([^\s@/\[\]]{1,256})(?=@)`,
      'g',
    ),
    group: 2,
  },
];

const ALL_RULES: RedactionRule[] = [...VENDOR_RULES, ...STRUCTURAL_RULES];

export interface RedactResult {
  text: string;
  /** Deduped names of rules that fired; surfaced in the UI as a badge. */
  redactions: string[];
}

/** Default summary cap: long enough to be useful, short enough to stay cheap. */
export const DEFAULT_MAX_LENGTH = 500;

/**
 * Redact secrets from `input`, then truncate.
 *
 * Redaction runs before truncation deliberately: truncating first could slice
 * a credential in half, leaving a fragment that matches no pattern but is
 * still sensitive (and, for a short key, still brute-forceable).
 */
export function redact(input: unknown, maxLength: number = DEFAULT_MAX_LENGTH): RedactResult {
  if (input === null || input === undefined) return { text: '', redactions: [] };

  let text = typeof input === 'string' ? input : safeStringify(input);
  const fired = new Set<string>();

  for (const rule of ALL_RULES) {
    // These regexes carry /g and are module-level constants, so lastIndex
    // must be reset: a stale value from a previous call would silently skip
    // matches near the start of this string.
    rule.pattern.lastIndex = 0;
    text = text.replace(rule.pattern, (...args: unknown[]) => {
      const match = args[0] as string;
      const groups = args.slice(1, -2) as (string | undefined)[];
      fired.add(rule.name);
      const secret = rule.group ? groups[rule.group - 1] : undefined;
      if (secret === undefined) return `[REDACTED:${rule.name}]`;
      return match.replace(secret, `[REDACTED:${rule.name}]`);
    });
  }

  if (text.length > maxLength) {
    text = `${text.slice(0, maxLength)}… (+${text.length - maxLength} chars)`;
  }

  return { text, redactions: [...fired] };
}

/** Convenience wrapper for callers that only want the cleaned text. */
export function redactText(input: unknown, maxLength?: number): string {
  return redact(input, maxLength).text;
}

/**
 * JSON.stringify that cannot throw. Tool payloads arrive from external
 * processes and may contain cycles or BigInts; the logging layer must never
 * be the thing that crashes the agent it is observing.
 */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return (
      JSON.stringify(value, (_key, val) => {
        if (typeof val === 'bigint') return val.toString();
        if (typeof val === 'object' && val !== null) {
          if (seen.has(val)) return '[Circular]';
          seen.add(val);
        }
        return val;
      }) ?? String(value)
    );
  } catch {
    return String(value);
  }
}

/** Exposed for tests and for `agentobs policy test` diagnostics. */
export const __ruleNames = ALL_RULES.map((r) => r.name);
