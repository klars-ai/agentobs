/**
 * `agentobs notify` - configure where alerts go.
 *
 * Same reasoning as `policy test`: a user must be able to confirm an alert
 * actually arrives before trusting it to reach them at 2am. A webhook that was
 * silently wrong is worse than no webhook, because it buys false confidence -
 * so `notify test` sends a real message to the real endpoint and reports what
 * came back.
 *
 * Nothing here is on by default. Until someone runs `notify set`, no
 * ~/.agentobs/notify.json exists and the network is never touched.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ensureHome } from '../core/paths.js';
import {
  isSendableUrl,
  loadNotifyConfig,
  notifyConfigPath,
  sendWebhook,
  type NotifyConfig,
  type NotifyEventKind,
} from '../core/webhook.js';

const ALL_EVENTS: NotifyEventKind[] = ['budget_exceeded', 'call_blocked', 'approval_requested'];

/** Reads the raw file, tolerating absence. Distinct from loadNotifyConfig, which validates. */
function readRaw(): NotifyConfig {
  const file = notifyConfigPath();
  if (!existsSync(file)) return { targets: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as NotifyConfig;
    return { ...parsed, targets: Array.isArray(parsed.targets) ? parsed.targets : [] };
  } catch {
    return { targets: [] };
  }
}

function write(config: NotifyConfig): string {
  ensureHome();
  const file = notifyConfigPath();
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return file;
}

/** Hides the secret part of a webhook URL when printing it back. */
function maskUrl(raw: string): string {
  try {
    const url = new URL(raw);
    // Slack and Discord both put the secret in the path, so only the host and
    // a short tail are shown - enough to tell two targets apart, not enough to
    // leak one out of a screenshot or a shared terminal.
    const tail = url.pathname.length > 8 ? `…${url.pathname.slice(-6)}` : url.pathname;
    return `${url.protocol}//${url.host}${tail}`;
  } catch {
    return '(unparseable url)';
  }
}

export interface NotifySetOptions {
  format?: string;
  events?: string;
}

export async function notifySet(url: string, opts: NotifySetOptions = {}): Promise<void> {
  if (!isSendableUrl(url)) {
    console.error(`Not a usable webhook URL: ${url}

It must be https, or http on localhost. Plain http to a remote host is
refused because a webhook URL usually contains a secret in its path, and
sending that in clear text would leak it.`);
    process.exitCode = 1;
    return;
  }

  const format = opts.format === 'json' ? 'json' : 'slack';

  let events: NotifyEventKind[] | undefined;
  if (opts.events) {
    const wanted = opts.events.split(',').map((e) => e.trim());
    const unknown = wanted.filter((e) => !ALL_EVENTS.includes(e as NotifyEventKind));
    if (unknown.length > 0) {
      console.error(`Unknown event: ${unknown.join(', ')}\nValid: ${ALL_EVENTS.join(', ')}`);
      process.exitCode = 1;
      return;
    }
    events = wanted as NotifyEventKind[];
  }

  const config = readRaw();
  // Re-adding the same URL updates it rather than sending twice.
  config.targets = [...config.targets.filter((t) => t.url !== url), { url, format }];
  if (events) config.events = events;

  const file = write(config);
  console.log(`Alerts will be sent to ${maskUrl(url)} (${format} format).
Saved: ${file}

Events: ${(config.events ?? ['budget_exceeded', 'call_blocked']).join(', ')}

Confirm it actually arrives before you rely on it:
  agentobs notify test`);
}

export async function notifyList(): Promise<void> {
  const raw = readRaw();
  if (raw.targets.length === 0) {
    console.log(`No alert destinations configured. Nothing is ever sent.

Add one:
  agentobs notify set https://hooks.slack.com/services/...

Slack and Discord webhooks both work as-is. For your own receiver:
  agentobs notify set https://example.com/hook --format json`);
    return;
  }

  console.log(`Alert destinations (${notifyConfigPath()}):\n`);
  for (const t of raw.targets) {
    const state = t.enabled === false ? 'disabled' : 'enabled';
    const usable = isSendableUrl(t.url) ? '' : '  [REFUSED: not https]';
    console.log(`  ${maskUrl(t.url)}\n    ${t.format ?? 'slack'} · ${state}${usable}`);
  }
  console.log(`\nEvents: ${(raw.events ?? ['budget_exceeded', 'call_blocked']).join(', ')}`);
}

export async function notifyRemove(url: string): Promise<void> {
  const raw = readRaw();
  const before = raw.targets.length;
  raw.targets = raw.targets.filter((t) => t.url !== url);

  if (raw.targets.length === before) {
    console.error(`No destination matching that URL. See what is configured:
  agentobs notify list`);
    process.exitCode = 1;
    return;
  }

  write(raw);
  console.log(`Removed ${maskUrl(url)}.`);
}

export async function notifyTest(): Promise<void> {
  const config = loadNotifyConfig();
  if (!config) {
    console.error(`No usable alert destination configured.

  agentobs notify set https://hooks.slack.com/services/...`);
    process.exitCode = 1;
    return;
  }

  console.log(`Sending a test alert to ${config.targets.length} destination(s)...`);

  // A test must go out regardless of the event filter - otherwise a user who
  // narrowed `events` gets silence here and cannot tell it from a broken URL.
  const delivered = await sendWebhook(
    {
      kind: 'budget_exceeded',
      title: 'AgentObs: test alert',
      detail: 'If you can read this, your alerts are working.',
      data: { test: true },
    },
    { ...config, events: ['budget_exceeded'] },
  );

  if (delivered === config.targets.length) {
    console.log(`Delivered to all ${delivered}.`);
    return;
  }

  console.error(`Delivered to ${delivered} of ${config.targets.length}.

A destination that did not accept it is usually one of:
  - the URL is wrong, or the webhook was revoked at the other end
  - the receiver wants an auth header (add "headers" in ${notifyConfigPath()})
  - it took longer than ${config.timeoutMs}ms to respond`);
  process.exitCode = 1;
}
