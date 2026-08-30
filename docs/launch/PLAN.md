# Launch plan

Everything here is sequenced. The order matters more than the content: a post
that lands before the package is publishable wastes the only first impression
this project gets.

**Owner note:** all four posts go out under the Klars AI account. Drafts are in
this directory; posting is a human step.

---

## Why now

Claude Code shipped `--max-budget-usd` on 21 Jul 2026. Today it is print-mode
only (`-p`), per-session, and does not persist — so it caps one scripted run,
not anyone's Tuesday. The obvious next release makes it persistent and
interactive, and that is the natural completion of a half-built feature rather
than a guess.

A tool with a few thousand users survives a platform feature landing on top of
it. A tool with 61 does not. That is the whole argument for moving now.

---

## Phase 0 — blockers (must clear before any post)

| # | Task | Owner | Est. |
| --- | --- | --- | --- |
| 0.1 | Publish 0.13.0 to npm | you (2FA) | 2 min |
| 0.2 | Clean-machine install test | me | 1–2 h |
| 0.3 | Reposition README hero from cost to control | me | 20 min |
| 0.4 | Submit sitemap to Google + Bing | you | 5 min |

### 0.1 Publish 0.13.0

`npm publish --access public`, complete the browser auth. Local is 0.13.0, npm
is on 0.12.0, so `agents:verify` is not yet in anyone's hands.

**Do not post anything until `npm view @klars/agentobs version` returns 0.13.0.**
Every post links to the package; linking to a version without the feature the
post describes is the worst possible first impression.

### 0.2 Clean-machine install test

The one genuine pre-launch risk. Hooks never fired on the development machine
(see `agentobs-hooks-never-fired` in memory) and that was never root-caused —
it was worked around with `agentobs import`. If `init` misbehaves on a
stranger's machine, the launch converts curiosity into a bug report.

Test matrix, from a fresh `npm install -g` with no `~/.agentobs`:

- [ ] `agentobs init` on a machine with no prior Claude Code settings
- [ ] `agentobs init` where `~/.claude/settings.json` already has foreign hooks
- [ ] `agentobs init` where that file is malformed JSON
- [ ] `agentobs budget set --daily 5 --block` then confirm a real block fires
- [ ] `agentobs dashboard` binds and renders
- [ ] `agentobs agents:verify` against real Claude Code logs
- [ ] Windows **and** at least one POSIX target

Anything that fails here outranks every post below.

### 0.3 Reposition the README hero

Current: *"Stop your AI agent before it spends too much or breaks something."*

That leads with cost, which is now both ccusage's ground (84,583 weekly
installs) and Anthropic's native feature. Lead instead with the thing neither
can do — see `POSITIONING.md`.

---

## Phase 1 — the durable one, first

### `awesome-claude-code` PR

Best effort-to-durable-traffic ratio on the list, and unlike a forum post it
keeps working after launch week. Cost Guardian used exactly this route.

1. Read the repo's contribution rules — it uses a structured issue form, not a
   free-form PR.
2. Submit via that form with the one-line description in `SUBMISSIONS.md`.
3. Category: cost/observability tooling.

Do this **first**. It has the longest lead time (maintainer review) and the
least dependence on timing.

---

## Phase 2 — the targeted one

### r/ClaudeAI

Where Max-plan users who hit rate limits actually are, which is the audience
the token-budget story was written for. Their cost is $0, so every
dollar-denominated tool — including Anthropic's new flag — is inert for them.
We are the only tool that caps the thing that actually binds them.

- Draft: `POSTS.md` → *r/ClaudeAI*
- Post mid-week, morning US time
- Read the subreddit's self-promotion rules first; some require flair or a
  prior-participation history
- Stay in the thread for the first three hours. Answering "how is this
  different from ccusage" well is worth more than the post

---

## Phase 3 — the high-ceiling one

### Show HN

Highest ceiling, highest variance. HN rewards engineering honesty far more
than a feature list, and this project has an unusually good story there:

- `—` not `$0.00` for an unpriced model; unknown is not zero
- Sources that say `unverified` rather than claiming support that records
  nothing — Copilot CLI stays unverified because a real install was checked
  and it persists no usage data at all
- Profiling that showed our own work at 0.10ms against Node's 1700ms startup,
  so a Rust rewrite would have optimised the wrong 0.8%
- `agents:verify` catching a bug in its own author's code: `.some()` where
  `.every()` belonged would have passed a field map that silently halved every
  reported figure

Lead with that, not with the feature table.

- Draft: `POSTS.md` → *Show HN*
- Tuesday–Thursday, 09:00–11:00 ET
- Be present for the first two hours; on HN the author's replies are the post

---

## Phase 4 — the small precise one

### Anthropic Discord

Small but exactly on-target. Post in the Claude Code channel, conversationally
— a link drop reads as spam. Draft in `POSTS.md`.

---

## What not to do

Deliberate omissions, so they do not get re-litigated mid-launch:

- **No OTLP exporter yet.** Good feature, wrong time: it serves enterprises who
  do not know this exists.
- **No more adapters yet.** 16 versus 3 does not matter at 61 users; it matters
  at 5,000.
- **No team sync.** Months of work, and gateways (LiteLLM, Portkey, Bifrost)
  already own that buyer.
- **No gateway of our own.** They are better at per-team dollar caps and always
  will be — a gateway never sees the tool call, which is precisely why it can
  never block `rm -rf /` or hold a call for approval. That asymmetry is the
  moat; competing on their ground abandons it.

All three become right *after* traction. None of them create it.

---

## After posting

- Watch `npm view @klars/agentobs` weekly downloads daily for the first week
- Every "does it support X" is an adapter request; `agents:verify` now makes
  each one a one-command check rather than a guess
- Expect the first real bug from a machine that has Codex or Gemini installed.
  Their field maps came from those projects' source, not from a real log file
  on real hardware — that is stated plainly in `AUDIT.md`, and the first user
  with those agents is the actual test
