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
| PR code reads credentials | Test runs get an environment with `*TOKEN*`, `*SECRET*`, `*PASSWORD*` and `*API_KEY*` variables removed |
| Shell injection through file names | Changed paths outside `[A-Za-z0-9_@+./-]` (or starting with `-`) are tampering, and the runner refuses them |

## What mergeproof does not do

- No telemetry. Nothing is sent anywhere except the GitHub API calls made through your own `gh` login.
- No model calls. The gate is deterministic code.
- No token handling. GitHub access goes through `gh`; in Actions, tokens stay in the repository's secrets.
