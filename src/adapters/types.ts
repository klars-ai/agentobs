/**
 * The adapter plugin interface.
 *
 * An adapter's job is to turn one agent's native output into AgentEvents.
 * Everything downstream - storage, redaction, pricing, the dashboard - is
 * shared, so a new agent integration only has to answer "how do I observe
 * this tool?" and never "how do I store it?".
 *
 * See CONTRIBUTING.md for a worked example of adding one.
 */

/**
 * How much detail an adapter can actually observe.
 *
 * This is surfaced in the dashboard rather than hidden, because implying
 * per-tool-call detail for a session that only has a start and an exit code
 * would make the whole product untrustworthy. Be honest about what you know.
 *
 *  - 'rich'   - individual tool calls, with inputs, outputs and timing.
 *  - 'coarse' - session-level only: duration, exit code, maybe token totals.
 */
export type Fidelity = 'rich' | 'coarse';

export type AgentEvent =
  | SessionStartEvent
  | SessionEndEvent
  | ToolCallStartEvent
  | ToolCallEndEvent;

export interface SessionStartEvent {
  type: 'session_start';
  sessionId: string;
  agentName: string;
  cwd?: string | null;
  gitBranch?: string | null;
  fidelity?: Fidelity;
  timestamp?: string;
}

export interface SessionEndEvent {
  type: 'session_end';
  sessionId: string;
  exitCode?: number | null;
  timestamp?: string;
}

export interface ToolCallStartEvent {
  type: 'tool_call_start';
  sessionId: string;
  /** Stable id, so the matching end event can find this call. */
  toolCallId: string;
  toolName: string;
  /** Raw input; redacted by the storage layer, never by the adapter. */
  input?: unknown;
  model?: string | null;
  timestamp?: string;
}

export interface ToolCallEndEvent {
  type: 'tool_call_end';
  toolCallId: string;
  status: 'success' | 'error' | 'blocked';
  output?: unknown;
  tokensIn?: number | null;
  tokensOut?: number | null;
  model?: string | null;
  errorMessage?: string | null;
  timestamp?: string;
}

/**
 * Implemented by every agent integration.
 *
 * `ingest` must not throw: an adapter runs inside (or alongside) the user's
 * agent, and an observability layer that crashes the thing it observes is
 * worse than no observability. Catch, log, and carry on.
 */
export interface AgentAdapter {
  /** Stable identifier, stored as sessions.agent_name (e.g. "claude-code"). */
  readonly name: string;
  /** The best fidelity this adapter can provide. */
  readonly fidelity: Fidelity;
  ingest(event: AgentEvent): void;
}
