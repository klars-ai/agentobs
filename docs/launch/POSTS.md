# Launch drafts

Four posts, in the order they should go out. Every number in them was checked
on 30 Aug 2026 — re-check before posting if more than a few days have passed,
because a wrong figure in the first paragraph costs more than a late post.

**These are drafts for a human to post.** They go out under the Klars AI
account, in your own words if you prefer — an obviously agent-written launch
post reads badly on every one of these channels.

---

## Important: the awesome-claude-code order has changed

That list requires a resource to be **either 14 days old with ongoing commits,
or have 100 stars**. AgentObs is two days old with zero stars, so a submission
now would be declined — and their contributing guide warns that submitting
outside the rules risks a temporary interaction ban.

It also says submissions must be human-created, not agent-created.

So: **submit around 12 September at the earliest**, after the other posts have
had a chance to put some stars on the repo. Everything below is reordered
accordingly.

---

## 1. r/ClaudeAI — post first

Best fit for the honest pitch, and the audience most likely to hit the exact
problem. Read the subreddit rules on self-promotion before posting; some
require flair or prior participation.

**Title**

> I built a tool that blocks Claude Code before it hits your limit, not after

**Body**

> Every usage tool I found tells you what you already spent. I wanted one that
> could actually stop, so I built AgentObs.
>
> It runs as a PreToolUse hook, so it sees a tool call *before* it executes and
> can refuse it:
>
> ```
> agentobs budget set --block5h 200000 --tokens
> ```
>
> That one matters if you're on Max or Pro. Your dollar cost is zero, so every
> dollar-denominated tool — including Claude Code's own `--max-budget-usd` —
> can't bind on you. The thing that actually limits you is the rolling 5-hour
> window, and that's what this caps.
>
> It also does the reporting side (per-day, per-tool, per-project, a local
> dashboard), plus command policy — `rm -rf /` and reads of `.env` get denied
> before they run — and approvals scoped to the exact input, so approving
> `rm -rf ./build` never authorises `rm -rf /`.
>
> One thing I ran into building it that might save you some confusion: it'll
> show you a big number. Mine says ~$5,500 for a week against a $100/month
> plan. That's what the usage *would* cost on the API, and 99% of it is cache
> reads — every turn re-sends the whole conversation. AgentObs detects your
> plan and labels it "API-equivalent usage" rather than pretending you spent
> it. Seeing that number was genuinely useful; being told I'd spent it would
> have been a lie.
>
> MIT, local-only, no account. `npm install -g @klars/agentobs` then
> `agentobs init`.
>
> https://github.com/klars-ai/agentobs
>
> Honest caveats: it's new, so expect rough edges. Claude Code is the only one
> I've verified against real transcripts on my own machine — Codex and Gemini
> CLI field maps came from those projects' source code but have never been run
> against a real log, and Copilot CLI stays marked unverified because I checked
> and it doesn't persist usage data at all. `agentobs agents:verify` tells you
> in one command whether a format actually resolves on your machine. Happy to
> fix whatever you find.

**After posting:** stay in the thread for the first few hours. "How is this
different from ccusage" is the question to answer well — ccusage is excellent
at reporting and reads 16+ agents to our 5. The difference is that it can't
stop anything, because reporting usage doesn't require knowing your limit.

---

## 2. Show HN — post second, 24–48h later

Tuesday to Thursday, 09:00–11:00 ET. HN rewards the engineering story far more
than a feature list, and this project has a good one.

**Title**

> Show HN: AgentObs – block your AI agent before it overspends, not after

**Body**

> I kept seeing the same shape in Claude Code tooling: everything reports, and
> nothing stops. Reporting doesn't need to know your limit; stopping does. So
> AgentObs asks for the limit, which turns out to unlock two things — refusing
> a tool call before it runs, and forecasting when you'll hit the ceiling.
>
> It's a PreToolUse hook plus a local SQLite database. One runtime dependency
> (commander), installs in under a second, ~8,900 lines.
>
> Three decisions I'd defend:
>
> **Unknown is never zero.** A model missing from the pricing table renders as
> `—`, not `$0.00`. One fabricated number and you stop trusting all of them.
> Same rule for a tool call we can't attribute cost to, and for an agent log
> format we haven't verified — those are labelled `unverified` rather than
> silently recording nothing.
>
> **I profiled before optimising.** A statusline render was ~1700ms, which
> looked like a reason to rewrite the hot path in something faster. It was
> Node's startup being scanned by antivirus; my own code was 0.10ms of it. A
> rewrite would have optimised the wrong 0.8%. A warm daemon holding the DB
> open fixed the actual problem — 1700ms to 0.6ms.
>
> **The tool caught my own bug.** I added `agents:verify`, which checks a log
> field map against real files. The first version used `.some()` where
> `.every()` belonged, so a map that read input tokens but not output tokens
> reported as working — it would have silently halved every figure. Its own
> test caught it.
>
> Two bugs worth mentioning because they're the interesting kind. Cache reads
> were being summed into the token total, producing 2.4 *billion* tokens across
> three sessions — they replay the whole context every turn and bill at 0.1x,
> so they're now counted separately. And a switch case ending in `break` where
> every sibling used `return` fell through, wrote a second HTTP response and
> killed the server; every unit test passed, and the only symptom was a blank
> tab. There are route smoke tests now that hit every endpoint and then check
> the server is still answering.
>
> MIT, local-only, no telemetry, no account.
> https://github.com/klars-ai/agentobs
>
> Known limits, stated up front: it can't block what it never sees, so it needs
> the hook installed — and hooks silently didn't fire on one Windows machine I
> tested, which is why `agentobs import` exists as a hook-free path. Guardrails
> fail open by design. Costs are estimates, not an invoice.

**After posting:** be present for the first two hours. On HN the author's
replies *are* the post. Expect scrutiny of the cost methodology and of the
"can't block what it never sees" caveat — both are answerable, and answering
them plainly is worth more than the submission itself.

---

## 3. Anthropic Discord — post third

Small, precise audience. Conversational, in the Claude Code channel. A link
drop reads as spam.

> Been building a hook-based tool for capping Claude Code usage and wanted to
> share in case it's useful to anyone here.
>
> The bit I couldn't find elsewhere: token budgets on the rolling 5-hour
> window. On Max the dollar figure is meaningless, so `--daily 5` doesn't bind
> on anything — `agentobs budget set --block5h 200000 --tokens` does.
>
> It's a PreToolUse hook, so it refuses the call rather than reporting it
> afterwards. Also does command policy and scoped approvals. MIT, all local.
>
> https://github.com/klars-ai/agentobs — feedback welcome, especially on the
> hook side, which is the part I'm least sure generalises across machines.

---

## 4. awesome-claude-code — submit ~12 September

Only once the repo is 14 days old with ongoing commits, or has 100 stars.
Submit through their **web issue form**, never a PR:

https://github.com/hesreallyhim/awesome-claude-code/issues/new?template=recommend-resource.yml

Their rules: one resource per submission, single-line description, descriptive
rather than addressed to the reader, no emoji, no sales pitch. License is
auto-discovered.

**Suggested description line**

> A hook-based observability and control layer for Claude Code that enforces
> token and dollar budgets, command policy and scoped approvals before a tool
> call executes.

---

## What to expect

Realistically: r/ClaudeAI is the one most likely to convert, because the
token-budget story is written for exactly that audience. Show HN is high
variance — it may do nothing, and that's normal.

The number to watch is `npm view @klars/agentobs` weekly downloads. It has been
flat at 61 for three days of shipping, because none of that work was the kind
that moves it.

Every "does it support X" reply is an adapter request, and `agents:verify` now
makes each one a one-command check rather than a guess — worth saying so in
the thread.
