/**
 * `agentobs mcp` - an MCP server exposing AgentObs data to the agent itself.
 *
 * Lets you ask Claude "how much have I spent today?" or "am I about to hit my
 * limit?" and have it answer from real local data instead of guessing. It also
 * closes a loop the dashboard cannot: the agent can check its own budget
 * before starting expensive work.
 *
 * Implements the JSON-RPC subset MCP stdio servers actually need
 * (initialize / tools/list / tools/call) rather than pulling in the SDK -
 * this is a handful of read-only tools, and the zero-dependency posture is
 * part of why `npx agentobs` installs in a second.
 */
import { openDb } from '../core/db.js';
import { checkBudgets } from '../core/budget.js';
import { forecastBudget, humanDuration } from '../core/forecast.js';
import { getProjects, getSummary, getToolsBreakdown, type Range } from '../core/queries.js';

const PROTOCOL_VERSION = '2024-11-05';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

const money = (v: number | null): string => (v === null ? 'unknown' : `$${v.toFixed(2)}`);

function toRange(value: unknown): Range {
  return value === 'today' || value === '7d' || value === '30d' || value === 'all' ? value : 'today';
}

const TOOLS = [
  {
    name: 'get_usage',
    description:
      'Cost, tokens, tool calls and error rate for a period. Use when asked how much has been spent or used.',
    inputSchema: {
      type: 'object',
      properties: {
        range: {
          type: 'string',
          enum: ['today', '7d', '30d', 'all'],
          description: 'Time range. Defaults to today.',
        },
      },
    },
  },
  {
    name: 'get_budget_status',
    description:
      'Current spend against configured budgets, with a burn-rate forecast of when each limit will be reached. Use before starting expensive work, or when asked whether a limit is close.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_projects',
    description:
      'Spend and activity grouped by working directory. Use when asked which project or repo is costing the most.',
    inputSchema: {
      type: 'object',
      properties: {
        range: { type: 'string', enum: ['today', '7d', '30d', 'all'] },
      },
    },
  },
  {
    name: 'get_top_tools',
    description:
      'Which tools are used most, with their error rates and cost. Use when asked where time or money is going.',
    inputSchema: {
      type: 'object',
      properties: {
        range: { type: 'string', enum: ['today', '7d', '30d', 'all'] },
      },
    },
  },
];

function callTool(name: string, args: Record<string, unknown>): string {
  const db = openDb();

  switch (name) {
    case 'get_usage': {
      const s = getSummary(db, toRange(args.range));
      const lines = [
        `Range: ${s.range}`,
        `Cost: ${money(s.total_cost_usd)}`,
        `Tool calls: ${s.tool_calls}`,
        `Sessions: ${s.sessions}`,
        `Tokens: ${s.tokens_in.toLocaleString()} in / ${s.tokens_out.toLocaleString()} out`,
        `Errors: ${s.errors} (${(s.error_rate * 100).toFixed(1)}%)`,
        `Blocked by policy: ${s.blocked}`,
      ];
      // Say when the total is knowably incomplete rather than letting the
      // agent repeat a partial figure as if it were the whole spend.
      if (s.uncosted_calls > 0) {
        lines.push(
          `Note: ${s.uncosted_calls} call(s) have no price for their model, so the cost under-reports.`,
        );
      }
      if (s.coarse_sessions > 0 && s.tool_calls === 0) {
        lines.push(
          'Note: all sessions are coarse (process-wrapped), which record no tool calls or tokens.',
        );
      }
      return lines.join('\n');
    }

    case 'get_budget_status': {
      const statuses = checkBudgets(db, { record: false });
      if (statuses.length === 0) {
        return 'No budgets are set. The user can add one with: agentobs budget set --daily 5';
      }
      return statuses
        .map((s) => {
          const unit = s.unit === 'tokens' ? 'tokens' : 'USD';
          const f = forecastBudget(db, s);
          const parts = [
            `${s.budget.period}: ${s.spent.toFixed(s.unit === 'tokens' ? 0 : 2)} of ${s.limit} ${unit} (${Math.round(s.ratio * 100)}%)`,
            `action: ${s.budget.action}`,
          ];
          if (s.exceeded) {
            parts.push('LIMIT REACHED' + (s.budget.action === 'block' ? ' - tool calls are being blocked' : ''));
          } else if (f.minutesToLimit !== null && f.willExceed) {
            parts.push(`projected to hit the limit in ${humanDuration(f.minutesToLimit)} at the current rate`);
          } else if (f.confidence === 'none') {
            parts.push(f.note ?? 'not enough activity to forecast');
          } else {
            parts.push('on track to stay within the limit');
          }
          return parts.join(' | ');
        })
        .join('\n');
    }

    case 'get_projects': {
      const rows = getProjects(db, toRange(args.range)).slice(0, 10);
      if (rows.length === 0) return 'No sessions recorded.';
      return rows
        .map((r) => `${r.project}: ${money(r.cost_usd)}, ${r.tool_calls} calls, ${r.sessions} sessions`)
        .join('\n');
    }

    case 'get_top_tools': {
      const rows = getToolsBreakdown(db, toRange(args.range)).slice(0, 10);
      if (rows.length === 0) return 'No tool calls recorded.';
      return rows
        .map((r) => `${r.tool_name}: ${r.calls} calls, ${r.errors} errors, ${money(r.cost_usd)}`)
        .join('\n');
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

function respond(id: unknown, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function respondError(id: unknown, code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

export async function mcp(): Promise<void> {
  process.stdin.setEncoding('utf8');
  let buffer = '';

  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    // Line-delimited JSON-RPC: process whole lines, keep any partial tail.
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;

      let req: JsonRpcRequest;
      try {
        req = JSON.parse(line) as JsonRpcRequest;
      } catch {
        continue; // malformed line - ignore rather than kill the server
      }

      try {
        switch (req.method) {
          case 'initialize':
            respond(req.id, {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: 'agentobs', version: '1' },
            });
            break;

          case 'tools/list':
            respond(req.id, { tools: TOOLS });
            break;

          case 'tools/call': {
            const name = String(req.params?.name ?? '');
            const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
            const text = callTool(name, args);
            respond(req.id, { content: [{ type: 'text', text }] });
            break;
          }

          case 'notifications/initialized':
            break; // a notification: no id, no response

          default:
            if (req.id !== undefined && req.id !== null) {
              respondError(req.id, -32601, `Method not found: ${req.method}`);
            }
        }
      } catch (err) {
        if (req.id !== undefined && req.id !== null) {
          respondError(req.id, -32603, (err as Error).message);
        }
      }
    }
  });

  // Hold the process open for the lifetime of the stdio connection.
  await new Promise<void>((resolve) => {
    process.stdin.on('end', resolve);
    process.stdin.on('close', resolve);
  });
}
