# Prototype spec — Mergeproof

> Idea: Zero-dependency CLI that checks AI-agent PRs for test tampering and real per-kind proof, then merges only task kinds an agent has earned trust for

## Goal
- Decide without a human whether an AI agent's PR is safe to merge, and say why in at most 3 reasons
- Earn autonomy per task kind and per agent from a measured track record instead of switching it on globally

## Core flows
1. Inspect: `mergeproof check <pr-url>` (or `--local` on a working tree) reads `.mergeproof.json`, classifies the kind from changed paths only, and flags tampering such as edited or deleted existing tests, a dropped test count, new skip markers, a label or commit prefix that disagrees with the paths, or an oversized diff
2. Prove per kind: feature and bugfix need new tests that fail on base 2 of 2 runs and pass on head 3 of 3, running only the new tests on base; refactor needs zero test-file changes and the full suite green on base and head; docs touch only docs paths; deps touch only manifests and lockfiles; every kind needs CI green, with one rerun before a head failure blocks
3. Decide and learn: return MERGE, RETRY for weak proof, or HUMAN for tampering, deps, or a kind not yet trusted; a merge is squashed with a `Mergeproof-Verdict` trailer and logged with kind, agent, model, skill, and attempts, and `mergeproof sync` finds reverts of stamped commits, marks them failed, and opens a human-triage regression issue

## Out of scope
- Writing code, running agents, or GitHub workflows (milestone 2)
- Security, lint, and performance analysis (required as existing CI checks such as CodeQL and linters, not re-implemented)
- GitHub App, OAuth, webhooks, a hosted service, or a dashboard (v2)
- Mutation testing and hot-fix detection (later)
- Monorepos and more than one test runner in v1 (Node `npm test` first, pytest next)

## Risks & assumptions
- RISK: flaky suites cause false blocks or false proof; repeat runs reduce this, and very flaky repos need a quarantine list in the config
- RISK: tamper heuristics can miss subtle gaming such as weakened assertions, and agents adapt to known rules; keep rules pluggable and let reverts in the ledger catch misses
- RISK: deps PRs can pass every test while pulling in a compromised package, so they never auto-merge in v1
- RISK: running PR code executes untrusted code; run it in CI with no secrets on test steps
- RISK: low-volume repos earn trust slowly; allow a lower docs threshold or seeding the ledger from a demo repo
- ASSUMPTION: a kind unlocks for an agent and model after at least 10 outcomes with at least 90% clean, and drops back to human review after any revert in its last 10
- ASSUMPTION: success means merged and not reverted within 14 days
- ASSUMPTION: zero-dependency Node CLI, no LLM calls, config in `.mergeproof.json`, ledger as JSON

## Notes
- Demo: a seeded `demo/ledger.json` with 10 clean bugfix and refactor outcomes plus four agent PRs (honest fix, honest refactor, one that edits a test, one whose new test passes on base); expected verdicts MERGE, MERGE, HUMAN, RETRY, and an empty-ledger run shows cold start
- `--dry-run` prints the verdict without merging; `--local` is the preflight agents run before opening a PR
- Output mirrors b2i: a one-line verdict plus at most 3 reasons, with `--json` for workflows
- Published as `@ahmed-3m/mergeproof` under MIT
