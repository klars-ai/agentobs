# Security policy

## Reporting a vulnerability

Email **contact@klars.ai**. Please do not open a public issue for a
vulnerability.

Include what you can: the version (`agentobs --version`), your OS, what you did,
and what happened. A proof of concept helps but is not required to report.

You will get an acknowledgement within 3 working days and an assessment within
7. If a fix is warranted it ships as a patch release, and you are credited in
the changelog unless you would rather not be.

## What counts as a vulnerability here

AgentObs sits in the execution path of an AI agent and holds a local record of
what that agent did. The failures that matter most are therefore:

- **A secret reaching disk unredacted.** Every value passing through a tool call
  is run through `src/core/redact.ts` before storage. A pattern that gets past
  it is a real finding, and the most valuable kind of report we can receive.
- **A secret leaving the machine.** Outbound webhooks are the only network path,
  they are opt-in, and payloads are redacted. Anything that sends more than the
  configured destination should receive, or sends to somewhere the user did not
  name, is a vulnerability.
- **A guardrail that can be bypassed.** A policy rule that should deny a call
  but does not — for example a glob that fails to match a destructive command it
  was written to catch.
- **An approval escaping its scope.** Approvals are fingerprinted over the tool
  name *and* the exact input, so approving `rm -rf ./build` must never authorise
  `rm -rf /`. A way to widen an approval beyond its fingerprint is a finding.
- **Privilege or path escape**, including a source definition or policy file
  that can be made to read or write outside the paths it should.

## What does not count

- **A guardrail failing open.** This is deliberate. A malformed policy degrades
  to allow-everything and says so, because a monitoring tool that wedges someone's
  agent is worse than one that stops guarding. It is documented, not a bug.
- **Cost figures being estimates.** Prices come from a local table; an unpriced
  model renders as `—` rather than a guess. Inaccuracy against your invoice is a
  known limitation, not a vulnerability.
- **Anything requiring write access to `~/.agentobs` or your Claude Code
  settings.** An attacker who can already write there has your shell.
- **Bypassing budgets by not installing the hook.** AgentObs is a tool you run
  on yourself, not a control imposed on an untrusted user. It does not claim to
  survive an adversary who controls the machine.

## Supported versions

The latest published minor version receives fixes. Given the release cadence,
please reproduce on the current version before reporting.

## Scope note

This is a local-first tool with no server, no account and no telemetry. There is
no hosted service to test against, and no authorisation is granted to test
`agents.klars.ai` beyond ordinary use of the public page.
