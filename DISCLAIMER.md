# Disclaimer

AgentObs is provided under the [MIT License](LICENSE), which disclaims all
warranties and all liability. That is the operative legal text. This file
explains, in plain terms, the specific limits worth understanding before you
put this tool in the path of an agent that can spend money and change files.

## It is a safety net, not a guarantee

AgentObs reduces the chance of an expensive or destructive run. It does not
eliminate it. Do not rely on it as the only thing standing between an agent and
something you cannot afford to lose.

**Guardrails fail open, on purpose.** A malformed policy file degrades to
allow-everything and says so. A monitoring tool that wedges your agent when its
own config is broken is worse than one that stops guarding — so in that state,
nothing is blocked.

**Budgets are enforced between tool calls.** A single call that is already
running is not interrupted, and a call in flight when the limit is reached will
finish. You can exceed a limit by the cost of one operation.

**Policy matching is textual.** Rules match tool inputs with glob patterns. A
destructive command phrased in a way your rules do not anticipate will not be
caught. The starter policy is a beginning, not a complete threat model.

**AgentObs cannot stop what it never sees.** It works through Claude Code's hook
system. An agent run without the hooks installed, a tool invoked outside them,
or a hook that does not fire on your machine — all produce no enforcement at
all. Hooks have been observed silently not firing on at least one Windows
configuration; that is why `agentobs import` exists as a hook-free path, and why
you should verify enforcement works on your own machine rather than assuming it.

## Cost figures are estimates

Costs are computed locally from token counts and a bundled price table. They are
**not** an invoice and will not match your bill exactly.

- A model missing from the table shows `—`, never `$0.00`. Unknown is not zero.
- Prices change; the bundled table can be out of date.
- Subscription plans (Pro, Max) have no per-token dollar cost, so dollar figures
  are meaningless there. Use token budgets instead.
- Cached reads are billed differently from fresh input and are counted
  separately, but the underlying rates are Anthropic's to change.

For authoritative billing, use the Claude Console.

## Data accuracy

**A source marked `unverified` may record nothing at all.** Only Claude Code,
Codex CLI and Gemini CLI have field maps taken from those projects' own source.
Run `agentobs agents:verify` to see what actually resolves against your logs
rather than trusting the label.

**Absence of data is not evidence of absence of activity.** A wrong field map,
a missing hook, or an agent AgentObs does not know about all produce the same
empty report as a quiet week.

## Privacy

Everything is stored locally in `~/.agentobs`. There is no account, no API key,
no telemetry and no network call — with one exception you switch on yourself:

**Outbound webhooks are opt-in.** Nothing is sent until you write a destination
into `~/.agentobs/notify.json`. When you do, you are responsible for where that
data goes. Payloads carry budget names and figures, are redacted before sending,
and plain `http` to a remote host is refused — but a destination you control is
still a destination outside this machine.

**Redaction is thorough, not perfect.** Vendor patterns and structural rules are
unit-tested and have caught real leaks. They cannot anticipate every secret
format. Treat `~/.agentobs/agentobs.db` as sensitive: it is a record of what
your agent did, and it lives on your disk.

**The dashboard binds to `127.0.0.1` by default.** If you change that, you are
exposing your agent history to your network. It has no authentication.

## No affiliation

AgentObs is an independent project by Klars AI. It is not affiliated with,
endorsed by, or supported by Anthropic, OpenAI, Google, GitHub, or any other
vendor whose tools it reads. "Claude", "Claude Code", "Codex", "Copilot" and
"Gemini" are trademarks of their respective owners and are used here only to
describe compatibility.

Reading another tool's local log files is subject to that tool's own terms.

## Your responsibility

You are responsible for verifying that AgentObs behaves as you expect **on your
machine, with your configuration**, before depending on it. Set a small limit
and confirm it blocks. Write a policy rule and run `agentobs policy test`
against it. Run `agentobs agents:verify` and see that real numbers appear.

Those three checks take about two minutes and are worth more than any assurance
this file could offer.
