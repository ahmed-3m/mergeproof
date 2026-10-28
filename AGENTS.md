# AGENTS.md — Development guide for mergeproof

`mergeproof` is a trust gate for AI-agent pull requests. The spec is [PROTOTYPE.md](PROTOTYPE.md) (milestone 1). Milestone 2 is [briefs/m2-autopilot.md](briefs/m2-autopilot.md); do not build M2 features until M1 is done.

## Hard constraints (non-negotiable)

1. **Zero dependencies.** Pure Node.js (>= 18.17) built-ins only, including for tests (`node:test`). If a change needs a package, the change is wrong.
2. **The gate never calls an LLM.** Decisions are plain, deterministic code so the agent being judged cannot influence them.
3. **Kind comes from changed paths only.** Agent-written labels and commit prefixes are only compared against the paths; a mismatch is tampering. The one exception is the maintainer's label on the issue the workflow passes as `--issue` (never the PR's own "closes #N"), which only splits feature from bugfix (same proof, different trust bucket).
8. **The PR never configures its own gate.** Config is read from the base branch tip; agent, model and issue come from the caller's flags, not the PR. Agent PRs are identified by author login (`agents.logins`), never by branch name alone, and fork PRs always go to a human.
4. **Verdict contract is frozen.** `MERGE | RETRY | HUMAN` and the exit codes in `src/verdict.mjs` are what workflows branch on.
5. **Token discipline.** One-line verdict, at most 3 notes, failures first.
6. **Spawn safety.** All child processes go through `src/adapters/process.mjs` (`runProcess`) with argv arrays. Windows `.cmd`/`.bat` shims (npm, npx) need `shell: true` (CVE-2024-27980) and must only receive trusted arguments.
7. **New installs are safe by default.** `mode: shadow` is the default; deps PRs never auto-merge in v1.

## Commands

- Run tests: `npm test` (pins the suite list; don't run `node --test tests/` directly)
- Run the CLI: `node bin/mergeproof.mjs <check|apply|sync> [...]`

## Layout

| Path | Role |
|---|---|
| `bin/mergeproof.mjs` | npm bin entry; loads `src/cli.mjs` |
| `src/cli.mjs` | Command dispatch, usage, exit codes |
| `src/commands/` | `check`, `apply` and `sync` pipelines |
| `src/config.mjs`, `src/glob.mjs` | `.mergeproof.json` defaults, validation and path globs |
| `src/classify.mjs` → `tamper.mjs` → `prove.mjs` → `decide.mjs` | The gate pipeline, in order |
| `src/agents.mjs`, `src/inspect.mjs`, `src/land.mjs`, `src/verdictfile.mjs` | Agent-PR identity, paths → kind + tamper notes (both shared with `apply`), landing a verdict (record, merge, ledger, comment), and the `mergeproof-verdict@1` gate → apply handoff |
| `src/ledger.mjs`, `src/trailer.mjs` | Trust ledger and `Mergeproof-Verdict` merge trailer |
| `src/adapters/` | `process` (child processes), `git` (diffs, worktrees), `gh`, test `runner`, `sandbox` (`--test-user`: tests as another OS user) |
| `tests/structure.test.mjs` | Repo invariants and per-module export contracts |
| `tests/benchmarks.test.mjs`, `tests/fixtures/` | The pre-registered scenarios, run against real git repos |
| `benchmarks/specs.md` | Pre-registered gate scenarios with expected verdicts |
| `demo/` | Demo repo plan and seeded ledger |

## Conventions

- Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `ci:`, `chore:`).
- Update `CHANGELOG.md` under `[Unreleased]` in the same change.
- When a stub is implemented, add tests for it and keep its exported names (the structure suite enforces them).
- Version lives in two places: `package.json` and `src/version.mjs` (test-enforced).
