# Roadmap

mergeproof's backlog. Each `### [ID]` item below is one proposed unit of
work; `mergeproof roadmap` opens one GitHub issue per `ready` item, labeled
`agent-proposed` (plus `bug` for a bugfix item), at most 5 per run. A
maintainer reviews each issue and adds the `agent` label to start the coding
agent on it — an issue never starts anything on its own. Every opened issue
ends with a `mergeproof-roadmap id=…` marker comment, matched against open
AND closed issues, so an item is proposed once, ever. Mark an item `done`
once its issue is finished.

Format:

```markdown
### [MP-012] Short imperative title
- kind: feature            # feature | bugfix | refactor | docs  (bugfix adds the `bug` label)
- status: ready            # ready | later | done   (only `ready` opens an issue)

Free markdown body: context, then an "Acceptance" list. Everything until the next `### [` item heading, a `#`/`##` section heading, or EOF is the body.
```

IDs match `^[A-Z][A-Z0-9]{1,9}-\d{1,5}$` (e.g. `MP-012`). A duplicate id, an
unknown kind or status, a bad id or a missing field is an error: the whole
run opens nothing until the file is fixed.

## Phase C — task-level recursion

### [MP-101] Add reason codes for weak proof
- kind: feature
- status: ready

Weak-proof notes are free text today (`src/prove.mjs`), so a retry teaches the agent little and later phases cannot aggregate reasons. Create `src/reasons.mjs` exporting `REASON_CODES` and `renderReason` (pure, no I/O), with the codes from the M3 plan: `NO_NEW_TEST`, `NEW_TEST_PASSES_ON_BASE{path}`, `FLAKY_ON_BASE{path,n,m}`, `FAILS_ON_HEAD{path}`, `FLAKY_ON_HEAD`, `SUITE_RED_ON_HEAD`, `SUITE_RED_ON_BASE`, `CI_RED`, `REFACTOR_CHANGES_TESTS`.

Acceptance:
- `src/reasons.mjs` exports `REASON_CODES` and `renderReason`; `renderReason` renders each code to the note wording `src/prove.mjs` prints today.
- New unit tests cover every code, including the `path`/`n`/`m` parameters, with no I/O.
- `tests/structure.test.mjs` lists `src/reasons.mjs` in the CONTRACT with those exports.

### [MP-102] Build prove notes through the reason codes
- kind: refactor
- status: ready

`src/prove.mjs` builds its weak-proof notes as inline strings. Route them through `src/reasons.mjs` (MP-101) so every weak-proof note carries a code, without changing what the gate prints or decides.

Acceptance:
- Every weak-proof note `src/prove.mjs` emits comes from `renderReason`; no verdict text changes.
- `tests/benchmarks.test.mjs` still expects the same verdicts for the pre-registered scenarios.
- The change touches no test file (a refactor is proven by the unchanged suite staying green on base and head).

### [MP-103] Verdict file v2 carries reasons
- kind: feature
- status: ready

The verdict file (`mergeproof-verdict@1`, `src/verdictfile.mjs`) has no field for why proof was weak, so the gate job cannot hand reasons to `apply`. Add schema `mergeproof-verdict@2` with a `reasons` array, and accept `@1` for one release so a gate job and an apply job on different versions still work.

Acceptance:
- `writeVerdictFile` writes `mergeproof-verdict@2` with `reasons`; `readVerdictFile` accepts `@1` (no reasons) and `@2`, and rejects an unknown schema.
- Unit tests round-trip both schemas, including a `@1` file produced before the change.
- The verdict contract itself is untouched: verdicts, notes and exit codes are unchanged.

### [MP-104] apply re-derives and validates verdict-file reasons
- kind: feature
- status: ready

`apply` trusts the verdict file for one fact (the proof held); reasons from the gate job must not become free text on the PR. Teach `src/commands/apply.mjs` to read the `@2` reasons: check each code against the enum, require `path` to be among the re-derived added test files and `n<m≤config.proof.*`, re-derive `NO_NEW_TEST` and `CI_RED` itself, and render the text itself.

Acceptance:
- Reasons never feed `decide()`; the comment keeps its `Mergeproof — RETRY (kind: …)` header and at most 3 notes.
- A forged code, a `path` outside the re-derived added tests, or `n≥m` renders the reason "suspect" and changes nothing else.
- `tests/apply.test.mjs` covers the round-trip, the forged-path case and a `@1` file with no reasons.

### [MP-105] RETRY carries every prior gate verdict, in order
- kind: feature
- status: ready

On a retry the agent sees only the latest verdict comment, so earlier feedback is lost. The context step of the issue workflow (`templates/workflows/mergeproof-issue.yml`) builds the trusted issue file; make it include all prior anchored gate verdict comments on the PR, in order, not just the latest.

Acceptance:
- The trusted issue file lists every `Mergeproof — …` comment anchored to the exact shape apply posts, oldest first.
- `tests/workflows.test.mjs` covers the ordering and still drops verdict-shaped text from anyone but `github-actions[bot]`.
- The agent's prompt is unchanged apart from the richer file.

### [MP-106] Critic rounds in the agent loop
- kind: feature
- status: ready

`src/commands/loop.mjs` already runs up to `--rounds` (1-3) implementer passes, feeding the `check --local --json` reasons back when a change is not proven. Add a critic to each round: after `check --local`, a fresh harness invocation with Edit/Write disallowed reviews the diff against the issue and prints `CRITIC: PASS|FIX` plus at most 5 findings; FIX findings go into the next round's feedback. Stop when the change is proven and the critic says PASS, or when the rounds run out.

Acceptance:
- The critic runs with the harness's write tools disallowed, and its findings are capped at 5 lines in the next prompt.
- The PR title and body are still written only when `proven` is true with no tamper notes, else `stop-comment.md`; a FIX on the last round writes `stop-comment.md`.
- A fake harness in `tests/loop.test.mjs` drives a FIX→PASS flow and a k-exhausted flow; the loop never decides a verdict.

## Phase D — measurement

### [MP-107] Events log for every landing
- kind: feature
- status: later

The ledger records proven outcomes only, so nothing can be measured. Create `src/events.mjs` and an `apply --events <file>` flag that appends one record per landing to `events.jsonl` on the ledger branch: `{id, at, pr, issue, kind, agent, model, skill, attempt, verdict, proven, reasons, tamperRules, held, mode, merged}`, built from re-derived data only.

Acceptance:
- `apply --events` appends exactly one record per landing, re-derived — never copied from PR text.
- A test pins that `trustFor` reads only `ledger.outcomes`: events never feed trust.
- `tests/structure.test.mjs` lists `src/events.mjs` in the CONTRACT.

### [MP-108] Union-merge the events log on push
- kind: feature
- status: later

Concurrent apply jobs each push `events.jsonl`; a plain rebase can drop or duplicate records. The ledger push step (`templates/workflows/mergeproof-pr.yml`) union-merges by `id` before pushing, the way outcomes are never doubled.

Acceptance:
- Two clones appending different records end with both on the remote, no duplicates by `id`.
- A record already on the remote is never rewritten by a stale push.
- `tests/workflows.test.mjs` runs the real push step against a bare remote, like the ledger-race test.

### [MP-109] mergeproof retro
- kind: feature
- status: later

Nothing summarizes how the agent is doing. Add `src/retro.mjs` (`summarize`) and `src/commands/retro.mjs` (`runRetro`): per (kind, agent, model, skill@version) over `events.jsonl` — runs, first-try proven rate, RETRY→proven rate, mean attempts, HUMAN reason histogram (humanOnly kept separate from tamper), merge rate, revert rate.

Acceptance:
- `mergeproof retro --ledger <dir>` prints the table; groups below `--min-n` (default 5) show "insufficient data".
- `retro` is registered in `src/cli.mjs` COMMANDS, the `tests/structure.test.mjs` CONTRACT and `action.yml`'s allowed command list.
- Unit tests drive `summarize` with a fixture events file, no I/O.

### [MP-110] Nightly sync writes retro to the step summary
- kind: feature
- status: later

The retro table exists (MP-109) but nobody sees it. The nightly sync workflow (`templates/workflows/mergeproof-sync.yml`) runs `mergeproof retro` after settling and appends its output to `$GITHUB_STEP_SUMMARY`.

Acceptance:
- The sync workflow has a step running `mergeproof retro` that writes to `$GITHUB_STEP_SUMMARY`.
- The step needs no new secret, and the workflow's permissions grow by nothing it does not already have.
- `tests/workflows.test.mjs` covers the new step.

## Phase G — portability

### [MP-111] Per-file test command placeholders
- kind: feature
- status: later

`testFileCommand` only knows how to append a file path. `src/adapters/runner.mjs` gains placeholders substituted per argv element — `{file}` (today's append behaviour), `{dir}`, `{stem}`, `{goTests}` — with every substituted value checked against SAFE_PATH; Go test names must match `^Test\w*$`.

Acceptance:
- All four placeholders substitute per argv element; a config without placeholders keeps today's append behaviour.
- Every substituted value is checked against SAFE_PATH; a `{goTests}` name not matching `^Test\w*$` is refused.
- Runner unit tests cover each placeholder and both refusals.

### [MP-112] Parse go test and cargo test counts
- kind: feature
- status: later

`parseTestCount` reads node:test, jest, vitest and pytest output only, so a dropped-case refactor is invisible on Go and Rust. Extend `src/adapters/runner.mjs` `parseTestCount` to handle `go test -v` (`--- PASS:` / `--- FAIL:`) and cargo's `test result:` lines.

Acceptance:
- `parseTestCount` returns the case count from sample `go test -v` and cargo output, with fixtures under `tests/`.
- Counts that don't parse are still skipped, never guessed.
- The existing runners' counts are unchanged.

### [MP-113] Default per-file commands for Go, Rust and Python
- kind: feature
- status: later

Proving one new test file needs a per-ecosystem command. `src/config.mjs` gains the M3 plan's defaults: Go `go test -count=1 -run '^(TestA|TestB)$' ./{dir}` (test names come from the new file), Rust `cargo test --test {stem}` (proving tests must be new `tests/*.rs` files), Python `python -m pytest -q {file}` (the install command must not be editable).

Acceptance:
- `defaultConfig()` carries the three `testFileCommand` defaults alongside the Node one, with the rules above encoded where they are checkable.
- Config validation still accepts repos that override them.
- Scenarios 13–16 are pre-registered in `benchmarks/specs.md` and pass in `tests/benchmarks.test.mjs`, skipped where a toolchain is missing.

### [MP-114] Share dependency caches per ecosystem
- kind: feature
- status: later

The unprivileged test user cannot read the runner's home, and each ecosystem keeps its cache elsewhere. Extend `src/adapters/sandbox.mjs` (`shareModules`, `linkNodeModules`) per ecosystem: Python `.venv`, plus `GOMODCACHE` and `CARGO_HOME` readable by `--test-user`.

Acceptance:
- A proof run as `--test-user` can read the shared cache for each ecosystem; the runner's own home stays unreadable.
- Node's existing hard-link mirror behaviour is unchanged.
- Sandbox tests cover each new path.

### [MP-115] Ecosystem detection for init
- kind: feature
- status: later

`mergeproof init` detects npm only. Create `src/ecosystems.mjs` (`ECOSYSTEMS`, `detectEcosystem`) and use it in `src/commands/init.mjs` to write `testCommand`, `testFileCommand`, the install command, a digest-pinned agent image, and setup-python/setup-go steps (GitHub-owned, SHA-pinned).

Acceptance:
- `detectEcosystem` picks the ecosystem from the repo's manifests; `init` writes the per-ecosystem values for Python, Go and Rust repos.
- Any `uses:` the templates add is GitHub-owned and pinned by a full commit SHA.
- `tests/ecosystems.test.mjs` (CONTRACT-listed) covers detection against real repos, no network.

### [MP-116] Language-neutral skills v4, plus refactor and docs
- kind: docs
- status: later

The bugfix/feature skills are Node-flavoured. Rewrite `skills/bugfix/SKILL.md` and `skills/feature/SKILL.md` language-neutral (v4) and add `skills/refactor/SKILL.md` and `skills/docs/SKILL.md` with the same frontmatter shape.

Acceptance:
- All four skills carry name, integer version and description frontmatter (`tests/structure.test.mjs` passes).
- No skill names a specific package manager or language where it can be neutral.
- The proof rules each skill states match what the gate actually checks for that kind.

## Phase F — outer loop

### [MP-117] Lessons file as the persistent improvement harness
- kind: feature
- status: later

`.mergeproof/lessons.md` is where agents pick up what past runs learned: they read it right after the skill. It is a gate file, so any edit to it is HUMAN — list it under `paths.humanOnly` in this repo's `.mergeproof.json`, and document the file for other repos.

Acceptance:
- `.mergeproof/lessons.md` exists with a short format description; the skills point agents at it after the skill body.
- An agent PR editing it gets HUMAN in this repo (covered by a test or benchmark scenario).
- The lessons file is matched by a gate path (humanOnly or agent instructions), so a docs-only PR cannot rewrite it.

### [MP-118] reflect-publish with an exact path allowlist
- kind: feature
- status: later

The reflector proposes; the user merges. A `reflect-publish` job accepts an agent output only inside an exact allowlist: `.mergeproof/lessons.md`, plus `skills/**` only when `MERGEPROOF_REFLECT_SKILLS=true` (this repo); never `.mergeproof.json`. Every changed SKILL.md must bump its version; lesson lines must look like `- [L-n] … (evidence: #a, #b)` where the cited PRs exist in `events.jsonl` and share a reason code; at most 40 lessons / 4 KB; the evidence table in the PR body is written by the job from retro JSON, not by the model.

Acceptance:
- The job refuses anything outside the allowlist, an unversioned skill change, an oversized lessons file, or a lesson whose cited PRs are missing from `events.jsonl` or share no reason code.
- The evidence table is rendered by the job from retro JSON.
- `tests/workflows.test.mjs` covers each refusal.

### [MP-119] Weekly reflect workflow
- kind: feature
- status: later

A weekly `mergeproof-reflect.yml` closes the outer loop: a trusted job computes retro from `events.jsonl`, the container runs `skills/reflect`, then `reflect-publish` (MP-118) validates and opens the PR.

Acceptance:
- The workflow runs weekly (`schedule`) plus `workflow_dispatch`, behind the `MERGEPROOF_MODE` kill switch, with pinned actions and a timeout on every job.
- The container that runs the reflector holds no GitHub credential; only the publish job pushes.
- `tests/workflows.test.mjs` checks the triggers, the pins and the credential split.

### [MP-120] Skillbench
- kind: feature
- status: later

"Benchmarks score each skill version" does not exist yet. Add `skillbench.yml`, running only on skill-change PRs: tasks in `benchmarks/skillbench/<lang>-<id>/{task.json, issue.md, base/, hidden/}`, starting with 6 tasks (Node, Python, Go) and 2 runs each; the agent sees only `base/`; hidden tests run in a separate container with no token; score = proven && !tamper && hidden tests pass, plus rounds and diff size.

Acceptance:
- The workflow runs only on PRs that change `skills/**`, with actions pinned and no secret in the hidden-test container.
- Score components are computed from run outputs, never from agent-reported text.
- Tests cover task-layout validation: a task missing `hidden/` fails the workflow.

### [MP-121] Pin the skill-copy promotion invariants
- kind: refactor
- status: later

`.mergeproof/skills/<kind>` copies must never drift from `skills/<kind>`. Add `tests/skills.test.mjs`: the version of `.mergeproof/skills/<k>` must be ≤ that of `skills/<k>`; equal versions require identical bytes; only `scripts/promote.mjs` moves the copies.

Acceptance:
- The three invariants are asserted for every shipped skill.
- The suite fails on a hand-edited copy (an older version, or an equal version with different bytes).
- No production code changes; the suite runs in `npm test`.
