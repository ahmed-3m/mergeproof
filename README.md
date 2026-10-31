<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="mergeproof — a trust gate for AI-agent pull requests with the verdicts MERGE, RETRY and HUMAN, next to a real gate run that refuses a bugfix PR for editing an existing test">
</p>

<p align="center">
  <a href="https://github.com/ahmed-3m/mergeproof/actions/workflows/ci.yml"><img src="https://github.com/ahmed-3m/mergeproof/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@ahmed-3m/mergeproof"><img src="https://img.shields.io/npm/v/@ahmed-3m/mergeproof" alt="npm"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2018.17-339933" alt="Node 18.17 or newer">
  <img src="https://img.shields.io/badge/dependencies-0-3fb950" alt="zero dependencies">
  <img src="https://img.shields.io/badge/gate-LLM--free-58a6ff" alt="the gate never calls an LLM">
</p>

> **Status: v0.2.0.** Shipped: the gate (`check`, `check --local`, `apply`, `sync`), `paths.humanOnly`, `mergeproof init`, the reusable GitHub Action with its workflow templates (Claude Code, Gemini CLI or agy as the coding agent, each in a credential-free container through `mergeproof loop`), `mergeproof roadmap`, and local `dispatch` for agy. Verified against the [pre-registered scenarios](benchmarks/specs.md).

Coding agents (Copilot, Codex, OpenHands, Claude Code with Anthropic or GLM models, Gemini CLI, agy) can already turn an issue into a pull request. The hard part is deciding whether that PR is safe to merge without a human. `mergeproof` makes that decision with plain, deterministic code: zero dependencies, and the gate never calls an LLM, so the agent being judged cannot talk its way past it.

1. **Inspect.** The kind of PR (feature, bugfix, refactor, docs, deps) comes from the changed paths only. Then the diff is checked for tampering:
   - file names outside `[A-Za-z0-9_@+./-]`, or starting with `-`
   - edits to the gate itself: `.mergeproof.json`, `.mergeproof/`, workflow files
   - existing tests edited, renamed or deleted
   - new skip markers (`.skip`, `.only`, `.todo`, `xit`, `@pytest.mark.skip`, …)
   - a kind label or commit prefix that disagrees with the paths
   - a diff over `limits.maxDiffLines` (300; `paths.manifests` such as `package.json` and lockfiles are not counted)
   - edits to agent-instruction files (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`, … including `@path` imports)
   - a refactor whose test-case count drops
2. **Prove.** Each kind has its own proof, run in fresh worktrees:
   - **feature / bugfix:** every new test file fails on base (2 runs) and passes on head (3 runs), each run on its own with `testFileCommand <file>`.
   - **refactor:** the full suite is green on base and on head, and the number of test cases does not drop.
   - **docs:** nothing to run. **deps:** never merges on its own.
   - CI must also be green for every kind except deps (checks named `*mergeproof*` are ignored). With no CI result at all, the gate runs the full suite on head itself; CI still pending after `limits.ciWaitSec` (600 s) is a `HUMAN`.
3. **Decide and learn.** The first rule that matches wins: tampering → `HUMAN`; deps → `HUMAN`; no kind fits → `HUMAN`; weak proof → `RETRY`; impossible proof (the suite is red on base) → `HUMAN`; a kind not yet trusted for this agent and model → `HUMAN`; otherwise → `MERGE`. Trust is earned per kind, per agent and model, from a ledger of past outcomes, and lost on a revert ([decision table](docs/architecture.md#decision-table)).

<p align="center">
  <img src="./assets/readme/pipeline.svg" width="100%" alt="The gate pipeline: classify (the kind comes from the changed paths), tamper (test tampering ends the run), prove (proof runs in fresh worktrees), decide (the trust ledger picks the verdict — MERGE, RETRY or HUMAN; settled outcomes feed back and earn autonomy)">
</p>

| Verdict | Meaning | Exit code |
|---|---|---|
| `MERGE` | proof held and the kind is trusted — merged in `enforce` mode, reported in `shadow` | `0` |
| `RETRY` | proof was weak (e.g. the new test already passes on base) — the agent gets another attempt | `3` |
| `HUMAN` | tampering, an untrusted kind, or impossible proof — a human takes over | `4` |

Usage errors exit `2`, other errors `1`. Workflows branch on these codes, and they do not change.

## Usage

In CI the gate is split across two jobs ([`templates/workflows/mergeproof-pr.yml`](templates/workflows/mergeproof-pr.yml), installed by `mergeproof init`). The gate job runs the PR's untrusted tests with a read-only token and no secrets, and writes `verdict.json`. The apply job never runs PR code: it re-derives everything except the proof result and is the only job with write permissions.

```bash
# gate job (read-only): --head pins the commit whose CI completed
npx @ahmed-3m/mergeproof check <pr-url> --head <sha> --verdict-out verdict.json --test-user mergeproof-tests
# apply job (write): merges, comments, records the outcome, labels needs-human on HUMAN
npx @ahmed-3m/mergeproof apply verdict.json --pr <pr-url> --head <sha> --agent <name> --model <name>
# agents run this before opening a PR
npx @ahmed-3m/mergeproof check --local
# nightly: settle the ledger, record reverts
npx @ahmed-3m/mergeproof sync
# open agent-proposed issues for ready ROADMAP.md items (a maintainer still labels each `agent`)
npx @ahmed-3m/mergeproof roadmap
```

For a local or manual run, `check` without `--verdict-out` does everything in one process. Never run it that way in a CI job that holds a write token: it runs the PR's test code in the same process.

```bash
npx @ahmed-3m/mergeproof check https://github.com/you/repo/pull/42 --agent claude-code --model glm-5.2 --issue 17
```

```text
Mergeproof — HUMAN (kind: bugfix)
  ✗ edits existing test tests/parser.test.js
  (shadow)
```

The verdict is one line plus at most three notes, failures first. `--issue <n>` is the issue the agent was dispatched for: a maintainer `bug` label on it (`issueLabels.bugfix`) makes the PR a bugfix, otherwise it is a feature. Same proof, different trust bucket.

Only agent PRs are gated: the author must be in `agents.logins` **and** the branch must match `agents.branchPrefixes` (default `agent/`). Anyone can name a branch `agent/...`, so the branch alone never counts. Fork PRs always go to a human.

### Commands

| Command | What it does |
|---|---|
| `check <pr-url>` | Gate a pull request. `--verdict-out <file>` writes the verdict for an apply job and nothing to GitHub; `--head <sha>` pins the head whose CI completed (a PR that has moved since stands down for its own new run); `--test-user <name>` runs the PR's tests as an unprivileged OS user (sudo; Linux/macOS). |
| `check --local [--base <ref>]` | Preflight `HEAD` against its base. Agents run this before they open a PR. |
| `apply <verdict-file> --pr <pr-url>` | Land a gate verdict: merge, comment, ledger, labels. Requires `--agent` and `--model`; runs no PR code. |
| `sync [--ref <ref>]` | Settle outcomes in the ledger and record reverts (default `--ref HEAD`). |
| `init` | Install mergeproof into the current repo ([Install](#install)). |
| `dispatch <issue> --harness agy` | Run a local coding agent on an issue from a maintainer's machine ([Local agent: agy](#local-agent-agy)). |

Common options: `--agent <name> --model <name>` (the trust bucket, set by the workflow and never by the PR), `--issue <n>`, `--skill <name> --attempt <n>` (logged with the outcome; apply must get the gate job's values), `--ledger <path>` (default `.mergeproof/ledger.json`), `--dry-run`, `--json`. `mergeproof --help` lists everything.

### Configuration

An optional `.mergeproof.json` in the repo root. It is always read from the **base branch tip**, never from the PR, and unknown keys are rejected.

| Key | Default | Meaning |
|---|---|---|
| `mode` | `"shadow"` | `shadow` reports verdicts and merges nothing; `enforce` merges on `MERGE`. |
| `testCommand` | `"npm test"` | Full suite. Split on whitespace, no shell quoting. |
| `testFileCommand` | `"node --test"` | Runs one test file, appended as the last argument. |
| `paths.tests`, `paths.testSupport`, `paths.docs`, `paths.manifests`, `paths.agentInstructions` | see [architecture](docs/architecture.md#config-mergeproofjson) | Globs that decide the kind and the tamper rules. |
| `issueLabels.bugfix` | `["bug"]` | Maintainer labels on the `--issue` that make a PR a bugfix. |
| `limits` | `maxDiffLines: 300`, `testTimeoutSec: 600`, `ciWaitSec: 600` | Diff size cap, per-run test timeout, how long to wait for pending CI (`0` turns the wait off). |
| `proof` | `baseFailRuns: 2`, `headPassRuns: 3`, `headReruns: 1` | How many times a new test must fail on base and pass on head; full-suite reruns when there is no CI result. |
| `trust` | `minOutcomes: 10`, `minCleanRate: 0.9`, `revertWindowDays: 14` | What a kind needs before it merges on its own ([Cold start & trust](#cold-start--trust)). |
| `agents` | `logins: []`, `branchPrefixes: ["agent/"]`, `identities: {}` | Who counts as an agent. `identities` maps a login to `{ "agent", "model" }`; every login there must also be in `logins`. |
| `quarantine` | `[]` | Test files known to be flaky, left out of per-file proof runs. |

The full schema, the tamper rules and the proof per kind are in [docs/architecture.md](docs/architecture.md#config-mergeproofjson).

## Install

```bash
read -rs MERGEPROOF_MODEL_KEY && export MERGEPROOF_MODEL_KEY   # optional: when set, init stores it as a repo secret
read -rs MERGEPROOF_BOT_TOKEN && export MERGEPROOF_BOT_TOKEN   # optional: same (read -s keeps both out of shell history)
npx @ahmed-3m/mergeproof init --model <m> --bot-login <bot>
```

Run `init` inside your repository: a git repo with a `pull_request` CI workflow and a `scripts.test`. It detects the install command (from the lockfile), the test command, the test paths and the CI workflow; override any of them with `--install-command`, `--test-command` or `--ci-workflow`. It then writes:

- `.mergeproof.json`, always with `mode: shadow`
- the four workflow templates from [`templates/workflows/`](templates/README.md), placeholders filled
- the bugfix and feature skills under `.mergeproof/skills/` (see [skills/](skills/README.md))

Existing files are never silently replaced (use `--force`), `--dry-run` prints the full plan without writing, and re-runs are idempotent.

On GitHub, `init` creates the `agent`, `agent:urgent` and `needs-human` labels (a writer adding `agent` or `agent:urgent` to an issue starts the coding agent on it) and sets the `MERGEPROOF_AGENT`, `MERGEPROOF_MODEL` and `MERGEPROOF_BOT_LOGIN` repository variables, plus `MERGEPROOF_MODEL_BASE_URL` (`--base-url`, defaulted for `glm-*` models). It pushes `MERGEPROOF_MODEL_KEY` and `MERGEPROOF_BOT_TOKEN` as secrets, read from the environment variables of the same name and passed to `gh secret set` on stdin, never in argv or logs; when one is unset, init prints the exact `gh secret set` command to run yourself.

Remote changes need `--yes` (or an interactive `y`). Every run ends with a read-only check of branch protection, the bot's permission and the token guidance; init never changes protection settings itself. Branch protection and rulesets on a private repo need GitHub Pro, Team or Enterprise. Without them init reports those checks as `unknown`, and nothing stops the bot user from merging its own PR.

To stop every mergeproof workflow at once, set the `MERGEPROOF_MODE` repository variable to `off`. It is only a kill switch: shadow vs enforce lives in `.mergeproof.json`.

## Cold start & trust

The gate does nothing until it is configured: with an empty `agents.logins`, no PR counts as an agent PR, so nothing is gated (and fork PRs still go to a human).

Trust is earned per task kind and per agent + model. `MERGE` needs at least `trust.minOutcomes` (default 10) settled outcomes, at least `trust.minCleanRate` (default 90%) of them clean, and no revert in the recent window. Until then every proven PR gets `HUMAN`. **Human merges of proven PRs still count toward trust**, which is how a new install earns autonomy:

1. Run in `shadow` mode and let the agent open PRs.
2. Merge the good ones yourself.
3. After `trust.revertWindowDays` (14 days) without a revert, `sync` settles each outcome as clean.
4. Once a kind has enough clean outcomes, switch to `enforce` and the gate merges that kind on its own.

A low-volume repo can lower `minOutcomes` in its own `.mergeproof.json`, with eyes open: fewer outcomes is weaker evidence. Never seed a real ledger from `demo/ledger.json`; those outcomes did not happen.

## Local agent: agy

The Antigravity CLI (`agy`) can be a second coding agent, run from your own machine. Give it a machine account of its own (not your login), list it in `.mergeproof.json` on the default branch, and give it its own trust bucket:

```json
"agents": {
  "logins": ["my-claude-bot", "my-agy-bot"],
  "identities": { "my-agy-bot": { "agent": "agy", "model": "gemini-4-argon-high" } }
}
```

Create a fine-grained PAT for that account on this one repository with `contents: write` and `pull-requests: write`. Then, in a clone of the repo with `gh` signed in as yourself and `agy` signed in:

```bash
read -rs MERGEPROOF_DISPATCH_TOKEN && export MERGEPROOF_DISPATCH_TOKEN
npx @ahmed-3m/mergeproof dispatch 17 --harness agy --dry-run   # prints the plan and the issue file
npx @ahmed-3m/mergeproof dispatch 17 --harness agy
```

`dispatch` reads the issue once and writes the same trusted issue file the issue workflow builds (comments are kept only from trusted authors). When the issue's author is not trusted (not in `MERGEPROOF_AUTHORS`, not a write/maintain/admin collaborator), it stops until you have read that file from `--dry-run` and re-run with the `--vouch <digest>` it prints. The digest covers the exact file you read, so an edit made after you read it is refused.

It then runs `agy -p` with `--dangerously-skip-permissions` in a throwaway worktree on a new `agent/issue-17` branch. Headless agy denies file writes without that flag, which is why it never runs in your checkout. The token reaches agy's environment only, as `GH_TOKEN`; your other tokens and keys are removed from it. agy pushes and opens the PR as the agy account, and the PR workflow gates it like any agent PR, in the agy bucket. The worktree is removed when agy exits 0 and kept for inspection when it fails.

The worktree keeps agy out of your checkout, but it is not a sandbox: agy runs as your OS user, with its permission prompts off, and can read whatever you can, including SSH keys and your own `gh` login. Run `dispatch` under a dedicated OS user, or in a VM or container that holds only the clone, agy's login and the token, whenever the issue text is not yours.

Limits: a dispatched PR has no dispatch marker, so the gate gets no `--issue` (every agy PR lands in the feature bucket, with no bugfix split) and a `RETRY` does not start agy again: run `dispatch` again or fix the PR by hand.

## GitHub Actions

[`action.yml`](action.yml) is the reusable composite action `ahmed-3m/mergeproof@v1`. It sets up Node and runs the CLI; there is no install step.

| Input | Default | Meaning |
|---|---|---|
| `command` | (required) | `check`, `apply`, `sync` or `roadmap`; anything else exits `2`. |
| `args` | `''` | Arguments for the command. They arrive through the environment and are split on whitespace with no shell expansion, globbing or quoting. |
| `node-version` | `'22'` | Node.js version to set up (>= 18.17). |

The `exit-code` output carries the CLI's exit code. A `RETRY` or `HUMAN` fails the step, so mark it `continue-on-error` and branch on the output instead, as the PR template does:

```yaml
- id: gate
  continue-on-error: true
  uses: ahmed-3m/mergeproof@v1
  env:
    GH_TOKEN: ${{ github.token }}
  with:
    command: check
    args: >-
      ${{ needs.context.outputs.pr-url }}
      --head ${{ needs.context.outputs.head-sha }}
      --verdict-out ${{ runner.temp }}/verdict.json
      --test-user mergeproof-tests
      --agent ${{ needs.context.outputs.agent }}
      --model ${{ needs.context.outputs.model }}
- name: Fail on the gate's own errors (exit 1 or 2)
  if: steps.gate.outputs.exit-code != '0' && steps.gate.outputs.exit-code != '3' && steps.gate.outputs.exit-code != '4'
  run: exit 1
```

(Trimmed from the template, which also passes the skill, attempt, issue and ledger path.)

[`templates/workflows/`](templates/README.md) holds the four workflows `init` installs:

| Workflow | Flow | What it does |
|---|---|---|
| `mergeproof-issue.yml` | issue → PR | An issue from an allowlisted author, or one a writer labels `agent`, starts the coding agent with the skill for its kind. |
| `mergeproof-pr.yml` | PR → outcome | After the repo's CI completes on a PR: the read-only gate job, then the apply job. On `RETRY` it re-dispatches the agent while attempts remain (up to 3, when the issue is known); otherwise it labels `needs-human`. |
| `mergeproof-sync.yml` | nightly | Settles the ledger and opens a triage issue for each newly reverted merge. |
| `mergeproof-roadmap.yml` | ROADMAP.md → issues | On a push that changes `ROADMAP.md` (or on dispatch), opens one `agent-proposed` issue per `ready` item, never twice. The issues start nothing until a writer labels them `agent`. |

The apply job and the nightly sync share the `mergeproof-ledger` concurrency group, so ledger writes never overlap. GitHub keeps at most one pending run per group, so a PR can occasionally get no verdict from a cycle; re-run it with:

```bash
gh workflow run mergeproof-pr.yml -f pr=<number>
```

The issue workflow's coding agent is picked by the `MERGEPROOF_HARNESS` repository variable: `claude` (default, Claude Code with `CLAUDE_CODE_OAUTH_TOKEN` or `MERGEPROOF_MODEL_KEY`), `gemini` (Gemini CLI) or `agy` (the Antigravity CLI; put a Gemini API key in `MERGEPROOF_MODEL_KEY`). Every harness runs the same way, through `mergeproof loop`, split across three jobs so the agent never shares a runner with a GitHub credential:

- **`agent`** (trusted context, no secret) prepares the issue and skill files.
- **`agent-run`** runs the harness in a credential-free container pinned by digest (`MERGEPROOF_AGENT_IMAGE`; `MERGEPROOF_AGY_IMAGE` still works), installed from one release checked by SHA-512. The model credential is passed only to its run step.
- **`agent-publish`** runs on a fresh runner, validates the result as untrusted data (refusing edits to agent-instruction files) and only then pushes with the bot token.

[Read the harness notes](templates/README.md#the-agent-harness-mergeproof_harness) for the supply-chain and deny-list caveats before switching.

Placeholders, repository variables and secrets are documented in [templates/README.md](templates/README.md), and every job's permissions in [SECURITY.md](SECURITY.md#workflow-permissions).

## This repo gates itself

Mergeproof runs on its own agent PRs, in `enforce` mode ([`.mergeproof.json`](.mergeproof.json), [`.github/workflows/`](.github/workflows/)):

- Agents are `ahmed-3m` (Claude Code, `claude-opus-5-5`) and `mergeproof-bot` (Gemini CLI, `gemini-3-flash-preview`), each in its own trust bucket via `agents.identities`. A PR is gated only when its author is one of them and its branch starts with `agent/`.
- The gate runs the action pinned to a commit on `main`, never `@v1` and never the PR's code.
- `skills/**` counts as agent instructions here, so an agent PR that edits a skill goes to a human.
- The issue workflow runs the `gemini` harness (Gemini CLI 0.64.0 from the npm tarball, checked against its integrity hash, with `MERGEPROOF_AGENT=gemini-cli`) or `agy`, on the same three-job split. A promotion PR switches it to `claude` once the release that runs Claude Code in the container is out.

Until a kind has earned trust, every verdict here is `HUMAN` too.

## Roadmap

| Milestone | Scope | Status | Spec |
|---|---|---|---|
| **M1: core CLI** | `check`, `check --local`, `sync`, config, ledger, trailer | shipped | [PROTOTYPE.md](PROTOTYPE.md) |
| **M2: autopilot package** | `mergeproof init`, reusable GitHub Action, issue → skill-guided agent → PR → gate, same-PR retries, shadow mode | shipped (v0.1.x) | [briefs/m2-autopilot.md](briefs/m2-autopilot.md) |
| **M3: self-development loop** | `mergeproof loop` in a credential-free container, `paths.humanOnly`, multi-ecosystem defaults, `ROADMAP.md` → proposed issues, promotion from a release | in progress (v0.2.x) | [briefs/m3-self-loop.md](briefs/m3-self-loop.md) |
| v2 | GitHub App, hosted dashboard, org policies | planned | — |

## Development

```bash
node --version   # >= 18.17
npm test         # no install step, ever: zero dependencies
npm run demo     # see demo/README.md
```

- [AGENTS.md](AGENTS.md): hard constraints and conventions
- [docs/architecture.md](docs/architecture.md): module map, tamper rules, proof per kind, decision table
- [benchmarks/specs.md](benchmarks/specs.md): the pre-registered gate scenarios
- [docs/releasing.md](docs/releasing.md): cutting a release; [CHANGELOG.md](CHANGELOG.md)
- [SECURITY.md](SECURITY.md#reporting-a-vulnerability): reporting a vulnerability

## License

MIT © ahmed-3m
