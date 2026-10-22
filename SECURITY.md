# Security

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository rather than a public issue.

## Threat model (draft, kept current as features land)

mergeproof decides whether code written by an AI agent may be merged, so it treats every PR as untrusted input.

| Threat | Mitigation |
|---|---|
| Agent edits or deletes tests to get a green run | Tamper rules block it with a `HUMAN` verdict; no retry |
| A refactor makes test cases disappear without touching a test file (e.g. deletes entries of a list the tests generate their cases from) | Refactor proof counts test cases on base and head; fewer on head is the `testCountDropped` tamper rule (`HUMAN`, nothing logged) |
| New tests that prove nothing | Feature and bugfix tests must fail on base and pass on head |
| Agent mislabels a PR to reach a trusted kind | Kind comes from changed paths only; label mismatch is tampering |
| Compromised dependency passes every test | Deps PRs never auto-merge in v1 |
| Running PR code with secrets | Test steps run with no secrets and a read-only token; only the merge step can write (M2 workflows) |
| Prompt injection through issues | Only allowlisted authors or maintainer labels start an agent; bot-written issues never do (M2) |
| Flaky tests faking proof | Repeat runs on base and head; quarantine list in config |
| PR loosens its own gate | Config is read from the base branch tip, not the PR or an older merge-base; edits to `.mergeproof.json`, `.mergeproof/**` or `.github/**` are tampering |
| PR claims a trusted agent or model | Agent and model come from the caller's `--agent`/`--model` flags, never from the PR |
| Human or fork PR posing as an agent | An agent PR needs an author in `agents.logins`; a branch named `agent/...` alone is not enough, and fork PRs always go to a human |
| PR points "closes #N" at a labeled issue to pick a trust bucket | The bucket comes only from the `--issue` the workflow passes; the PR's issue links are ignored |
| PR test code plants a git hook, fsmonitor or filter, or rewrites the ledger | Git runs with hooks and fsmonitor off; `.git/config`, `hooks/`, `info/` and the ledger are fingerprinted around the proof, and any change is `HUMAN` with nothing logged. Test steps still run PR code: run the gate in a job with no secrets and `persist-credentials: false` |
| Push after the proof | The merge is pinned to the proven commit (`--match-head-commit`) |
| PR test code rewrites the verdict file after the gate writes it, so every field in it is attacker-controlled | The file is trusted for one fact only — that the proof held. `apply` re-derives kind and the tamper rules from the fetched diff (the same `inspect()` the gate uses), re-decides with the apply job's own ledger and a fresh CI read, takes the PR from its own `--pr` flag (a file naming another PR is refused, so a proof never transfers between PRs), requires its `--agent`/`--model`/`--skill`/`--attempt`/`--issue` flags to match the file, re-checks PR state, head SHA and agent identity, and pins the merge to the gated head SHA. A closed/moved/non-agent PR is refused with nothing written; a file that disagrees with any re-check is refused with `HUMAN`, commented and labeled `needs-human`, with nothing merged or logged; a MERGE can only be lowered (red CI → RETRY), never raised. Note text from the file is validated (≤ 3 notes, ≤ 300 chars, no newlines/backticks/control characters) and never posted |
| PR code reads credentials | Test runs get an environment with `*TOKEN*`, `*SECRET*`, `*PASSWORD*` and `*API_KEY*` variables removed |
| Shell injection through file names | Changed paths outside `[A-Za-z0-9_@+./-]` (or starting with `-`) are tampering, and the runner refuses them |
| The PR edits the gate workflow so a weaker copy gates its own CI | The PR workflow triggers on `workflow_run`, which always runs the default-branch definition — the PR's edited copy never executes; editing `.github/**` is a tamper rule anyway (`HUMAN`, no retry) |
| A push lands after the CI run that triggered the gate, so the gate judges (and apply merges) a commit the repo's CI never covered | The workflow passes `--head <sha>` (the head whose CI completed) to both jobs; `check` stands down with `HUMAN` and no proof runs when the live head differs, and its verdict file names the CI'd commit so `apply`'s moved-head check refuses it with nothing written. The push's own CI fires a fresh gate run |
| The agent forges its own dispatch context (issue number, skill, attempt) on the PR | The PR workflow reads only comments authored by `github-actions[bot]` — the dispatch marker for issue/skill, `Mergeproof — RETRY` comments for the attempt count — and ignores every other author; agent and model come from repo variables, never the PR |

## Workflow permissions

Every job of every template (`templates/workflows/`), what it may do, which secrets it sees, and whether it runs PR code. Top-level permissions are `mergeproof-pr.yml`'s `permissions: {}`; each job declares only what it needs, and every job checks the `MERGEPROOF_MODE != 'off'` kill switch first.

| Workflow | Job | Permissions | Secrets it sees | Runs PR code |
|---|---|---|---|---|
| `mergeproof-pr.yml` | `context` | `pull-requests: read`, `issues: read` | none | no |
| `mergeproof-pr.yml` | `gate` | `contents: read`, `pull-requests: read`, `checks: read`, `issues: read`; `persist-credentials: false` | none | **yes** — the proof worktrees execute the PR's tests; read-only `github.token`, no write permission, no secrets |
| `mergeproof-pr.yml` | `apply` | `contents: write`, `pull-requests: write`, `issues: write`, `checks: read`, `actions: write` | `MERGEPROOF_BOT_TOKEN` (as `GH_TOKEN`, so the merge commit triggers the push CI; the ledger push uses `github.token`) | no — never installs, never checks out the PR |
| `mergeproof-issue.yml` | `agent` | `contents: read`, `issues: write`, `pull-requests: write`, `actions: read`; `persist-credentials: false` | `MERGEPROOF_MODEL_KEY`, `MERGEPROOF_BOT_TOKEN` (both only inside the agent step) | no — runs the agent on the default branch; PR code belongs to the agent, not an untrusted author |
| `mergeproof-sync.yml` | `sync` | `contents: write`, `issues: write`, `pull-requests: read` | none (`github.token` only) | no |


## What mergeproof does not do

- No telemetry. Nothing is sent anywhere except the GitHub API calls made through your own `gh` login.
- No model calls. The gate is deterministic code.
- No token handling. GitHub access goes through `gh`; in Actions, tokens stay in the repository's secrets.
