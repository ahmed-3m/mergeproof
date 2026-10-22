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

- **Config comes from the base commit**, never the PR, so a PR can't loosen its own gate. A PR that edits `.mergeproof.json`, `.mergeproof/**` or `.github/**` is tampering.
- **Tamper rules run before any test.** A tamper note ends the run with `HUMAN`, so the gate never executes code from a PR it already distrusts.
- **Proof runs in throwaway worktrees**: one at base (with the PR's new test files copied in), one at head. They share the checkout's `node_modules`, which is safe because any manifest change makes the PR `deps`, and deps PRs are never tested. Credentials (`*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*API_KEY*`) are removed from the test environment.
- **The merge is pinned** with `gh pr merge --match-head-commit`, so a push after the proof can't ride along.
- `check --local` runs the same pipeline on `HEAD` against its merge base with `--base` (default: origin's default branch). It never merges, comments or writes the ledger. Agents use it as a preflight (M2).
- `mergeproof sync` settles the ledger (below) and opens a human-triage issue for every newly reverted merge.

All I/O goes through `src/adapters/`: `process` for child processes, `git` for local history and worktrees, `gh` for GitHub, `runner` for tests. `classify`, `tamper`, `prove`, `decide`, `ledger` and `trailer` are pure, and `evaluate()` in `src/commands/check.mjs` takes its adapters as arguments, so everything is testable without GitHub.

## Kinds

| Changed paths | Kind |
|---|---|
| Any manifest or lockfile | `deps` |
| Only docs | `docs` |
| Source, no tests | `refactor` |
| Source and tests | `feature`, or `bugfix` when the linked issue has a label from `issueLabels.bugfix` |
| Only tests, or nothing | none, so `HUMAN` |

Feature and bugfix have the same proof, so the label only picks the trust bucket. It comes from the issue the PR closes, which a maintainer labels and the agent's PR can't change. Labels and commit prefixes written on the PR itself are only compared against the paths.

## Tamper rules

`unsafePath` (file names outside `[A-Za-z0-9_@+./-]`, or starting with `-`), `gateFilesEdited`, `existingTestEdited` (modified or renamed), `existingTestDeleted`, `skipMarkerAdded` (`.skip`, `.only`, `.todo`, `xit`, `@pytest.mark.skip`...), `kindLabelMismatch`, `diffTooLarge` (lockfiles don't count). Rules are plain functions in `TAMPER_RULES`, so new ones drop in as agents adapt.

A dropped test-case count is not checked yet. Proof runs per test file using exit codes, so it works with any runner, and existing test files can't change anyway. Counting individual cases needs per-runner output parsing and comes later.

## Proof per kind

| Kind | Proof |
|---|---|
| feature, bugfix | Every new test file fails on base `baseFailRuns` of `baseFailRuns` runs and passes on head `headPassRuns` of `headPassRuns` runs, run with `testFileCommand <file>` |
| refactor | Full suite (`testCommand`) green on base |
| docs | Nothing to run |
| deps | Nothing to run; never merged |

Then every kind except deps needs CI green. Without a CI result (local preflight, or a repo with no checks) the full suite runs on head instead, with `headReruns` reruns before a failure counts. Checks whose name contains `mergeproof` are ignored, since the gate's own job is still running.

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

In `shadow` mode a `MERGE` verdict is reported but never executed. `off` turns the gate into a constant `HUMAN`, so nothing merges. A PR whose author isn't in `agents.logins` and whose branch doesn't start with one of `agents.branchPrefixes` is not an agent PR and goes to `HUMAN`.

## Config (`.mergeproof.json`)

v1 reads plain JSON, so the gate needs no parser of its own. YAML may come later. Every key is optional. `parseConfig` deep-merges the file over `defaultConfig()` and rejects unknown keys, wrong types and out-of-range numbers, so a typo can never quietly fall back to a default.

```json
{
  "mode": "shadow",
  "testCommand": "npm test",
  "testFileCommand": "node --test",
  "paths": {
    "tests": ["test/**", "tests/**", "**/*.test.*", "**/*.spec.*"],
    "docs": ["docs/**", "**/*.md"],
    "manifests": ["package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"]
  },
  "issueLabels": { "bugfix": ["bug"] },
  "limits": { "maxDiffLines": 300, "testTimeoutSec": 600 },
  "proof": { "baseFailRuns": 2, "headPassRuns": 3, "headReruns": 1 },
  "trust": { "minOutcomes": 10, "minCleanRate": 0.9, "revertWindowDays": 14 },
  "agents": { "logins": [], "branchPrefixes": ["agent/"] },
  "quarantine": []
}
```

- `testCommand` runs the full suite; `testFileCommand` runs one test file, which is appended as its last argument (`npx jest`, `npx vitest run`, `pytest` also work). Both are split on whitespace with no shell quoting.
- Globs: `**` spans directories, `*` and `?` stay inside one segment, and a pattern with no `/` matches the file name at any depth.
- `quarantine`: test files left out of per-file proof runs because they are known to be flaky.

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
- **Feature vs bugfix (resolved for M1).** The linked issue's maintainer label picks the bucket (`issueLabels.bugfix`); without one, it's a feature. M2 must make sure the agent's token can't label issues.
