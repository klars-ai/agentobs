## What this changes

<!-- One or two sentences. What is different after this merges? -->

## Why

<!-- The problem being solved. If it fixes an issue, link it. -->

## How it was verified

<!-- Not "npm test passes" - what did you actually check? -->

- [ ] `npm test` passes
- [ ] Tried it on a real machine, not only in tests
- [ ] If it touches redaction: a test proves the secret does not reach disk
- [ ] If it touches a guardrail: a test proves it denies what it should
- [ ] If it adds an agent source: `agentobs agents:verify` output is included below

## Notes for the reviewer

<!-- Anything you are unsure about, or a decision worth a second opinion. -->
