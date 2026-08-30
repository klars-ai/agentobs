<div align="center">

<img src="https://raw.githubusercontent.com/klars-ai/agentobs/main/docs/assets/logo.svg" width="72" height="72" alt="" />

# AgentObs

**Your agent is about to run `rm -rf /`.**
**Every other tool will tell you about it afterwards.**

[![npm](https://img.shields.io/npm/v/@klars/agentobs?color=2a78d6&label=npm)](https://www.npmjs.com/package/@klars/agentobs)
[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.5-1baf7a)](https://nodejs.org)

[Website](https://agents.klars.ai) · [npm](https://www.npmjs.com/package/@klars/agentobs) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Limits](DISCLAIMER.md)

</div>

<br>

<picture>
  <source srcset="https://raw.githubusercontent.com/klars-ai/agentobs/main/docs/assets/dashboard-dark.png" media="(prefers-color-scheme: dark)" />
  <img src="https://raw.githubusercontent.com/klars-ai/agentobs/main/docs/assets/dashboard.png" alt="The AgentObs dashboard: spend for the week, tool call and error-rate tiles with trend sparklines, an activity chart, and tables of tools and sessions." />
</picture>

<br>

## Enforces more than a dollar figure

Most Claude Code tools are read-only — they tell you what happened *after* it
happened. A couple can block on cumulative dollars. AgentObs is a control
plane: it enforces token budgets, rolling rate-limit windows, command policy
and scoped approvals, all before a call runs.

```
$ agentobs budget set --daily 5 --block
$ agentobs policy test Bash "rm -rf ./build"

  Decision   BLOCK
  Rule       no-recursive-force-delete
```

<img src="https://raw.githubusercontent.com/klars-ai/agentobs/main/docs/assets/demo.gif" alt="Terminal demo: agentobs policy test blocks an rm -rf command, then agentobs stats shows the cost, calls, errors and blocked totals." width="820" />

| | Cost tools | Security hooks | **AgentObs** |
| --- | --- | --- | --- |
| Cost & token reporting | ✅ | ❌ | ✅ |
| Web dashboard | ❌ | some | ✅ |
| Blocks dangerous commands | ❌ | ✅ | ✅ |
| **Blocks on a spend limit** | ❌ | ❌ | ✅ |
| **Blocks on your 5-hour window** | ❌ | ❌ | ✅ |
| **Forecasts when you'll run out** | ❌ | ❌ | ✅ |
| Status-bar integration | some | ❌ | ✅ |
| **MCP server** | ❌ | ❌ | ✅ |
| **Desktop alerts on a limit** | ❌ | ❌ | ✅ |
| Secret redaction, unit-tested | ❌ | ❌ | ✅ |

**Just want cost reporting?** [ccusage](https://github.com/ryoppippi/ccusage) is
excellent at it and supports 16+ agents. AgentObs is for when you want to
*stop* things, not only measure them.

AgentObs runs entirely on your machine: a CLI, a local SQLite database, and a
dashboard. No account, no cloud, no telemetry.

## Quick start

```bash
npm install -g @klars/agentobs
agentobs init
```

That is the whole setup. `init` creates the database, **writes the Claude Code
hooks for you** (backing up your settings first), adds starter guardrails, and
imports your existing history so the dashboard has data immediately.

```bash
agentobs dashboard
```

Restart Claude Code once for live capture to begin.

<details>
<summary>What init touches, and how to opt out</summary>

- `~/.agentobs/` — database, `pricing.json`, `policy.json`
- `~/.claude/settings.json` — four hook entries, **backed up first**. Anything
  else in that file is left exactly as it was, and a hook another tool already
  owns is never replaced (use `--force` to add alongside it).

```bash
agentobs init --no-hooks       # leave settings.json alone
agentobs init --print-hooks    # print the config instead of installing it
agentobs init --no-import      # skip importing history
agentobs init --project .      # install into this repo's .claude/ instead
agentobs uninstall-hooks       # remove only AgentObs's hooks
```

</details>

> **If hooks record nothing:** this has been observed on at least one Windows
> install, where Claude Code did not invoke the configured command at all — a
> plain two-line `.cmd` file also never fired, so it is not specific to
> AgentObs. `agentobs import` needs no hooks and keeps working; only guardrail
> *blocking* depends on them.

---

## What you get

|                        |                                                              |
| ---------------------- | ------------------------------------------------------------ |
| **Budget limits**      | Warn or **hard-block** at a dollar or token limit — daily, weekly, monthly, or Claude's 5-hour window. |
| **Cost tracking**      | Per session, per tool, per project — or blank if the model's price is unknown. Never guessed. |
| **Tool-call timeline** | Every call, its duration, status, and truncated input.        |
| **Guardrails**         | Block `rm -rf`, require approval for `.env` edits, stop `curl \| sh`. |
| **Audit trail**        | Every policy decision recorded with the rule that fired.      |
| **Any agent**          | Native Claude Code hooks; JSONL ingestion or process-wrapping for everything else. |

---

## Privacy

This is the part that matters most, since AgentObs sits in the middle of
everything your agent does.

- **Nothing leaves your machine unless you send it.** No telemetry, no analytics,
  no account. Optional alerts are the one outbound path, off until you configure a
  destination yourself.
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
agentobs init                        Set up everything: db, hooks, policy, history
agentobs uninstall-hooks             Remove AgentObs's hooks from your settings
agentobs import [--days n] [--all]   Import Claude Code transcripts (no hooks needed)
agentobs dashboard [--port] [--host] Serve the dashboard (default 127.0.0.1:4300)
agentobs stats [--today] [--since]   Print totals in the terminal
agentobs run -- <command...>         Observe any command (coarse detail)
agentobs watch <file.jsonl>          Ingest a JSONL agent log
agentobs agents                      Which agents are on this machine
agentobs agents --import             Import from every agent found
agentobs agents:verify [--agent id]  Check a field map against real logs (read-only)
agentobs export --format csv|json    Export sessions, tool calls, or decisions

agentobs policy init                 Write a starter policy.json
agentobs policy check                Validate it and list active rules
agentobs policy test <tool> <input>  Dry-run a call against the policy

agentobs approvals                   Tool calls held for your approval
agentobs approve <id> | --all        Allow one, or everything pending
agentobs deny <id>                   Refuse one
agentobs prune --older-than 90       Delete old data, reclaim disk space

agentobs budget                      Spend and token use against your limits
agentobs budget set --daily 5        Warn past $5 today
agentobs budget set --monthly 100 --block        Stop at $100 this month
agentobs budget set --block5h 200000 --tokens    Watch your 5-hour window

agentobs notify set <url>            Send alerts to Slack, Discord, or your own endpoint
agentobs notify test                 Send a real test alert and report what came back
agentobs notify list | remove <url>  Show or remove destinations

agentobs forecast [--watch]          When will you hit your limit?
agentobs statusline                  Compact line for Claude Code's status bar
agentobs mcp                         MCP server: let the agent query its own usage
agentobs daemon                      Warm process so hot paths skip Node startup
agentobs digest                      A readable period summary
agentobs projects                    Spend grouped by working directory
```

---

## Budgets

The feature nothing else has: a limit that actually stops the agent.

```bash
agentobs budget set --daily 5                    # warn
agentobs budget set --monthly 100 --block        # stop at $100
agentobs budget set --block5h 200000 --tokens    # 5-hour window
```

```
  Budget       Spent       Limit   Used  Action
  ------------------------------------------------------------
  block5h      120K tok    200K tok   60%  warn
  [############........]
  daily           $0.66       $5.00   13%  warn
  [###.................]
```

With `--block`, a crossed limit denies further tool calls through the same
PreToolUse hook the guardrails use — the agent is told why, and the decision is
recorded in the audit trail.

**On a subscription plan, dollars are the wrong unit.** What bites is the
rolling 5-hour session window and the weekly cap. `--tokens` denominates a
budget in tokens, and `--block5h` tracks that window, so you can see a lockout
coming instead of hitting it mid-task.

Alerts fire once per period, not once per tool call.

### Status bar

```json
{ "statusLine": { "type": "command", "command": "agentobs statusline" } }
```

```
5h 78%!  ·  $2.00/$5.00 40% -> 44 min  ·  session $1.23  ·  ctx 43%
```

Your real 5-hour rate limit (read from Claude Code's own payload), the budget
closest to its limit with a countdown, session cost, and context use.

### Ask the agent

```bash
claude mcp add agentobs -- agentobs mcp
```

Then ask Claude directly: *"how much have I spent today?"*, *"am I close to my
limit?"*, *"which project is costing the most?"* — answered from local data,
not guessed. Exposes `get_usage`, `get_budget_status`, `get_projects` and
`get_top_tools`, all read-only.

### Forecasting

```bash
$ agentobs forecast

  DAILY  $2.00 of $5.00  (40%)
  [##########..............]
  At $4.14/hour you hit the limit in 44 min (~10:27 am),
  14h 16m before the period resets.
```

A forecast needs the limit *and* the usage, which is why a tool that only
reports usage cannot tell you this. `--watch` refreshes it live.

The rate is measured over the last hour of **actual activity**, not the whole
period: averaging a 40-minute burst across four idle hours dilutes it roughly
sevenfold and under-warns exactly the person who is working right now. With
too few samples it says so rather than projecting from noise.

---


## Alerts

A budget that blocks at 2am is silent until someone looks at a terminal.
`agentobs notify` sends the breach somewhere you will actually see it.

```bash
agentobs notify set https://hooks.slack.com/services/T00/B00/xxxx
agentobs notify test          # confirm it arrives before you rely on it
```

Slack and Discord webhooks both work with no extra configuration. For your own
receiver, `--format json` posts a structured event instead:

```json
{
  "source": "agentobs",
  "kind": "budget_exceeded",
  "title": "AgentObs: daily budget blocked — $5.02 of $5.00",
  "detail": "Further tool calls are refused until the daily period resets.",
  "data": { "period": "daily", "spent": 5.02, "limit": 5, "unit": "usd", "action": "block" },
  "sent_at": "2026-08-30T02:00:00.000Z"
}
```

**This does not weaken the privacy promise.** There is no default endpoint and
no vendor: nothing is sent until you write a destination into
`~/.agentobs/notify.json` yourself, and it goes only where you named. *No
telemetry* means AgentObs does not phone home — not that you cannot be told
when your own agent is blocked.

Three things are enforced regardless:

- **Payloads carry budget names and numbers, never tool inputs**, file
  contents, prompts or paths — and the text is run through the same redaction
  rules as everything else before it leaves.
- **Plain `http` to a remote host is refused.** A Slack webhook carries its
  secret in the URL path, so sending one unencrypted would leak it. `https`
  anywhere, or `http` on localhost, are both fine.
- **Alerts fire once per period, not once per tool call**, and a dead or slow
  endpoint is abandoned after a short timeout rather than delaying your agent.

Alerts are sent for budget breaches and approval requests. Narrow that with
`--events budget_exceeded` if you only want the money.

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

- **`needs_approval` holds the call and asks you.** A hook cannot prompt -
  stdin and stdout belong to Claude Code - so the call is refused, recorded,
  and you decide out-of-band:

  ```bash
  agentobs approvals          # what is waiting
  agentobs approve a1b2c3d4   # then ask the agent to retry
  ```

  The approval is remembered for 60 minutes and is scoped to that exact call:
  approving `rm -rf ./build` never authorises `rm -rf /`. The first attempt is
  always refused - it is approve-then-retry, not a live prompt.
- **A broken policy file fails open.** Invalid JSON or a malformed rule
  degrades to allow-everything and reports the problem, because a guardrail
  that wedges your agent is worse than no guardrail. Run `agentobs policy check`.

---

## Agent support

| Agent | How | Detail | Needs setup? |
| --- | --- | --- | --- |
| **Claude Code** | `agentobs import` | **Rich** — every tool call, tokens, cost | **No** |
| **Claude Code** | Native hooks | **Rich**, live, and can *block* calls | Yes — `init` writes them |
| **Codex CLI**, **Gemini CLI** | `agentobs agents --import` | Log-based, **format verified** | No |
| Copilot CLI, OpenCode | `agentobs agents --import` | Log-based, **format unverified** | No |
| Any CLI agent | `agentobs run -- <cmd>` | **Coarse** — duration and exit code only | No |
| Custom / in-house | `agentobs watch <file>` | **Rich**, if it writes JSONL | No |

```bash
agentobs agents            # what is on this machine
agentobs agents --import   # read from everything found
agentobs agents:verify     # does each field map actually work here?
```

`agents:verify` is the honest answer to "does this adapter work?". It samples
your real logs and reports, field by field, which dot-path resolved and to what
value — read-only, so nothing is written to the database. A wrong field map
records zero rather than erroring, which looks exactly like a quiet week; this
is how you tell those apart. See
[CONTRIBUTING.md](CONTRIBUTING.md) to add an agent with no code.

**On "verified" and "unverified":** a source is only marked verified once its
field names come from the agent's own source or a real log file:

- **Claude Code** — read directly from real transcripts.
- **Codex CLI** — field names from the `TokenUsage` struct in
  [`openai/codex`](https://github.com/openai/codex)
  `codex-rs/protocol/src/protocol.rs`. Two envelope shapes exist across
  versions and both are read.
- **Gemini CLI** — field names from `MessageRecord` in
  [`google-gemini/gemini-cli`](https://github.com/google-gemini/gemini-cli)
  `packages/core/src/services/chatRecordingService.ts`.
- **Copilot CLI** — still `unverified`, and honestly so: a real install was
  checked and `~/.copilot` holds only `config.json` and plain-text server
  logs. Copilot CLI reports usage through its own `/usage` command rather
  than persisting it, so unless you have configured its OpenTelemetry file
  exporter there is nothing on disk to import.
- **OpenCode** — path confirmed, field names not.

A tool that claims support and then silently records nothing is worse than one
that says what it cannot read — so if a source yields no usage,
`agents --import` says exactly that instead of reporting a confident zero.

**Adding your own agent** takes no code. Drop a definition into
`~/.agentobs/sources.json` naming where the logs live and which field names
that agent uses:

```json
{
  "sources": [{
    "id": "my-agent",
    "label": "My Agent",
    "roots": [".myagent/sessions"],
    "fileSuffix": ".jsonl",
    "status": "verified",
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

A definition with a built-in's id replaces it — which is how you fix a field
map we got wrong without waiting for a release.

### A note on cost accuracy

Claude Code's `PostToolUse` hook payload carries **no token or cost fields**,
so token usage comes from the session transcript — at `SessionEnd` for hooks,
or directly via `agentobs import`. That makes **session-level cost accurate**
while leaving **per-tool-call cost blank**: usage is reported per assistant
message, not per tool call, and dividing a total across calls would be a
manufactured number.

**Cache tokens dominate a long session.** A cached conversation replays its
whole context on every turn, so `cache_read` can reach hundreds of millions of
tokens in a single session. AgentObs tracks cache reads (billed at 0.1x input)
and cache writes (1.25x) separately from fresh tokens, and `agentobs import`
prints the four lines separately — a single unexplained total looks like a bug
when the cache line legitimately dwarfs everything else.

Model prices live in `~/.agentobs/pricing.json` and are yours to edit. A model
missing from that file shows cost as `—`, never `$0.00`.


### Speed

AgentObs's own work is **0.10ms** for a statusline render and **0.3ms** for a
hook. What costs time is Node starting up: ~40ms on Linux/macOS, and over a
second on Windows where antivirus scans the binary on every spawn.

`agentobs daemon` removes that entirely — one warm process holds the database
open and hot paths become a socket round trip:

```bash
agentobs daemon --idle 60    # exits after an hour idle
```

| | Cold start | Via daemon |
| --- | --- | --- |
| Statusline render | ~1700ms* | **0.60ms** |

\* measured on Windows with antivirus active; ~40ms on Linux/macOS.

Everything works without it — the daemon is a pure optimisation, and any hot
path falls back to doing the work in-process when it is not running.

### Hook latency

The hook does its own work in **well under 1ms** (measured: ~0.3ms per
invocation, including the SQLite write). What you actually pay per tool call is
**Node.js process startup**, since Claude Code spawns the hook as a fresh
process each time.

On a typical Linux/macOS machine that is ~40-80ms. On Windows with real-time
antivirus scanning it can reach **1-1.5 seconds** - and that cost is not
specific to AgentObs: a bare `node -e "0"` measures the same. Check yours with:

```bash
node -e "0"          # time this; it is the floor for any Node-based hook
```

If it is slow, adding an exclusion for your Node install directory and
`~/.agentobs` in your antivirus settings is the fix. There is no code change
that avoids it - the cost is paid before AgentObs runs at all.

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


## What this does and does not guarantee

AgentObs is a safety net, not a guarantee, and the honest limits are worth
knowing before you rely on it:

- **Guardrails fail open.** A malformed policy degrades to allow-everything and
  says so. A tool that wedges your agent when its own config breaks is worse
  than one that stops guarding — but in that state nothing is blocked.
- **Budgets are enforced between tool calls.** A call already running is not
  interrupted, so you can exceed a limit by the cost of one operation.
- **It cannot stop what it never sees.** Enforcement runs through Claude Code's
  hooks. An agent run without them gets no enforcement at all.
- **Costs are estimates**, computed locally from a bundled price table. Not an
  invoice. An unpriced model shows `—`, never `$0.00`.
- **An `unverified` source may record nothing.** Run `agentobs agents:verify`
  to see what actually resolves against your logs.

Two minutes of verification is worth more than any assurance: set a small limit
and confirm it blocks, then run `agentobs agents:verify`.

Full detail in [DISCLAIMER.md](DISCLAIMER.md). Licensed
[MIT](LICENSE) — provided as is, without warranty of any kind.

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

## Security

Found a way past redaction, a guardrail, or an approval scope? Email
**contact@klars.ai** rather than opening a public issue — see
[SECURITY.md](SECURITY.md).

## License

MIT © [Klars AI](https://klars.ai)
