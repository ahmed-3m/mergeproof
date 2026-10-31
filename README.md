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

**mergeproof decides whether a pull request written by an AI agent is safe to merge without a human.**

It uses plain, deterministic code. It never calls an LLM, so the agent being judged cannot talk its way past it.

## At a glance

- **Verdicts:** `MERGE` (exit 0), `RETRY` (exit 3), `HUMAN` (exit 4). Usage error: 2. Other error: 1.
- **Kinds:** feature, bugfix, refactor, docs, deps. The kind comes from the changed paths only.
- **Safe by default:** new installs run in `shadow` mode (report only, merge nothing).
- **Trust is earned:** per kind, per agent and model, from past outcomes. A revert takes it away.
- **Zero dependencies.** Node.js >= 18.17. MIT. Status: v0.2.0.

## How it works

<p align="center">
  <img src="./assets/readme/pipeline.svg" width="100%" alt="The gate pipeline: classify (the kind comes from the changed paths), tamper (test tampering ends the run), prove (proof runs in fresh worktrees), decide (the trust ledger picks the verdict — MERGE, RETRY or HUMAN; settled outcomes feed back and earn autonomy)">
</p>

1. **Classify.** Read the kind from the changed paths.
2. **Check for tampering.** Any hit sends the PR to a human:
   - edits to the gate (`.mergeproof.json`, `.mergeproof/`, `.github/`)
   - existing tests edited, renamed or deleted, or new skip markers (`.skip`, `.only`, …)
   - edits to agent instructions (`AGENTS.md`, `CLAUDE.md`, …)
   - a label or commit prefix that disagrees with the paths
   - a diff over 300 lines (manifests and lockfiles not counted)
   - unsafe file names, or a suite that runs fewer test cases than before
3. **Prove.** Each kind has its own proof, run in fresh worktrees:

   | Kind | Proof |
   |---|---|
   | feature, bugfix | each new test fails on base (2 runs) and passes on head (3 runs) |
   | refactor | full suite green on base and head; test count does not drop |
   | docs | nothing to run |
   | deps | never merges on its own |

   CI must also be green (except for deps).
4. **Decide.** The first matching rule wins:

   | Situation | Verdict |
   |---|---|
   | tampering, deps, or no kind fits | `HUMAN` |
   | weak proof (e.g. the new test already passes on base) | `RETRY` |
   | impossible proof (suite red on base) | `HUMAN` |
   | touches a `paths.humanOnly` path | `HUMAN` |
   | kind not yet trusted for this agent and model | `HUMAN` |
   | otherwise | `MERGE` |

Full rules: [docs/architecture.md](docs/architecture.md).

## Quick start

Install into your repo (needs a `pull_request` CI workflow and a `scripts.test`):

```bash
npx @ahmed-3m/mergeproof init --model <model> --bot-login <bot>
```

`init` writes `.mergeproof.json` (in `shadow` mode), four workflows and the mergeproof-bugfix and mergeproof-feature skills under `.mergeproof/skills/`. Use `--dry-run` to preview. It never overwrites files without `--force`.

Check one PR by hand:

```bash
npx @ahmed-3m/mergeproof check https://github.com/you/repo/pull/42 --agent claude-code --model glm-5.2 --issue 17
```

```text
Mergeproof — HUMAN (kind: bugfix)
  ✗ edits existing test tests/parser.test.js
  (shadow)
```

The PR counts as a bugfix because issue 17 has the maintainer's `bug` label; without `--issue` it would be a feature. The output is one line plus at most three notes, failures first.

## Commands

| Command | What it does |
|---|---|
| `check <pr-url>` | Gate a PR. In CI, add `--verdict-out <file>` so the read-only job writes nothing to GitHub. Never run it without that flag in a job that holds a write token. |
| `check --local` | Preflight your branch. Agents run this before opening a PR. |
| `apply <verdict-file> --pr <pr-url>` | Land a verdict: merge, comment, record the outcome. Runs no PR code. |
| `sync` | Nightly: settle outcomes and record reverts. |
| `roadmap` | Open one proposed issue per `ready` item in `ROADMAP.md`. A maintainer still labels each `agent`. |
| `retro [--events <file>]` | Summarize agent performance and failure modes from `events.jsonl` (read-only measurement, never a gate decision). |
| `init` | Install mergeproof into the current repo. |
| `dispatch <issue> --harness agy` | Run agy on an issue from your machine ([docs/dispatch.md](docs/dispatch.md)). |
| `loop --harness <name> ...` | Run a coding harness then `check --local` in rounds (agent container only; never the gate). |

Run `mergeproof --help` for every option.

## Configuration

Optional `.mergeproof.json` in the repo root. It is always read from the **base branch**, never from the PR.

| Key | Default | Meaning |
|---|---|---|
| `mode` | `shadow` | `shadow` reports only; `enforce` merges on `MERGE`; `off` always says `HUMAN` and writes nothing. |
| `testCommand` | `npm test` | Runs the full suite. |
| `testFileCommand` | `node --test` | Runs one test file. |
| `paths.tests` | `test/**`, `tests/**`, `**/*.test.*`, … | Globs that find your tests. The proof needs them to match your suite. |
| `agents.logins` | none | Logins of your agent accounts. Until you add one, no PR is gated. |
| `agents.identities` | none | Login → `{ agent, model }`: each agent login gets its own trust bucket, overriding the workflow's flags. |
| `paths.humanOnly` | none | Paths that always need a human, even for a trusted kind. |
| `trust.minOutcomes` | `10` | Settled outcomes a kind needs before it merges on its own. |
| `trust.verifyCommits` | `false` | Count only outcomes whose merge commit is real history of the base branch, so a forged ledger buys no trust. |

Every key and default: [docs/architecture.md](docs/architecture.md#config-mergeproofjson).

**Which PRs are gated:** the author must be in `agents.logins` **and** the branch must start with one of `agents.branchPrefixes` (default `agent/`; an empty list turns this check off). Fork PRs always go to a human.

## Earning trust

A kind merges on its own only after 10 settled outcomes (`trust.minOutcomes`), at least 90% clean (`trust.minCleanRate`), and no revert among its last 10 merges. Human merges of PRs whose proof held count too, so a new install earns trust like this:

1. Run in `shadow` mode and let the agent open PRs.
2. Merge the good ones yourself.
3. After 14 days without a revert, `sync` marks each one clean.
4. Switch to `enforce`. Trusted kinds now merge on their own.

Kill switch: set the `MERGEPROOF_MODE` repository variable to `off` to stop every mergeproof workflow; `mode: "off"` in the config silences the gate itself.

## GitHub Actions

Use the action `ahmed-3m/mergeproof@v1` ([action.yml](action.yml)). Inputs: `command` (`check`, `apply`, `sync`, `roadmap` or `retro`), `args`, `node-version`. Output: `exit-code`. (`loop` is not an action input: the issue workflow runs it in the agent container.)

`init` installs four workflows:

| Workflow | What it does |
|---|---|
| `mergeproof-issue.yml` | An issue from an allowlisted author, or one a writer labels `agent`, runs `mergeproof loop`: up to `MERGEPROOF_ROUNDS` rounds of coding, each self-checked with `check --local`, unproven reasons fed back — then the PR. |
| `mergeproof-pr.yml` | After CI: a read-only gate job, then an apply job. `RETRY` re-runs the agent (up to 3 attempts). |
| `mergeproof-sync.yml` | Nightly ledger sync. |
| `mergeproof-roadmap.yml` | When `ROADMAP.md` changes: opens proposed issues for its `ready` items. |

- **Coding agent:** `MERGEPROOF_HARNESS` picks `claude` (default), `gemini` or `agy`. Each runs in a container with no GitHub credential; a separate job checks its output before anything is pushed.
- **Gate job:** runs the PR's tests as an unprivileged OS user, with no secrets and a read-only token. Only the apply job can write.

Variables, secrets and harness caveats: [templates/README.md](templates/README.md). Job permissions: [SECURITY.md](SECURITY.md#workflow-permissions).

## This repo gates itself

- Runs in `enforce` mode on its own agent PRs.
- Agents: `ahmed-3m` (Claude Code, claude-opus-5-5) and `mergeproof-bot` (Claude Code, claude-sonnet-5-5), each with its own trust bucket.
- The gate runs the action pinned to a commit on `main`, never the PR's code.

## Development

```bash
npm test            # zero dependencies: no install step
npm run test:fast   # dev loop: skips the slow suites (real git fixture repos, workflow renders)
npm run demo        # see demo/README.md
```

| Doc | For |
|---|---|
| [AGENTS.md](AGENTS.md) | Hard constraints and conventions for contributors and agents |
| [docs/architecture.md](docs/architecture.md) | Modules, tamper rules, proof, decision table, config schema |
| [docs/dispatch.md](docs/dispatch.md) | Running agy locally with `dispatch` |
| [templates/README.md](templates/README.md) | Workflows, variables, secrets, agent harnesses |
| [skills/README.md](skills/README.md) | The per-kind agent playbooks and `.mergeproof/lessons.md` |
| [ROADMAP.md](ROADMAP.md) | Planned work, proposed to agents as issues |
| [SECURITY.md](SECURITY.md) | Permissions and reporting a vulnerability |
| [benchmarks/specs.md](benchmarks/specs.md) | Pre-registered gate scenarios |
| [docs/releasing.md](docs/releasing.md), [CHANGELOG.md](CHANGELOG.md) | Releases |

Out of scope for v1, planned for v2: a GitHub App, a hosted service and a dashboard.

## License

MIT © ahmed-3m
