# mergeproof

**Let AI agents merge, only with proof.**

> Status: pre-alpha. The M1 gate (`check`, `check --local`, `sync`) is built and tested against the [pre-registered scenarios](benchmarks/specs.md); not published to npm yet. See [PROTOTYPE.md](PROTOTYPE.md) for the spec.

Coding agents (Copilot, Codex, OpenHands, Claude Code, GLM through Claude Code) can already turn an issue into a pull request. The hard part is deciding whether that PR is safe to merge without a human. `mergeproof` is a zero-dependency, LLM-free gate that makes that decision:

1. **Inspect.** Flags test tampering: edited or deleted tests, new skip markers, edits to the gate config or workflows, labels that disagree with the changed paths, oversized diffs.
2. **Prove.** Requires proof that fits the task kind. Feature and bugfix PRs need new tests that fail on base and pass on head. Refactor PRs must leave tests untouched and pass on both. Docs and deps PRs must stay within their paths.
3. **Decide and learn.** Returns `MERGE`, `RETRY` or `HUMAN`. Autonomy is earned per task kind and per agent from a ledger of past outcomes, and lost on a revert.

## Usage

A workflow calls the gate on the agent's pull request; agents preflight locally before opening one:

```bash
npx @ahmed-3m/mergeproof check https://github.com/you/repo/pull/42 --agent claude-code --model glm-5.2 --issue 17
npx @ahmed-3m/mergeproof check <pr-url> --verdict-out verdict.json   # read-only gate job; a separate write job runs:
npx @ahmed-3m/mergeproof apply verdict.json --pr <pr-url> --agent <name> --model <name>  # lands the verdict, labels needs-human on HUMAN
npx @ahmed-3m/mergeproof check --local      # preflight, run by agents before opening a PR
npx @ahmed-3m/mergeproof sync               # settle the ledger, record reverts
```

`--issue <n>` is the issue the agent was dispatched for: a maintainer `bug` label on it makes the PR a bugfix (otherwise a feature). Only PRs by an author listed in `agents.logins` in `.mergeproof.json`, on a branch matching `agents.branchPrefixes`, are gated — anyone can name a branch `agent/...`, and fork PRs always go to a human.

```text
Mergeproof — HUMAN (kind: bugfix)
  ✗ edits existing test tests/parser.test.js
  (shadow)
```

Configure it with an optional `.mergeproof.json` in the repo root (read from the base branch, never the PR); see [docs/architecture.md](docs/architecture.md#config-mergeproofjson). New installs run in `shadow` mode: verdicts are reported, nothing is merged.

Exit codes: `0` MERGE, `3` RETRY, `4` HUMAN, `2` usage error, `1` other error.

## GitHub Actions

This repo's [`action.yml`](action.yml) is the reusable `ahmed-3m/mergeproof@v1` composite action (`check` | `apply` | `sync`), and [`templates/workflows/`](templates/README.md) ships the three workflow templates — issue to agent PR, PR to gate + apply, nightly ledger sync. `mergeproof init` (M2) copies them into your repo and fills their placeholders; the placeholders, repo variables and secrets are documented in [`templates/README.md`](templates/README.md), and every job's permissions in [SECURITY.md](SECURITY.md#workflow-permissions).

## Roadmap

| Milestone | Scope | Spec |
|---|---|---|
| **M1: core CLI** | `check`, `check --local`, `sync`, config, ledger, trailer | [PROTOTYPE.md](PROTOTYPE.md) |
| **M2: autopilot package** | `mergeproof init`, reusable GitHub Action, issue → skill-guided agent → PR → gate, same-PR retries, shadow mode | [briefs/m2-autopilot.md](briefs/m2-autopilot.md) |
| v2 | GitHub App, hosted dashboard, org policies | — |

## Development

```bash
node --version   # >= 18.17
npm test         # no install step, ever: zero dependencies
```

See [AGENTS.md](AGENTS.md) for architecture and hard constraints, and [docs/architecture.md](docs/architecture.md) for the module map.

## License

MIT © ahmed-3m
