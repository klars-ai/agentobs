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

      // Blocked, or needs approval - which v1 treats as a block with a
      // clearer message, since there is no interactive approval channel from
      // inside a hook.
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

      const reason =
        verdict.decision === 'needs_approval'
          ? `${verdict.message} This needs your approval: edit ~/.agentobs/policy.json or run "agentobs policy test ${toolName} <input>" to check the rule.`
          : `${verdict.message} (AgentObs rule: ${verdict.rule?.name ?? 'unnamed'})`;

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
