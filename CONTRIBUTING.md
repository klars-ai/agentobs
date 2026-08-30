# Contributing to AgentObs

## Adding an adapter for another agent

Most agents need **no code at all**. Nearly every coding CLI writes a JSONL
session log; the formats differ in field names, not in shape. So start here and
only write TypeScript if this path genuinely cannot express the format.

### The fast path: a source definition

Declare where the logs live and which field names that agent uses, in
`~/.agentobs/sources.json`:

```json
{
  "sources": [{
    "id": "my-agent",
    "label": "My Agent",
    "roots": [".myagent/sessions"],
    "fileSuffix": ".jsonl",
    "status": "unverified",
    "fields": {
      "inputTokens": ["usage.input_tokens"],
      "outputTokens": ["usage.output_tokens"],
      "model": ["model"],
      "timestamp": ["timestamp"],
      "toolName": ["tool.name"]
    }
  }]
}
```

Each field takes a **list** of dot-paths, tried in order — the first that
resolves wins. That is how one definition covers an agent that changed its
format between versions: list the new path first, the old one after.

`roots` are relative to your home directory unless absolute. A definition whose
`id` matches a built-in **replaces** it, which is how you fix a field map we got
wrong without waiting for a release.

### Check it against real files

Guessing at field names and hoping is the failure mode this project cares most
about avoiding — a wrong path does not error, it silently records zero, which
looks exactly like a quiet week. So check:

```bash
agentobs agents:verify --agent my-agent
```

It samples your real logs and reports, field by field, which path resolved, how
many lines it hit, and an example value:

```
My Agent  [my-agent] (unverified)
  3 file(s) found, sampled 3; 412 JSON line(s)

  ok      inputTokens      210 hit(s) via usage.input_tokens  ->  1843
  MISSING outputTokens     no declared path resolved
  ok      timestamp        412 hit(s) via timestamp  ->  "2026-08-30T10:00:00Z"

  Not usable yet: outputTokens did not resolve.
```

It is **read-only** — nothing is written to your database, so it is safe to run
against a definition you do not trust yet. Fix the named field, run it again,
repeat until the token fields resolve.

Two things it will catch that a plain import will not:

- A path that resolves to the **wrong type** — pointing at a `usage` object
  rather than a number reads as a hit, then contributes zero tokens.
- A map where **only one** token field resolves. That is not a partial success;
  it silently halves every figure the tool reports.

### Contributing it back

Once `agents:verify` passes against your real logs, that definition is worth
more than documentation, because it has been checked against a real file.
[Open an issue](https://github.com/klars-ai/agentobs/issues) with the definition
and the verify output, and it can ship as a built-in.

A source is only marked `verified` in this repo when its field names came from
the agent's own source code or a confirmed real log — never from documentation
alone. Claiming support that silently records nothing is the worst failure an
observability tool can have, so `unverified` is a normal and honest state to
ship in, not a defect.

---

## Writing a TypeScript adapter

Only needed when a source definition cannot express the format — a non-JSONL
log, a hook API, or a wrapped process.

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
