# Changelog

All notable changes to this project are documented here. Versions follow
[semantic versioning](https://semver.org). Dates are UTC.

## [0.17.0] — 2026-08-30

### Added
- **Live windows.** A dropdown for the last 1, 5, 10, 20, 30, 60, 120 or 300
  minutes, for watching a run while it happens. None of the calendar-based
  ranges could answer "what has happened in the last few minutes".

### Fixed
- Range labels were looked up in a plain map, so a minute window rendered as
  "Spend" with no period after it.
- The dashboard stylesheet had no `.sr` rule, so a visually-hidden label
  rendered as visible text.

## [0.16.0] — 2026-08-30

### Added
- **Tool descriptions on hover.** A row reading "Bash 11,266 calls" answers
  nothing for someone who has not used these tools. Descriptions say what the
  tool does and why the agent reaches for it. An unrecognised tool gets no
  tooltip rather than a guessed one; an MCP tool names its server and says
  plainly that we do not know what it does.

## [0.15.0] — 2026-08-30

### Added
- **Optimisation hints**, on the dashboard and at the end of `agentobs stats`.
  Catches a tool failing often, one tool dominating cost, the same call repeated
  with identical input, sessions over 2M input tokens, and a dollar budget that
  cannot bind on a subscription. Every hint names the number that triggered it,
  and nothing is shown when there is nothing worth saying.

### Changed
- The dashboard opens on **today** rather than the last 7 days. A week averages
  a quiet Sunday into a heavy Tuesday and hides what someone opened the
  dashboard to check.

## [0.14.1] — 2026-08-30

### Fixed
- **The Daily tab crashed the server.** Its route ended with `break` where every
  other case uses `return`, so it fell through, wrote a second response and
  killed the process. Added route smoke tests that hit every route and then
  check the server is still answering — a route that crashes fails on the *next*
  request, not its own.

## [0.14.0] — 2026-08-30

### Added
- **Daily tab**: one row per calendar day, with calls, errors, sessions, tokens
  and cost. Built from tool calls rather than sessions, so a run spanning five
  days lands on the days it happened rather than all on the day it began. Quiet
  days are shown rather than skipped.

## [0.13.3] — 2026-08-30

### Added
- **Per-call cost attribution.** Measured across 25 real transcripts, 4,088 of
  4,088 messages issuing a tool call issued exactly one, so that message's cost
  belongs to that call exactly. A message issuing several leaves them uncosted
  rather than dividing the total. Uncosted calls fell from 100% to 4%.

### Fixed
- `completeToolCall` with no token counts stored `$0.00` rather than null,
  because `computeCost` coerces nulls to zero. An unattributable call now reads
  as unknown, not free.

## [0.13.2] — 2026-08-30

### Added
- **Plan detection.** Cost is computed at API list price, which is not a bill on
  a subscription — a Max user saw "$5,525.61 this week" against a $100/month
  plan. The headline now reads "API-equivalent usage" on a subscription and
  stays "Spend" on an API key, with a line naming the plan and pointing at the
  limit that actually binds.
- `writeDefaultPricing` tops up an existing `pricing.json` with models it lacks.
  The file was written once at install and never touched, so anyone who
  installed before a model shipped had blank costs for it forever — with no
  error, because an unpriced model reports blank by design.

## [0.13.1] — 2026-08-30

### Fixed
- Hook installation ignored `CLAUDE_CONFIG_DIR` while the importer honoured it,
  so a relocated Claude Code config got hooks written to a file Claude Code
  never reads — and `init` reported success.
- Skipping `PreToolUse` was reported like any other skip. It is the only hook
  that can refuse a call, so without it budgets and policy are inert; `init` now
  says so.
- `stats` rendered `$3.50` as `$3.5000`.

## [0.13.0] — 2026-08-30

### Added
- **`agentobs agents:verify`** — checks a field map against your real log files
  and reports, field by field, which dot-path resolved and to what value. Read-only:
  nothing is written to the database, so it is safe to run against an adapter you
  do not trust yet. Catches two failures an import cannot: a path that resolves to
  the wrong type, and a map where only one token field resolves.

### Changed
- `CONTRIBUTING.md` restructured around the no-code path. Most agents need only a
  JSON source definition; the TypeScript adapter section is now second, for formats
  a definition cannot express.

## [0.12.0] — 2026-08-30

### Added
- **Outbound alerts** — `agentobs notify set <url>` sends budget breaches and
  approval requests to Slack, Discord, or your own endpoint. Opt-in with no default
  destination. Payloads carry budget names and figures, never tool inputs, and are
  redacted before sending. Plain `http` to a remote host is refused, because a Slack
  webhook carries its secret in the URL path.
- Codex CLI and Gemini CLI promoted to `verified`, with field names taken from those
  projects' own source rather than from documentation.

### Fixed
- **Alerts were never delivered.** `process.exit()` in the hook destroyed the
  in-flight request. The decision is now written to stdout first — the agent is
  unblocked immediately — and only then is the send given a bounded 1.5s to finish.
- A `$0.0001` limit rendered as `$0.00` in webhook payloads. `budgetAmount` moved to
  `core/budget.ts` so the block message, the desktop toast and the webhook describe a
  breach identically.

### Changed
- Corrected the claim that "every other agent tool is read-only". Two tools now block
  on cumulative dollars. The accurate claim is narrower: the only tool enforcing
  tokens, rolling windows, commands and approvals.
- Copilot CLI documented as `unverified` for a specific reason: a real install holds
  only `config.json` and plain-text server logs, and persists no usage data at all.

## [0.11.0] — 2026-08-30

### Added
- **Multi-agent support** via declarative source definitions. Adding an agent is a
  table entry, and users can add one AgentObs has never heard of by dropping JSON
  into `~/.agentobs/sources.json`.
- `/api/agents` endpoint.

### Fixed
- Small budget values displayed as `$0.00`.

## [0.10.0] — 2026-08-29

### Added
- **Interactive approvals.** `needs_approval` now means what it says: the call is
  held and you are notified. Approvals are fingerprinted over the tool name and its
  exact input, so approving `rm -rf ./build` never authorises `rm -rf /`. They expire
  after 60 minutes.
- `agentobs prune` for reclaiming disk space.

## [0.9.0] — 2026-08-29

### Added
- **Warm daemon.** Hot paths go from ~1700ms to 0.6ms. Measured first: AgentObs's own
  work was 0.10ms and Node's startup was 1700ms, so the daemon fixed the actual
  problem rather than the assumed one.

## [0.8.0] — 2026-08-29

### Changed
- `agentobs init` now sets everything up. No manual JSON editing.

## [0.7.0] — 2026-08-29

### Added
- Dashboard redesign: tabs, budget meters, ranked breakdowns.

## [0.6.0] — 2026-08-29

### Added
- `agentobs statusline` for Claude Code's status bar, using Anthropic's own
  rate-limit numbers when the client sends them.
- **MCP server** — the agent can query its own usage mid-task.
- Desktop notifications on a budget breach.

## [0.5.0] — 2026-08-29

### Added
- **Burn-rate forecasting.** Measured over the last hour of *actual activity*, not
  wall-clock: averaging a 40-minute burst across four idle hours understated the rate
  roughly sevenfold. Refuses to project from too small a sample rather than guessing.

## [0.4.0] — 2026-08-29

### Added
- Budgets denominated in **tokens**, and on Claude's rolling **5-hour window**. This
  is the case dollar-denominated tools cannot serve: on a subscription your cost is
  $0 and the real constraint is the rate-limit window.

## [0.2.0] — 2026-08-29

### Added
- **`agentobs import`** — rich data from Claude Code transcripts with no hooks
  required. Built because hooks were observed never firing on one Windows
  configuration; this path does not depend on them.

## [0.1.0] — 2026-08-28

Initial release: SQLite storage, secret redaction, pricing, the Claude Code hook
adapter, process-wrap and JSONL adapters, the dashboard, the policy engine, and the
CLI.
