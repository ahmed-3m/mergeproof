---
schema: b2i-brief@1
template: worker
distilled: One-command install that wires mergeproof into GitHub Actions so trusted issues go to a skill-guided coding agent whose PRs are retried and merged only with proof
---
# Mergeproof Autopilot

## Goal
- Install on any repo with one command and a pasted API key, then run entirely in GitHub's cloud
- Take a trusted issue to a merged PR, or a documented human handoff, with no manual steps
- Raise first-try pass rates with per-kind skills that self-check before the gate

## Core flows
1. Install: `mergeproof init` detects paths and the test command, writes `.mergeproof.json`, three workflows (issue, PR, nightly sync) using `ahmed-3m/mergeproof@v1`, the bugfix and feature skills, labels, and the ledger branch, stores the model key and bot token as secrets, and verifies that a bot push triggers CI
2. Issue to PR: an issue opened by an allowlisted author or labeled `agent` by a maintainer starts the configured agent with the skill for its kind, which implements, runs the tests and `mergeproof check --local`, gets a fresh-context critic pass, and fixes for up to 3 rounds before opening a PR with a self-review report
3. PR to outcome: after CI on an agent PR, MERGE merges an unlocked kind (or comments "would merge" in shadow mode), RETRY dispatches the agent to fix the same PR up to 2 times, and HUMAN, tampering, or exhausted retries label it `needs-human` with the full history

## Out of scope
- The gate's checks themselves (milestone 1)
- Building a coding agent (reuses the Claude Code action or OpenHands, with GLM and others through compatible endpoints)
- Refactor and docs skills (next release) and any deps skill (deps always go to a human)
- GitHub App, OAuth, a Supabase dashboard, billing, and org-wide policies (v2)
- Fork PRs and `pull_request_target` (same-repo branches only)
- Opening issues from gate failures (only sync's regression issues, and those go to humans)

## Risks & assumptions
- RISK: anyone who can open an issue can instruct the agent (prompt injection), so only allowlisted authors or maintainer labels start it, and bot-written issues never do
- RISK: events from the default GITHUB_TOKEN do not trigger workflows, so agent pushes use the stored bot token, the gate re-dispatches the agent through `workflow_dispatch`, and init verifies both
- RISK: a same-model critic tends to agree with itself, so it runs in a fresh context with an optional different model, and the gate stays the only decider
- RISK: runaway cost, capped at 3 self-review rounds, 2 gate retries, a daily run limit, and workflow concurrency
- RISK: PR code runs in CI, including inside `mergeproof check`'s proof runs, so the gate job checks out with `persist-credentials: false`, gets no secrets and a read-only token, only a separate merge job can write, the workflow passes the dispatching issue as `--issue`, and `SECURITY.md` documents every permission
- ASSUMPTION: shadow mode is the default until the customer sets `mode: enforce`, and the `MERGEPROOF_MODE` repo variable is a kill switch every workflow checks first
- ASSUMPTION: bring your own key, with harness and model as separate settings (Claude Code action by default, GLM through Z.ai's Anthropic-compatible endpoint)
- ASSUMPTION: agent PRs are identified by bot login (narrowed by branch prefix), fork PRs always go to a human, and human PRs are never gated

## Notes
- Skills ship as `SKILL.md` playbooks; harnesses without native skills read the same files as prompt instructions
- The ledger records skill name and version, and the benchmark repo scores each skill version before release
- The ledger lives on a `mergeproof-ledger` branch because Actions runners are ephemeral
- Demo: two issues (an honest bugfix and one that tempts a test edit) run end to end, first in shadow mode, then enforce
- Requires branch protection with required CI on main
- No telemetry; keys and code stay in the customer's GitHub
