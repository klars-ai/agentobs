/**
 * `agentobs statusline` - a compact line for Claude Code's status bar.
 *
 * Claude Code pipes session JSON to this on stdin and prints whatever comes
 * back, on every render. Two consequences shape the whole design:
 *
 *  1. It must be fast. This runs constantly, so the DB is touched only when a
 *     budget exists, and one query answers everything.
 *  2. It must never fail loudly. A crash here would garble the user's status
 *     bar on every keystroke, so every path falls back to a plain string.
 *
 * The payload carries `rate_limits.five_hour.used_percentage` and `resets_at`
 * straight from Anthropic - the real numbers, not an approximation. When they
 * are present they are used verbatim; the local 5-hour estimate is only a
 * fallback for older versions that do not send them.
 */
import { openDb } from '../core/db.js';
import { checkBudgets } from '../core/budget.js';
import { forecastBudget, humanDuration } from '../core/forecast.js';

interface StatuslinePayload {
  model?: { display_name?: string };
  cost?: { total_cost_usd?: number };
  context_window?: { used_percentage?: number };
  rate_limits?: {
    five_hour?: { used_percentage?: number; resets_at?: number };
    seven_day?: { used_percentage?: number; resets_at?: number };
  };
  workspace?: { current_dir?: string };
}

export interface StatuslineOptions {
  /** Which segments to show, comma-separated. */
  show?: string;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    // A statusline invoked with no stdin must not hang the status bar.
    const timer = setTimeout(() => resolve(data), 900);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

const money = (v: number): string => (v < 0.01 ? `$${v.toFixed(3)}` : `$${v.toFixed(2)}`);

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(Math.round(n));
}

/** Minutes until a Unix-epoch-seconds timestamp. */
function minutesUntil(epochSeconds: number): number {
  return (epochSeconds * 1000 - Date.now()) / 60000;
}

export async function statusline(opts: StatuslineOptions = {}): Promise<void> {
  const segments: string[] = [];

  try {
    const raw = await readStdin();
    const payload: StatuslinePayload = raw.trim() ? JSON.parse(raw) : {};
    const want = (opts.show ?? 'limit,budget,cost,context').split(',').map((s) => s.trim());

    // 1. Anthropic's own rate-limit numbers, when the client sends them.
    // These are authoritative; nothing local can be more accurate.
    const fiveHour = payload.rate_limits?.five_hour;
    if (want.includes('limit') && typeof fiveHour?.used_percentage === 'number') {
      const used = Math.round(fiveHour.used_percentage);
      const resets = fiveHour.resets_at ? minutesUntil(fiveHour.resets_at) : null;
      const marker = used >= 90 ? '!!' : used >= 75 ? '!' : '';
      segments.push(
        `5h ${used}%${marker}` + (resets !== null && resets > 0 ? ` (${humanDuration(resets)})` : ''),
      );
    }

    // 2. Local budgets - the part no other statusline can show, because it
    // needs a limit the user set rather than usage alone.
    if (want.includes('budget')) {
      try {
        const statuses = checkBudgets(openDb(), { record: false });
        // Surface the budget closest to its limit; a status bar has room for
        // one, and the tightest one is the one worth seeing.
        const tightest = statuses.sort((a, b) => b.ratio - a.ratio)[0];
        if (tightest) {
          const pct = Math.round(tightest.ratio * 100);
          const unit = tightest.unit === 'tokens' ? compact(tightest.spent) : money(tightest.spent);
          const limit =
            tightest.unit === 'tokens' ? compact(tightest.limit) : money(tightest.limit);

          if (tightest.exceeded) {
            segments.push(`OVER ${unit}/${limit}`);
          } else {
            const f = forecastBudget(openDb(), tightest);
            // Only show a countdown when the limit is actually projected to
            // arrive first - otherwise it is noise.
            const eta =
              f.minutesToLimit !== null && f.willExceed
                ? ` -> ${humanDuration(f.minutesToLimit)}`
                : '';
            segments.push(`${unit}/${limit} ${pct}%${eta}`);
          }
        }
      } catch {
        // No database yet, or a locked one - skip the segment rather than
        // breaking the whole status bar.
      }
    }

    // 3. This session's cost, straight from the payload.
    const sessionCost = payload.cost?.total_cost_usd;
    if (want.includes('cost') && typeof sessionCost === 'number' && sessionCost > 0) {
      segments.push(`session ${money(sessionCost)}`);
    }

    // 4. Context window, which is the other thing that bites mid-task.
    const ctx = payload.context_window?.used_percentage;
    if (want.includes('context') && typeof ctx === 'number') {
      segments.push(`ctx ${Math.round(ctx)}%`);
    }
  } catch {
    // Any parse failure falls through to whatever segments were built.
  }

  process.stdout.write(segments.length > 0 ? segments.join('  ·  ') : 'agentobs');
}
