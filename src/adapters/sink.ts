/**
 * Shared event sink: the one path from an AgentEvent to the database.
 *
 * Every adapter funnels through here, which is what keeps redaction and cost
 * rules impossible to bypass - an adapter cannot write a raw summary even by
 * accident, because it never touches the DB itself.
 */
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../core/db.js';
import {
  beginToolCall,
  completeToolCall,
  endSession,
  ensureSession,
  startSession,
} from '../core/repo.js';
import type { AgentEvent } from './types.js';

export function applyEvent(db: DatabaseSync, event: AgentEvent, agentName: string): void {
  switch (event.type) {
    case 'session_start':
      startSession(db, {
        id: event.sessionId,
        agentName: event.agentName ?? agentName,
        cwd: event.cwd,
        gitBranch: event.gitBranch,
        fidelity: event.fidelity ?? 'rich',
        startedAt: event.timestamp,
      });
      break;

    case 'session_end':
      endSession(db, event.sessionId, { exitCode: event.exitCode, endedAt: event.timestamp });
      break;

    case 'tool_call_start':
      // The parent session may never have been announced (agent started
      // before AgentObs was installed, or no SessionStart hook configured).
      // Synthesising it beats dropping the tool call.
      ensureSession(db, event.sessionId, agentName);
      beginToolCall(db, {
        id: event.toolCallId,
        sessionId: event.sessionId,
        toolName: event.toolName,
        input: event.input,
        model: event.model,
        startedAt: event.timestamp,
      });
      break;

    case 'tool_call_end':
      completeToolCall(db, event.toolCallId, {
        status: event.status,
        output: event.output,
        tokensIn: event.tokensIn,
        tokensOut: event.tokensOut,
        model: event.model,
        errorMessage: event.errorMessage,
        endedAt: event.timestamp,
      });
      break;
  }
}

/**
 * Creates a sink bound to the local database.
 *
 * Swallows and logs errors by design: an adapter runs inside the user's
 * agent, so a logging failure must degrade to missing data, never to a
 * crashed agent.
 */
export function createSink(agentName: string, db?: DatabaseSync) {
  const handle = db ?? openDb();
  return (event: AgentEvent): void => {
    try {
      applyEvent(handle, event, agentName);
    } catch (err) {
      if (process.env.AGENTOBS_DEBUG) {
        console.error(`[agentobs] failed to record ${event.type}:`, err);
      }
    }
  };
}
