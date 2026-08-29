# Roadmap

## Shipped

**Phase A — core.** SQLite storage, secret redaction, pricing, the Claude Code
hook adapter, process-wrap and JSONL adapters, the dashboard, and the CLI.

**Phase B — guardrails.** Policy engine, `policy init/check/test`, enforcement
inside the existing `PreToolUse` hook, and a `policy_decisions` audit trail.

**Deployment.** Terraform for a single EC2 host, Docker Compose, Caddy, and CI.

## Next

### Phase C — more adapters

The `AgentAdapter` interface and `CONTRIBUTING.md` are already in place, so this
is now additive work.

- **GitHub Copilot CLI** — research its current extensibility before writing
  code; do not assume hook parity with Claude Code. Fall back to a specialised
  process-wrap variant that parses stdout for tool-call markers.
- **aider** — check its current chat/history log options and whether they are
  structured enough to parse reliably. Fall back to process-wrap.

Both may end up coarse-grained. That is an acceptable outcome, and the dashboard
already labels fidelity honestly.

### Phase B.1 — interactive approval

`needs_approval` currently behaves as a block. A real approval flow needs a
channel from the hook to a waiting UI (the dashboard holding the call open while
the user decides). Worth doing only once someone actually hits the limitation.

### Phase D — accounts and multi-machine sync

**Superseded in shape, not in intent.** The original spec called for Lambda +
Aurora Serverless v2 + Cognito + API Gateway. The deployment here is EC2 +
Docker Compose + Postgres + Caddy instead — see `infra/aws/README.md` for why.

The local schema is already sync-ready: `device_id`, `account_id`, `synced_at`,
and `updated_at` exist on every table, and client-generated UUID primary keys
make sync a plain upsert-by-id push with no conflict resolution.

Still to build: accounts and `account_members` tables, `agentobs login/logout/
sync/whoami`, the server-side sync endpoint, and a team view. Account isolation
needs a dedicated test suite that *proves* one account cannot read another's
data — the whole security boundary, and not something to assume correct.

**Open question for the founder:** where a paid tier begins (free for
solo/single-device, paid for team sync?). Do not let this get invented in code —
there is a `TODO` at the natural gating point when that code lands.

### Phase E — desktop app

Tauri wrapper around the existing dashboard. Unsigned local builds first.
Signed installers for macOS and Windows require paid developer certificates and
a notarization pipeline — a real operational cost, budgeted separately from the
coding work.

## Deliberate non-goals

- **No telemetry.** Ever. It would undermine the privacy claim that makes this
  tool safe to put in front of an agent.
- **No automatic cost estimation for unknown models.** Blank beats fabricated.
- **No general bidirectional sync engine.** Append-mostly rows with
  client-generated UUIDs do not need one.
