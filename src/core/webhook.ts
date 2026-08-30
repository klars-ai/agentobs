/**
 * Outbound webhooks - the one place AgentObs is allowed to touch the network.
 *
 * This is the remote counterpart to notify.ts, which raises a desktop toast on
 * the machine the agent is running on. A toast is no use when the agent is on
 * a build box, or when the person who set the budget is not at that desk.
 *
 * Everything else in this tool is local by construction, and that is the whole
 * privacy claim. This module does not weaken it: nothing is sent unless the
 * user has written a destination into notify.json themselves, and there is no
 * default endpoint, no vendor, and nowhere for data to go that the user did not
 * name. "No telemetry" means we do not phone home - not that the user cannot
 * be told when their own agent is blocked.
 *
 * The problem it solves is real: a budget breach at 2am is currently silent
 * until someone looks at a terminal. Enforcement the user never learns about
 * is only half a guardrail.
 *
 * Three rules shape the implementation:
 *
 *  1. It must never block the agent. Notifying happens after the decision is
 *     recorded, and a dead endpoint or a hung TLS handshake must not stall a
 *     tool call - so every failure resolves quietly and a short timeout aborts.
 *  2. It must not leak. Payloads carry budget names and numbers, never tool
 *     inputs, file contents, prompts or paths, and the summary is redacted
 *     before it leaves.
 *  3. It must not spam. Alerts fire on the one-shot `newlyExceeded` edge that
 *     budget.ts already computes, so a breached budget notifies once per
 *     period, not once per tool call.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { budgetAmount } from './budget.js';
import { agentobsHome } from './paths.js';
import { redact } from './redact.js';

/** Where a notification goes. `url` is supplied by the user; there is no default. */
export interface NotifyTarget {
  /** Any https endpoint: a Slack incoming webhook, Discord, or your own server. */
  url: string;
  /**
   * Body shape. `slack` posts {text}, which Slack and Discord both accept;
   * `json` posts the structured event for your own receiver.
   */
  format?: 'slack' | 'json';
  /** Extra headers, for a receiver behind an auth token. */
  headers?: Record<string, string>;
  /** Set false to keep a target configured but silent. */
  enabled?: boolean;
}

export interface NotifyConfig {
  targets: NotifyTarget[];
  /** Which events to send. Defaults to budget breaches and blocked calls. */
  events?: NotifyEventKind[];
  /** Milliseconds before a slow endpoint is abandoned. */
  timeoutMs?: number;
}

export type NotifyEventKind = 'budget_exceeded' | 'call_blocked' | 'approval_requested';

export interface NotifyEvent {
  kind: NotifyEventKind;
  /** One line, already safe to display. */
  title: string;
  /** Optional supporting line. Redacted before sending. */
  detail?: string;
  /** Structured fields for a `json` receiver. Must not contain tool input. */
  data?: Record<string, unknown>;
}

const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_EVENTS: NotifyEventKind[] = ['budget_exceeded', 'call_blocked'];

export function notifyConfigPath(): string {
  return join(agentobsHome(), 'notify.json');
}

/**
 * Loads notify.json, or returns null when the user has not configured one.
 *
 * A malformed or unreadable config disables notifications rather than throwing.
 * This runs inside the hook path, where an exception would break the agent over
 * something as trivial as a stray comma.
 */
export function loadNotifyConfig(file = notifyConfigPath()): NotifyConfig | null {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as NotifyConfig;
    if (!Array.isArray(parsed.targets)) return null;
    const targets = parsed.targets.filter(
      (t) => t && typeof t.url === 'string' && t.enabled !== false && isSendableUrl(t.url),
    );
    if (targets.length === 0) return null;
    return {
      targets,
      events: parsed.events ?? DEFAULT_EVENTS,
      timeoutMs: parsed.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
  } catch {
    return null;
  }
}

/**
 * Refuses anything but http(s), and refuses plain http to a non-loopback host.
 *
 * A webhook URL often contains a secret in its path (Slack's does), so sending
 * one in clear text over the network would leak it. Loopback is allowed because
 * a local receiver is a legitimate way to bridge to a desktop notifier.
 */
export function isSendableUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
}

function body(target: NotifyTarget, event: NotifyEvent): string {
  const title = redact(event.title).text;
  const detail = event.detail ? redact(event.detail).text : undefined;

  if ((target.format ?? 'slack') === 'slack') {
    // Slack and Discord both accept a bare {text}, which makes one config
    // shape work for the two services people actually use.
    return JSON.stringify({ text: detail ? `${title}\n${detail}` : title });
  }
  return JSON.stringify({
    source: 'agentobs',
    kind: event.kind,
    title,
    detail,
    data: event.data ?? {},
    sent_at: new Date().toISOString(),
  });
}

/**
 * Sends one event to every configured target.
 *
 * Never throws and never rejects: the caller is usually a hook that has already
 * made its decision, and a notification failure must not change that decision
 * or delay the agent. Returns how many targets accepted, which is what the CLI
 * reports on `agentobs notify test`.
 */
export async function sendWebhook(
  event: NotifyEvent,
  config: NotifyConfig | null = loadNotifyConfig(),
): Promise<number> {
  if (!config) return 0;
  const wanted = config.events ?? DEFAULT_EVENTS;
  if (!wanted.includes(event.kind)) return 0;

  const timeout = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const results = await Promise.all(
    config.targets.map(async (target) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const res = await fetch(target.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(target.headers ?? {}) },
          body: body(target, event),
          signal: controller.signal,
        });
        return res.ok;
      } catch {
        // An unreachable endpoint is the user's problem to notice via
        // `agentobs notify test`, not a reason to disrupt their agent.
        return false;
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  return results.filter(Boolean).length;
}

/**
 * In-flight sends, so a short-lived process can drain them before exiting.
 *
 * The hook writes its decision to stdout and then calls process.exit, which
 * destroys any pending socket. Without this, a webhook started microseconds
 * earlier is killed before the request leaves - the alert silently never
 * arrives, which is the exact failure this feature exists to prevent.
 */
const pending = new Set<Promise<unknown>>();

/**
 * Fire-and-forget wrapper for hot paths.
 *
 * The caller's decision is never delayed by this; `drainWebhooks` is what
 * gives the request a bounded chance to finish, and only after the decision
 * has already been written.
 */
export function sendWebhookInBackground(event: NotifyEvent, config?: NotifyConfig | null): void {
  try {
    const task = sendWebhook(event, config === undefined ? loadNotifyConfig() : config).catch(
      () => 0,
    );
    pending.add(task);
    void task.finally(() => pending.delete(task));
  } catch {
    /* configuration failure must never reach the caller */
  }
}

/**
 * Waits for outstanding sends, up to `maxMs`.
 *
 * Bounded on purpose: a hung endpoint must not hold the hook process open and
 * leave the agent waiting on a process that has already decided. Whatever has
 * not finished by then is abandoned - a missed alert is bad, a wedged agent is
 * worse.
 */
export async function drainWebhooks(maxMs = 1_500): Promise<void> {
  if (pending.size === 0) return;
  await Promise.race([
    Promise.allSettled([...pending]),
    new Promise((resolve) => setTimeout(resolve, maxMs)),
  ]);
}

/** Formats a budget breach. Kept here so the CLI and the hook word it alike. */
export function budgetExceededEvent(input: {
  name: string;
  period: string;
  spent: number;
  limit: number;
  unit: 'usd' | 'tokens';
  action: 'warn' | 'block';
}): NotifyEvent {
  // Same formatter as the block message and the desktop toast, so a $0.0001
  // limit is not reported as "$0.00" here while reading correctly elsewhere.
  const fmt = (v: number): string => budgetAmount(v, input.unit);

  const verb = input.action === 'block' ? 'blocked' : 'warning';
  return {
    kind: 'budget_exceeded',
    title: `AgentObs: ${input.period} budget ${verb} — ${fmt(input.spent)} of ${fmt(input.limit)}`,
    detail:
      input.action === 'block'
        ? `Further tool calls are refused until the ${input.period} period resets.`
        : `The ${input.period} limit has been passed; calls are still allowed.`,
    data: {
      budget: input.name,
      period: input.period,
      spent: input.spent,
      limit: input.limit,
      unit: input.unit,
      action: input.action,
    },
  };
}
