/**
 * Claude Code hook adapter - the `agentobs-hook` entrypoint.
 *
 * Claude Code invokes this once per hook event with the event JSON on stdin.
 * It does two jobs in one process: record the call (observability) and, for
 * PreToolUse, evaluate the policy and return a decision (enforcement).
 *
 * Contract verified against Claude Code's hooks reference:
 *
 *  - Payload fields are snake_case: `session_id`, `tool_name`, `tool_input`,
 *    `tool_use_id`, `hook_event_name`, `cwd`, `transcript_path`.
 *  - PreToolUse blocks via `hookSpecificOutput.permissionDecision: "deny"`
 *    printed to stdout with exit code 0. Exit code 2 also blocks, but the
 *    JSON form is used here because it carries a reason string back to both
 *    the user and the agent. JSON is only honoured on exit 0.
 *  - PostToolUse carries NO token or cost fields. Per-call cost therefore
 *    cannot come from the hook; see transcript.ts, which reads the usage
 *    numbers Claude Code writes to its own transcript. Nothing here ever
 *    invents a token count.
 *  - SessionEnd hooks share a ~1.5s budget, so this must stay fast.
 *
 * Failure posture: this process sits in front of every tool call the user's
 * agent makes. Any unexpected error must exit 0 with no decision, letting the
 * call proceed - a crashed observability tool must never wedge the agent.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { openDb } from '../core/db.js';
import { ensureHome, paths } from '../core/paths.js';
import {
  beginToolCall,
  completeToolCall,
  endSession,
  ensureSession,
  recordPolicyDecision,
  startSession,
} from '../core/repo.js';
import { contextFromToolInput, evaluate, loadPolicy } from '../core/policy-engine.js';
import { blockingBudget, checkBudgets } from '../core/budget.js';
import { notify } from '../core/notify.js';
import { checkApproval, requestApproval } from '../core/approvals.js';
import { attachTranscriptUsage } from './transcript.js';

const AGENT_NAME = 'claude-code';

interface HookPayload {
  session_id?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_result?: unknown;
  tool_use_id?: string;
  cwd?: string;
  transcript_path?: string;
  reason?: string;
  session_start_reason?: string;
  model?: string;
}

/**
 * Deterministic tool-call id derived from Claude Code's own `tool_use_id`.
 *
 * PreToolUse and PostToolUse arrive as separate processes, so the pair has to
 * agree on an id without sharing memory. Using the agent's id makes that
 * automatic; the random fallback only applies when it's absent, in which case
 * the two halves simply won't be joined (better than mis-joining them).
 */
function toolCallId(payload: HookPayload): string {
  return payload.tool_use_id ?? randomUUID();
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    // A hook with no stdin should not hang the agent forever.
    process.stdin.on('error', () => resolve(data));
  });
}

/** Diagnostic log. Never throws - logging must not break the hook. */
function debugLog(message: string): void {
  if (!process.env.AGENTOBS_DEBUG) return;
  try {
    ensureHome();
    appendFileSync(paths.hookLog(), `${new Date().toISOString()} ${message}\n`);
  } catch {
    /* ignore */
  }
}

export interface HookResult {
  /** Printed to stdout for Claude Code to interpret. */
  stdout?: string;
  exitCode: number;
}

export function handleHook(payload: HookPayload): HookResult {
  const event = payload.hook_event_name;
  const sessionId = payload.session_id ?? 'unknown-session';
  const db = openDb();

  switch (event) {
    case 'SessionStart': {
      startSession(db, {
        id: sessionId,
        agentName: AGENT_NAME,
        cwd: payload.cwd ?? null,
        fidelity: 'rich',
      });
      return { exitCode: 0 };
    }

    case 'SessionEnd': {
      // Backfill token usage from the transcript before closing out: this is
      // the only place Claude Code exposes real usage numbers, and the
      // session is complete by now so the file is final.
      if (payload.transcript_path) {
        try {
          attachTranscriptUsage(db, sessionId, payload.transcript_path);
        } catch (err) {
          debugLog(`transcript backfill failed: ${String(err)}`);
        }
      }
      endSession(db, sessionId);
      return { exitCode: 0 };
    }

    case 'PreToolUse': {
      const toolName = payload.tool_name ?? 'unknown';
      const id = toolCallId(payload);
      ensureSession(db, sessionId, AGENT_NAME, payload.cwd ?? null);

      // Budgets first: an exceeded hard limit stops everything, however
      // benign the individual command looks.
      try {
        const budgets = checkBudgets(db);

        // Notify on the first crossing only - newlyExceeded is one-shot per
        // period, so this cannot turn into a notification per tool call.
        for (const b of budgets) {
          if (b.newlyExceeded) {
            const unit = b.unit === 'tokens' ? 'tokens' : 'USD';
            notify({
              title: `AgentObs: ${b.budget.period} limit reached`,
              body:
                `${b.spent.toFixed(b.unit === 'tokens' ? 0 : 2)} of ${b.limit} ${unit} used` +
                (b.budget.action === 'block' ? ' - tool calls are now blocked.' : '.'),
              urgent: b.budget.action === 'block',
            });
          }
        }

        const overspent = blockingBudget(budgets);
        if (overspent) {
          beginToolCall(db, {
            id,
            sessionId,
            toolName,
            input: payload.tool_input,
            status: 'blocked',
          });
          recordPolicyDecision(db, {
            toolCallId: id,
            sessionId,
            toolName,
            ruleMatched: `budget:${overspent.budget.period}`,
            decision: 'block',
            reason: `spend $${overspent.spent.toFixed(2)} exceeds the $${overspent.limit.toFixed(2)} ${overspent.budget.period} limit`,
          });
          return {
            stdout: JSON.stringify({
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason:
                  `AgentObs budget reached: $${overspent.spent.toFixed(2)} spent against a ` +
                  `$${overspent.limit.toFixed(2)} ${overspent.budget.period} limit. ` +
                  `Raise it with "agentobs budget set --${overspent.budget.period} <amount>" ` +
                  `or remove it with "agentobs budget remove ${overspent.budget.period}".`,
              },
            }),
            exitCode: 0,
          };
        }
      } catch (err) {
        // A budget check must never wedge the agent - fail open, like policy.
        debugLog(`budget check failed: ${String(err)}`);
      }

      const { policy, errors } = loadPolicy();
      for (const err of errors) debugLog(`policy: ${err}`);

      const verdict = evaluate(policy, contextFromToolInput(toolName, payload.tool_input));

      if (verdict.decision === 'allow') {
        beginToolCall(db, {
          id,
          sessionId,
          toolName,
          input: payload.tool_input,
          status: 'pending',
        });
        // No JSON output: fall through to Claude Code's normal permission
        // flow rather than force-allowing something the user's own settings
        // would have prompted about.
        return { exitCode: 0 };
      }

      // needs_approval now genuinely asks. The hook cannot prompt - stdin and
      // stdout belong to Claude Code - so it records the request, refuses this
      // attempt, and lets the agent's retry succeed once the user has said
      // yes. An approval already granted for this exact call passes straight
      // through.
      if (verdict.decision === 'needs_approval') {
        const existing = checkApproval(db, toolName, payload.tool_input);

        if (existing === 'approved') {
          beginToolCall(db, {
            id,
            sessionId,
            toolName,
            input: payload.tool_input,
            status: 'pending',
          });
          recordPolicyDecision(db, {
            toolCallId: id,
            sessionId,
            toolName,
            ruleMatched: verdict.rule?.name ?? null,
            decision: 'allow',
            reason: 'approved by the user',
          });
          return { exitCode: 0 };
        }

        const req = requestApproval(db, {
          sessionId,
          toolName,
          toolInput: payload.tool_input,
          ruleMatched: verdict.rule?.name ?? null,
        });

        beginToolCall(db, {
          id,
          sessionId,
          toolName,
          input: payload.tool_input,
          status: 'blocked',
        });
        recordPolicyDecision(db, {
          toolCallId: id,
          sessionId,
          toolName,
          ruleMatched: verdict.rule?.name ?? null,
          decision: 'needs_approval',
          reason: verdict.message,
        });

        if (existing !== 'denied') {
          notify({
            title: 'AgentObs: approval needed',
            body: `${toolName} is waiting on you. Run: agentobs approve ${req.id.slice(0, 8)}`,
            urgent: true,
          });
        }

        const reason =
          existing === 'denied'
            ? `${verdict.message} You denied this call. Run "agentobs approve ${req.id.slice(0, 8)}" to allow it, then try again.`
            : `${verdict.message} Approve it with "agentobs approve ${req.id.slice(0, 8)}" (or in the dashboard), then retry - the approval is remembered for 60 minutes.`;

        return {
          stdout: JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: reason,
            },
          }),
          exitCode: 0,
        };
      }

      // A plain block.
      beginToolCall(db, {
        id,
        sessionId,
        toolName,
        input: payload.tool_input,
        status: 'blocked',
      });
      recordPolicyDecision(db, {
        toolCallId: id,
        sessionId,
        toolName,
        ruleMatched: verdict.rule?.name ?? null,
        decision: verdict.decision,
        reason: verdict.message,
      });

      const reason = `${verdict.message} (AgentObs rule: ${verdict.rule?.name ?? 'unnamed'})`;

      return {
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
          },
        }),
        exitCode: 0,
      };
    }

    case 'PostToolUse': {
      const id = toolCallId(payload);
      const result = payload.tool_response ?? payload.tool_result;
      const errorMessage = extractError(result);
      completeToolCall(db, id, {
        status: errorMessage ? 'error' : 'success',
        output: result,
        errorMessage,
        // Deliberately no token counts: PostToolUse does not carry them, and
        // inventing a number would poison the cost figure this tool exists
        // to report. transcript.ts fills these in from the real transcript.
      });
      return { exitCode: 0 };
    }

    default:
      debugLog(`ignoring unknown hook event: ${event}`);
      return { exitCode: 0 };
  }
}

/** Pulls an error message out of a tool result, if it reads like a failure. */
function extractError(result: unknown): string | null {
  if (!result) return null;
  if (typeof result === 'string') {
    return /^(error|exception|traceback)\b/i.test(result.trim()) ? result : null;
  }
  if (typeof result === 'object') {
    const obj = result as Record<string, unknown>;
    if (obj.is_error === true || obj.isError === true) {
      return typeof obj.content === 'string' ? obj.content : JSON.stringify(obj).slice(0, 300);
    }
    if (typeof obj.error === 'string' && obj.error) return obj.error;
  }
  return null;
}

/** Process entrypoint for bin/agentobs-hook. */
export async function main(): Promise<void> {
  let result: HookResult = { exitCode: 0 };
  try {
    const raw = await readStdin();
    if (raw.trim()) {
      result = handleHook(JSON.parse(raw) as HookPayload);
    }
  } catch (err) {
    // Fail open, always. A hook that throws would surface inside the user's
    // agent as a tool failure caused by their monitoring tool.
    debugLog(`hook error: ${String(err)}`);
    result = { exitCode: 0 };
  }
  if (result.stdout) process.stdout.write(result.stdout);
  process.exit(result.exitCode);
}
