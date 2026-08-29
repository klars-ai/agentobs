# AgentObs

**See every tool call, token, and dollar your AI coding agents spend — and stop them before they do something risky.**

AgentObs is an observability and control layer for AI coding agents. It runs
entirely on your machine: a CLI, a local SQLite database, and a dashboard. No
account, no cloud, no telemetry.

[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)

---

## Quick start

```bash
npm install -g @klars/agentobs
agentobs init
```

`init` prints a hook configuration block. Paste it into `~/.claude/settings.json`
(or a project's `.claude/settings.json`), then:

```bash
agentobs dashboard
```

Run Claude Code as usual. Tool calls appear in the dashboard within seconds.

---

## What you get

|                        |                                                              |
| ---------------------- | ------------------------------------------------------------ |
| **Cost tracking**      | Per session, per tool, per day — or blank if the model's price is unknown. Never guessed. |
| **Tool-call timeline** | Every call, its duration, status, and truncated input.        |
| **Guardrails**         | Block `rm -rf`, require approval for `.env` edits, stop `curl \| sh`. |
| **Audit trail**        | Every policy decision recorded with the rule that fired.      |
| **Any agent**          | Native Claude Code hooks; JSONL ingestion or process-wrapping for everything else. |

---

## Privacy

This is the part that matters most, since AgentObs sits in the middle of
everything your agent does.

- **Nothing leaves your machine.** No network calls, no analytics, no account.
- **Secrets are redacted before anything is written to disk.** Tool inputs and
  outputs pass through a redaction layer that recognises AWS keys, Anthropic /
  OpenAI / GitHub / GitLab / Slack / Stripe / Google / npm tokens, JWTs, PEM
  private keys, `KEY=value` assignments, `--flag secret` arguments,
  `Authorization:` headers, and credentials embedded in URLs.
- **Summaries are truncated** to ~500 characters.
- The redaction rules are unit-tested in
  [`src/core/redact.test.ts`](src/core/redact.test.ts) — the tests are the
  guarantee, and they have caught real leaks during development.

Everything lives in `~/.agentobs/`. Uninstalling is `rm -rf ~/.agentobs`.

---

## Commands

```
agentobs init                        Set up ~/.agentobs and print the hook config
agentobs dashboard [--port] [--host] Serve the dashboard (default 127.0.0.1:4300)
agentobs stats [--today] [--since]   Print totals in the terminal
agentobs run -- <command...>         Observe any command (coarse detail)
agentobs watch <file.jsonl>          Ingest a JSONL agent log
agentobs export --format csv|json    Export sessions, tool calls, or decisions

agentobs policy init                 Write a starter policy.json
agentobs policy check                Validate it and list active rules
agentobs policy test <tool> <input>  Dry-run a call against the policy
```

---

## Guardrails

`agentobs policy init` writes `~/.agentobs/policy.json`:

```json
{
  "rules": [
    {
      "name": "no-recursive-force-delete",
      "match": { "tool": "Bash", "command_pattern": "*rm -rf*" },
      "decision": "block",
      "message": "Recursive force-delete is blocked by AgentObs policy."
    },
    {
      "name": "protect-env-files",
      "match": { "tool": "*", "path_pattern": "**/.env*" },
      "decision": "needs_approval"
    }
  ],
  "default_decision": "allow"
}
```

Rules are evaluated top to bottom; **the first match wins**, so you can put a
narrow `allow` above a broad `block`. Check what a rule will do *before* it
fires mid-task:

```bash
$ agentobs policy test Bash "rm -rf ./build"

  Tool       Bash
  Input      rm -rf ./build
  Decision   BLOCK
  Rule       no-recursive-force-delete

  This call would be BLOCKED before running.
```

Two deliberate behaviours worth knowing:

- **`needs_approval` currently behaves as a block** with a clearer message.
  There is no channel for a hook to prompt you interactively mid-call.
- **A broken policy file fails open.** Invalid JSON or a malformed rule
  degrades to allow-everything and reports the problem, because a guardrail
  that wedges your agent is worse than no guardrail. Run `agentobs policy check`.

---

## Agent support

| Agent           | How                        | Detail                                            |
| --------------- | -------------------------- | ------------------------------------------------- |
| **Claude Code** | Native hooks               | **Rich** — every tool call, plus policy enforcement |
| Any CLI agent   | `agentobs run -- <cmd>`    | **Coarse** — duration and exit code only          |
| Custom / in-house | `agentobs watch <file>`  | **Rich**, if it writes JSONL                      |

The dashboard labels coarse sessions as `coarse` rather than implying detail it
does not have.

### A note on cost accuracy

Claude Code's `PostToolUse` hook payload carries **no token or cost fields**.
AgentObs therefore reads token usage from the session transcript at
`SessionEnd`, which makes **session-level cost accurate** but leaves
**per-tool-call cost blank** for hook-sourced data. It does not divide a total
across calls to manufacture a number.

Model prices live in `~/.agentobs/pricing.json` and are yours to edit. A model
missing from that file shows cost as `—`, never `$0.00`.

---

## Dashboard access

Binds to `127.0.0.1` with no authentication — same machine, same user, same
trust boundary as the database file.

Binding anywhere else **requires a token**, printed at startup and included in
the URL:

```bash
agentobs dashboard --host 0.0.0.0
```

**Never expose the dashboard to the public internet.** It shows tool inputs and
file paths from your repositories.

---

## Requirements

Node.js **≥ 22.5** — AgentObs uses the built-in `node:sqlite` module, so there
is no native addon to compile and no C++ toolchain to install.

---

## Development

```bash
npm install
npm run build
npm test
```

Adding an adapter for another agent: see [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

MIT © [Klars AI](https://klars.ai)
