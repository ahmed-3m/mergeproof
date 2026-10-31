---
schema: b2i-brief@1
template: worker
distilled: Close mergeproof's self-development loop so issues on this repo become gated, merged PRs, and the agent playbooks improve from measured evidence, without the gate ever calling a model
---
# Mergeproof Self-Development Loop (milestone 3)

## Goal
- mergeproof develops itself: a roadmap item becomes an issue, the issue becomes a PR from the coding agent, and the gate proves it or sends it back
- What the loop learns (playbooks, lessons) carries over to a user's other projects (Node, Python, Go, Rust); monorepos are M4
- Built after M2, and only the first phases by hand: from phase E on, the bot builds the rest from `ROADMAP.md`

## Principles
1. The gate is the only judge. It is deterministic and never calls a model. Events and retro output never feed `trustFor`
2. The last release runs the loop. The gate pin, the workflows and the skills the loop uses all come from the last release. PRs build the next version; a human release plus a promotion PR swaps it in. A gate change that auto-merges therefore judges nothing until a human releases it. This repo's workflows are rendered from `templates/`, so no workflow code exists only here, untested
3. Harness-style structure, deterministic judging. Inner loop: implement, `check --local`, a fresh critic, for k rounds, plus gate RETRYs that carry specific reasons. Outer loop: a reflector proposes lessons and skill versions backed by retro and skillbench evidence; a human merges them
4. Bootstrap by hand, then recurse. Phases 0, A, B and E are written by hand. Every later item is a `ROADMAP.md` entry the bot implements and the gate proves

## Phases (release after each, then a promotion PR)
1. Phase 0, housekeeping: this brief, the `SECURITY.md` corrections, branch protection on `main`, the 0.1.3 release and the gate re-pin
2. Phase A, unblock the inner loop (0.2.0):
   - A1 CLI: `check --json` gains `proven` and `reasons`; `check --local` finds the base on clones without `origin/HEAD`; commands load lazily; `npm test` discovers suites through `scripts/run-tests.mjs`; an import-closure test keeps agent-side modules out of the gate
   - A2 harness: the issue workflow runs a Claude Code, Gemini or agy harness in the credential-free container (pinned tarballs, tool deny-list, wall-clock and daily caps, identity check), with `src/commands/loop.mjs` deciding readiness from `check --local --json`
   - A3 promotion: `scripts/promote.mjs` renders `templates/` and `skills/` into this repo and prints every gate-path file changed since the last release
3. Phase B, safety (0.2.1): `paths.humanOnly`; manifest and test-path defaults for Python, Go and Rust; skip markers for those languages in the tamper rules; scenarios 9 to 12 pre-registered in `benchmarks/specs.md`
4. Phase E, backlog (0.2.2): `ROADMAP.md` and `scripts/roadmap.mjs` open one `agent-proposed` issue per ready item (de-duplicated against open and closed issues); the maintainer's `agent` label is the review that starts a run
5. Built by the bot from roadmap items:
   - C, task-level recursion: reason codes, verdict file `@2` with `reasons`, contrastive retries, critic rounds in `loop.mjs`
   - D, measurement: an events log on the ledger branch and `mergeproof retro`
   - G, portability: per-ecosystem test commands, dependency sharing, `src/ecosystems.mjs`, language-neutral skills
   - F, outer loop: `.mergeproof/lessons.md`, a weekly reflector whose PRs are path-allowlisted and evidence-checked, and skillbench on skill-change PRs

## Human-only scope in this repo
- The changes that decide a verdict stay with a human: `src/tamper.mjs`, `src/decide.mjs`, `src/prove.mjs`, `src/ledger.mjs`, `src/verdictfile.mjs`, `src/commands/apply.mjs`, `src/land.mjs`, plus the non-code control files (`action.yml`, `templates/**`, `benchmarks/**`, `scripts/promote.mjs`, `SECURITY.md`, `ROADMAP.md`). Enforced by `paths.humanOnly` from phase B on
- The rest (`config`, `inspect`, `classify`, `agents`, `adapters`) may auto-merge once trust is earned. Compensating controls: principle 2, `promote.mjs` listing gate-path changes at release time, the benchmark scenarios, and the import-closure test

## Risks & assumptions
- RISK: a Claude Code subscription token in the agent container shares usage limits with its owner and can leak through prompt injection. It runs only in the credential-free container, with network-tool denials, a wall-clock timeout, `MERGEPROOF_ROUNDS` and a daily cap (`MERGEPROOF_DAILY_LIMIT`)
- RISK: the first auto-merge needs 10 clean settled outcomes in one bucket, so expect weeks of small issues before it happens; until then every verdict for a new bucket is HUMAN
- RISK: skillbench spends real agent time (tasks x runs x 2 versions), so it runs only on PRs that change skills, starting with 6 tasks and 2 runs
- ASSUMPTION: `main` is protected (PRs and the CI checks required, no force-push or deletion). Reviews are not required, because `apply` merges with the workflow token, and "require branches up to date" stays off, because a head-pinned merge would stall whenever `main` moves
- ASSUMPTION: repo variables for this repo's bot are `MERGEPROOF_HARNESS=claude`, `MERGEPROOF_AGENT=claude-code`, `MERGEPROOF_MODEL` (the chosen model ID) and `MERGEPROOF_DAILY_LIMIT=5`, with the matching `agents.identities` entry for `mergeproof-bot`; the secret `CLAUDE_CODE_OAUTH_TOKEN` comes from `claude setup-token`

## Notes
- Constraints from AGENTS.md hold throughout: zero dependencies (the agent CLIs and container images are CI tools, not package dependencies), no model call in the gate, verdict contract and exit codes frozen (only additive JSON fields), at most 3 notes, every child process through `runProcess`, shadow as the default mode
- Loop and reflect code stay import-isolated from the gate; a test fails if `check`, `apply`, `sync` or `land` can reach `dispatch` or `loop`
- Every PR updates `CHANGELOG.md` under `[Unreleased]`

## Verification
- Every PR: `npm test` green on ubuntu and windows with Node 18, 22 and 24
- Phase A end to end: a small hand-written issue labelled `agent` yields a PR from `mergeproof-bot`; CI goes green; the gate says HUMAN "not trusted yet" with `proven: true`; an open outcome appears on `mergeproof-ledger`
- Phase B: scenarios 9 to 12 pass, and a PR touching `src/decide.mjs` gets HUMAN even when the bucket is trusted
- Phase E: a push to `ROADMAP.md` opens each `agent-proposed` issue once, and nothing starts without the maintainer's label
- Phase C onward: a fixture issue whose first test passes on base yields a RETRY naming the reason, and the agent fixes it on the same PR; `retro` runs on the ledger branch; scenarios 13 to 16 pass; a reflector PR arrives with an evidence table and gets HUMAN
- Before each release: re-gate one HUMAN and one RETRY fixture PR on the candidate commit and review `promote.mjs`'s list of gate-path changes
