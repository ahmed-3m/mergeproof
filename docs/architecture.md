# Architecture

## Pipeline (`mergeproof check`)

```text
config from base ─► classifyKind ─► detectTampering ─► proveChange ─► trustFor ─► decide ─► verdict
   config.mjs        classify.mjs     tamper.mjs         prove.mjs     ledger.mjs   decide.mjs
                                                                                     │
                       proven PR (any mode, not --dry-run) ─► appendOutcome: open ◄───┤
                       enforce mode + MERGE ─► squash merge pinned to the proven head  │
                                               with a Mergeproof-Verdict trailer ◄─────┘
```

- **Config comes from the base branch tip**, never the PR and never the older merge-base it branched from, so a PR can't loosen its own gate or dodge a tightening made after it branched. The diff is still taken from the merge-base. A PR that edits `.mergeproof.json`, `.mergeproof/**` or `.github/**` is tampering.
- **Tamper rules run before any test.** A tamper note ends the run with `HUMAN`, so the gate never executes code from a PR it already distrusts.
- **Proof runs in throwaway worktrees**: one at base (with the PR's new test files copied in), one at head. They share the checkout's `node_modules`, which is safe because any manifest change makes the PR `deps`, and deps PRs are never tested. Credentials (`*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*API_KEY*`) are removed from the test environment.
- **The shared `.git` is guarded.** Worktrees share the checkout's `.git` directory, so PR test code could plant a hook, an fsmonitor or a filter in its config, or a ref or an alternates redirect that changes what the gate's next git call reads. Every git call runs with `core.hooksPath` set to the null device and `core.fsmonitor=false`, and `.git`'s `config`, `config.worktree`, `hooks/`, `info/`, `refs/`, `HEAD`, `packed-refs`, `objects/info/alternates` and the ledger are fingerprinted before and after the proof. Any change ends the run with `HUMAN`; the worktrees are then deleted without calling git, and nothing is logged. The ledger is read once, before any PR code runs.
- **The merge is pinned** with `gh pr merge --match-head-commit`, so a push after the proof can't ride along.
- `check --local` runs the same pipeline on `HEAD` against its merge base with `--base` (default: origin's default branch). It never merges, comments or writes the ledger. Agents use it as a preflight (M2).
- `mergeproof sync` settles the ledger (below) and opens a human-triage issue for every newly reverted merge.

All I/O goes through `src/adapters/`: `process` for child processes, `git` for local history and worktrees, `gh` for GitHub, `runner` for tests. `classify`, `tamper`, `prove`, `decide`, `ledger` and `trailer` are pure, and `evaluate()` in `src/commands/check.mjs` takes its adapters as arguments, so everything is testable without GitHub.

## Workflows: gate job and apply job

PR code runs inside the gate (the proof worktrees execute the PR's tests), so in CI the gate is split into two jobs (M2):

- **Gate job** — checks out with `persist-credentials: false`, a read-only token and no secrets, and runs `check <pr-url> --verdict-out <file>`. The gate runs exactly as always but writes nothing to GitHub: no merge, no comment, no ledger write, exactly like `--dry-run`. It writes a `mergeproof-verdict@1` JSON file (`url`, `pr`, `headSha`, `kind`, `verdict`, `notes`, `proven`, `agent`, `model`, `skill`, `attempts`, `issue`; `proven` is true only when the proof held with no tamper notes) and still exits with the verdict's code. `verdict-out` with `--local` is a usage error. The workflow also passes `--head <sha>`, the head whose CI completed the `workflow_run` event: if the PR has moved since, the gate stands down (`HUMAN`, no proofs, nothing written, and the verdict file names the CI'd commit with `proven: false`) so apply's moved-head refusal supersedes the run — a push after CI can never be merged on a proof run gated to an earlier, un-CI'd commit.
- **Apply job** — the only job that can write, and it never runs PR code. It runs `apply <verdict-file> --pr <pr-url>` (the PR comes from the triggering event, never from the file, and a file naming another PR is refused, so a proof never transfers between PRs; `--dry-run`, `--json`, `--ledger`, plus the same `--agent`/`--model`/`--skill`/`--attempt`/`--issue` flags the gate job got; `--agent` and `--model` are required). The verdict file is written in the job that ran PR code — PR test code can leave a background process that rewrites it after the gate — so every field in it is attacker-controlled. `apply` trusts it for exactly one fact, the one it cannot observe without running PR code: that the proof held. Everything else is re-derived in the apply job: the file is validated strictly (anything malformed is an error, note text is bounded and never posted), the flags must match the file, the PR is re-fetched and must be `OPEN` with its head still the gated SHA, it must still be an agent PR under the config at the *current* base tip, kind and the path tamper rules are re-derived from the fetched diff through the same `inspect()` the gate uses, trust comes from the apply job's own ledger, and CI is re-read. A closed/moved/non-agent PR or `mode: off` is a `HUMAN` refusal with nothing written; a file that disagrees with any re-check is a `HUMAN` refusal that comments and labels the PR `needs-human`, because a PR whose gate output was tampered with needs a human. Otherwise it lands exactly like `check` through `land()` in `src/land.mjs`: the outcome is recorded when proven, a `MERGE` in enforce mode squash-merges pinned to the gated head SHA with the `Mergeproof-Verdict` trailer, the ledger is written and the re-derived verdict commented. A gate `HUMAN` that now re-checks as `MERGE` (trust grew between the jobs) lands as `HUMAN`. A `MERGE` whose CI is no longer green is landed as `RETRY` — apply can lower a verdict, never raise one. `RETRY` adds no label; the workflow counts retries.

**Residual risk:** the apply job re-checks identity, flags, kind, tamper rules, trust and CI, and pins the merge to the gated head SHA, but it cannot re-prove the change without running PR code — whatever can forge the verdict artifact could still claim a proof that never happened. That is why the gate job gets no secrets and a read-only token, and only the apply job can write. `check` without `--verdict-out` keeps merging by itself for repos that run the gate in one trusted job.

### Workflow templates

`templates/workflows/` holds the three GitHub Actions workflows that `mergeproof init` copies into a customer repo (M2); `action.yml` at the mergeproof repo root is the composite action they call — `ahmed-3m/mergeproof@v1`, which validates its `command` input, sets up Node, runs `bin/mergeproof.mjs` with `args` split without shell expansion, and exposes the CLI's exit code as an `exit-code` output so a workflow can tell a verdict (0/3/4) from an error (1/2). Placeholders, repo variables and secrets are documented in `templates/README.md`; every job of every template checks the `vars.MERGEPROOF_MODE != 'off'` kill switch first.

- **`mergeproof-pr.yml`** — flow 3, PR to outcome. Job graph: `context` → `gate` → `apply`. `context` checks out no code: it resolves the PR URL, number and head SHA (from the `workflow_run` event, or `gh pr view` on a dispatch), reads the dispatch marker, counts prior gate RETRY comments, and takes agent and model from repo variables — all as outputs. `gate` is the read-only gate job above (plus the repo's install command and the ledger branch checked out into `.mergeproof-ledger/`, read via `--ledger`). `apply` is the write job above; afterwards it commits and pushes the ledger, and on exit 3 (RETRY) it either re-dispatches the agent (`gh workflow run mergeproof-issue.yml` with `pr`, `issue` and `attempt` + 1, while attempt < 3) or labels the PR `needs-human` — retries exhausted, or a RETRY on a PR with no dispatching issue to fix. Exit 4 already labels inside `apply`.
- **`mergeproof-issue.yml`** — flow 2, issue to PR. Prompt-injection guard: an issue opened by a Bot never starts a run; `opened` only for authors in the `MERGEPROOF_AUTHORS` variable; `labeled` only for the `agent` label by a non-bot sender who is a write/maintain/admin collaborator (checked via the collaborators API). A daily cap (`MERGEPROOF_DAILY_LIMIT`) counts today's runs of the workflow itself. The kind comes from the issue's labels (`MERGEPROOF_BUGFIX_LABELS`), the skill from the installed `SKILL.md` frontmatter, and the agent harness runs with the model key and bot token secrets. Afterwards the workflow finds the PR the bot opened on an `agent/<kind>-<issue>-*` branch and posts the dispatch marker; a retry dispatch posts no second marker.
- **`mergeproof-sync.yml`** — the nightly `sync` run that settles the ledger and opens regression issues.

**Why `workflow_run`, not `pull_request`:** with a `pull_request` trigger, the PR's own edited copy of the workflow file would run; `workflow_run` always runs the default-branch definition. Fork PRs carry no `pull_requests` entries in the event, so the workflow skips them — the gate's login rule sends fork PRs to a `HUMAN` refusal anyway.

**Where the issue number, skill and attempt come from:** never the PR. The issue workflow posts the dispatch marker as a comment authored by `github-actions[bot]` (`<!-- mergeproof-dispatch issue=<n> skill=<name@version> -->` plus a human-readable line); the PR workflow's `context` job reads comments by that author only and ignores everything the agent or anyone else writes. The attempt count is 1 + the number of prior `Mergeproof — RETRY` verdict comments, likewise counted only for `github-actions[bot]` — the agent cannot inflate or deflate its own attempt history.

**The ledger branch:** Actions runners are ephemeral, so the ledger lives on a `mergeproof-ledger` branch, checked out into `.mergeproof-ledger/` and passed as `--ledger`. The gate only reads it (a missing branch reads as empty); the apply job and the nightly sync both push it, so they share the concurrency group `mergeproof-ledger` with `cancel-in-progress: false` — a lost push race is retried once with a rebase, never cancelled mid-write. The gate job keeps its own group `mergeproof-pr-<pr>` with `cancel-in-progress: true`, so a newer CI run for the same PR replaces the stale gate.


## Kinds

| Changed paths | Kind |
|---|---|
| Any manifest or lockfile | `deps` |
| Only docs | `docs` |
| Source, no tests | `refactor` |
| Source and tests | `feature`, or `bugfix` when the `--issue` has a label from `issueLabels.bugfix` |
| Only tests, or nothing | none, so `HUMAN` |

Feature and bugfix have the same proof, so the label only picks the trust bucket. It comes from the issue the workflow dispatched the agent for, passed as `--issue <n>` and looked up in the PR's own repository. The PR's "closes #N" links are ignored: the agent writes those and could point at any labeled issue. Labels and commit prefixes written on the PR itself are only compared against the paths.

## Tamper rules

`unsafePath` (file names outside `[A-Za-z0-9_@+./-]`, or starting with `-`), `gateFilesEdited`, `existingTestEdited` (modified or renamed), `existingTestDeleted`, `skipMarkerAdded` (`.skip`, `.only`, `.todo`, `xit`, `@pytest.mark.skip`...), `kindLabelMismatch`, `diffTooLarge` (lockfiles don't count). Rules are plain functions in `TAMPER_RULES`, so new ones drop in as agents adapt.

`testCountDropped` needs the suite output, not the diff, so the refactor proof finds it instead of the path rules: a refactor may not touch test files, but it can still make cases disappear — a test file that generates its cases from a list in `src/`, where the PR deletes entries. The full-suite runs on base and head also count test cases (`parseTestCount` in the runner adapter: node:test spec and TAP, jest, vitest, pytest; when a run reports several summaries, the last one counts). Fewer cases on head than base is tampering → `HUMAN`, and the PR is not logged. When either side's count does not parse, the check is skipped, so unknown runners keep working.

## Proof per kind

| Kind | Proof |
|---|---|
| feature, bugfix | Every new test file fails on base `baseFailRuns` of `baseFailRuns` runs and passes on head `headPassRuns` of `headPassRuns` runs, run with `testFileCommand <file>` |
| refactor | Full suite (`testCommand`) green on base and on head; the counted test cases must not drop |
| docs | Nothing to run |
| deps | Nothing to run; never merged |

Then every kind except deps needs CI green. Without a CI result (local preflight, or a repo with no checks) the full suite runs on head instead, with `headReruns` reruns before a failure counts; a refactor runs the head suite even with a CI result, because flow 2 needs green on base and head and the case count has to be compared. Checks whose name contains `mergeproof` are ignored, since the gate's own job is still running.

Feature and bugfix changes get no count check: their base worktree carries the PR's new (and there failing) test files, so a base full-suite count is not comparable to head's.

## Decision table

| Condition (checked in order) | Verdict |
|---|---|
| Any tamper note | `HUMAN` |
| Kind is `deps` | `HUMAN` |
| No kind fits the paths | `HUMAN` |
| Proof is weak (CI red, new test passes on base, flaky, no new test) | `RETRY` |
| Proof is impossible (suite already red on base) | `HUMAN` |
| Kind not trusted for this agent and model | `HUMAN` |
| Otherwise | `MERGE` |

In `shadow` mode a `MERGE` verdict is reported but never executed. `off` turns the gate into a constant `HUMAN`, so nothing merges. An agent PR is one whose author is in `agents.logins` and, when `agents.branchPrefixes` is non-empty, whose branch starts with one of them. Anyone can name a branch `agent/...`, so the branch alone never makes a PR an agent PR. Every other PR, and every fork PR, goes to `HUMAN`.

## Config (`.mergeproof.json`)

v1 reads plain JSON, so the gate needs no parser of its own. YAML may come later. Every key is optional. `parseConfig` deep-merges the file over `defaultConfig()` and rejects unknown keys, wrong types and out-of-range numbers, so a typo can never quietly fall back to a default.

```json
{
  "mode": "shadow",
  "testCommand": "npm test",
  "testFileCommand": "node --test",
  "paths": {
    "tests": ["test/**", "tests/**", "**/*.test.*", "**/*.spec.*"],
    "testSupport": ["**/fixtures/**", "**/__fixtures__/**", "**/__snapshots__/**", "**/__mocks__/**", "**/helpers/**", "**/*.snap", "**/*.json"],
    "docs": ["docs/**", "**/*.md"],
    "manifests": ["package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"]
  },
  "issueLabels": { "bugfix": ["bug"] },
  "limits": { "maxDiffLines": 300, "testTimeoutSec": 600, "ciWaitSec": 600 },
  "proof": { "baseFailRuns": 2, "headPassRuns": 3, "headReruns": 1 },
  "trust": { "minOutcomes": 10, "minCleanRate": 0.9, "revertWindowDays": 14 },
  "agents": { "logins": [], "branchPrefixes": ["agent/"] },
  "quarantine": []
}
```

- `testCommand` runs the full suite; `testFileCommand` runs one test file, which is appended as its last argument (`npx jest`, `npx vitest run`, `pytest` also work). Both are split on whitespace with no shell quoting.
- Globs: `**` spans directories, `*` and `?` stay inside one segment, and a pattern with no `/` matches the file name at any depth.
- `quarantine`: test files left out of per-file proof runs because they are known to be flaky.
- `paths.testSupport`: files under a `paths.tests` glob that are not tests themselves (helpers, fixtures, snapshots). They still make a change a feature or bugfix, but are never run as a new test that must fail on base. A file named like a test (`*.test.*`, `*.spec.*`) is always a test, even in such a directory.
- `limits.ciWaitSec`: how long `check` and `apply` wait for CI that is still pending (other workflows), re-reading it every 30 seconds; `0` turns the wait off. CI still pending after the wait is HUMAN, never RETRY.

## Ledger (`mergeproof-ledger@1`, default `.mergeproof/ledger.json`)

```json
{
  "schema": "mergeproof-ledger@1",
  "outcomes": [
    { "pr": 42, "url": "https://github.com/o/r/pull/42", "kind": "bugfix", "agent": "claude-code", "model": "glm-5.2",
      "skill": "bugfix@1", "attempts": 1, "verdict": "MERGE", "provenAt": "2026-10-22T10:00:00Z",
      "mergedAt": "2026-10-22T10:01:00Z", "mergeCommit": "3f2c…", "status": "pending" }
  ]
}
```

Every PR whose proof held is logged, even when the verdict is `HUMAN` because the kind isn't trusted yet. Human merges of proven PRs then earn trust too, which is how shadow mode and a cold start build a track record. `sync` moves outcomes along:

| Status | Meaning | Next |
|---|---|---|
| `open` | proven, not merged yet | `pending` when the PR merges, `closed` if it closes unmerged |
| `pending` | merged, inside `revertWindowDays` | `reverted` if a `git revert` of its merge commit lands inside the window, else `clean` once the window passes |
| `clean` / `reverted` / `closed` | settled | — |

Trust per (kind, agent, model) counts only `clean` and `reverted` outcomes: at least `minOutcomes`, at least `minCleanRate` clean, and no revert in the last `minOutcomes` merges. Agent and model come from `--agent` and `--model`, set by the workflow and never read from the PR.

## Decisions

- **Config format (resolved).** v1 uses `.mergeproof.json`: zero dependencies and no parser bugs. YAML may come later.
- **Feature vs bugfix (resolved for M1).** The maintainer label on the `--issue` the workflow passes picks the bucket (`issueLabels.bugfix`); without one, it's a feature. M2 must make sure the agent's token can't label issues.
