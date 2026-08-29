# Contributing to AgentObs

## Adding an adapter for another agent

An adapter's only job is to turn one agent's native output into `AgentEvent`s.
Storage, redaction, pricing, and the dashboard are shared — you never touch the
database directly.

### 1. Decide the integration point

In descending order of quality:

1. **A hook / plugin API** (like Claude Code's) — gives per-tool-call detail and
   the ability to *block* a call. Fidelity: `rich`.
2. **A structured log** the agent already writes — if it is JSONL, `agentobs
   watch` may already handle it. Fidelity: `rich`.
3. **Process wrapping** — always available, always coarse. Fidelity: `coarse`.

Research what the agent actually supports before writing code. Do not assume
hook parity with Claude Code; most agents do not have it.

### 2. Implement `AgentAdapter`

```ts
import type { AgentAdapter, AgentEvent } from './types.js';
import { createSink } from './sink.js';

export class MyAgentAdapter implements AgentAdapter {
  readonly name = 'my-agent';
  readonly fidelity = 'rich' as const;
  private sink = createSink(this.name);

  ingest(event: AgentEvent): void {
    this.sink(event);
  }
}
```

### 3. Rules

- **Never write to the database directly.** Go through `createSink()`. That is
  what guarantees redaction cannot be bypassed.
- **Never pre-redact.** Pass raw input through; the sink redacts. Redacting
  twice mangles the summary.
- **Never throw.** An adapter runs inside the user's agent. A crash in the
  monitoring layer must never break the thing being monitored — catch, log
  under `AGENTOBS_DEBUG`, and carry on.
- **Never invent numbers.** If the agent does not report tokens, leave them
  `null`. A fabricated cost is worse than a blank one.
- **Declare fidelity honestly.** `coarse` if you only have session-level data.
  The dashboard labels it, so users are never misled.

### 4. Register and document

Add the adapter to `src/adapters/`, wire a CLI command in `src/cli.ts`, and add
a row to the agent-support table in the README stating exactly how rich its data
is.

## Development

```bash
npm install
npm run build
npm test
```

Tests use `node --test`. The redaction suite in `src/core/redact.test.ts` is the
security boundary — if you touch `redact.ts`, add a case there.
