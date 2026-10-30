# Workflow templates (M2)

The four templates `mergeproof init` copies into a customer's
`.github/workflows/`, already wired to the reusable action
`ahmed-3m/mergeproof@v1` (this repo's `action.yml`):

| Template | Flow | What it does |
|---|---|---|
| `mergeproof-pr.yml` | PR → outcome | After the repo's CI completes on a PR: a `context` job resolves the PR, the dispatch marker and the attempt count; a read-only `gate` job runs `check --verdict-out --test-user mergeproof-tests` (it runs PR code, so it gets no secrets and a read-only token, and the PR's tests run as an unprivileged OS user whose leftover processes are killed before the verdict is written); the `apply` job runs `apply` (writes only here), pushes the ledger, re-dispatches the agent on RETRY while attempts remain, or labels `needs-human` when they are exhausted. |
| `mergeproof-issue.yml` | issue → PR | An issue opened by an allowlisted author or labeled `agent` by a write-capable collaborator starts the coding agent with the skill for the issue's kind, then posts the dispatch-marker comment (`github-actions[bot]` authored) that the PR workflow reads back. The agent never reads the issue from GitHub: the context step builds a trusted issue file — title and body from the author when trusted (or, for a label start, while the title and body are unedited since the label vouched), comments only from trusted authors, plus the gate's latest PR verdict on a retry — and that file is the agent's only issue text; the prompt forbids fetching issues, PRs, comments or web pages. The coding agent (claude by default, or gemini or agy) runs through `mergeproof loop` in a credential-free container, and a separate `agent-publish` job validates its output before anything is pushed; see [The agent harness](#the-agent-harness-mergeproof_harness). An issue opened by `github-actions[bot]` never starts the agent by itself, only a writer's `agent` or `agent:urgent` label does. |
| `mergeproof-sync.yml` | nightly | `sync` settles the ledger and opens a human-triage issue for each newly reverted merge. |
| `mergeproof-roadmap.yml` | ROADMAP.md → issues | A push to the default branch that changes `ROADMAP.md` (or a dispatch) runs `mergeproof roadmap`: one issue per `ready` item, labeled `agent-proposed` (plus `bug` for a bugfix), deduplicated by the `mergeproof-roadmap` marker comment against open and closed issues so an item is proposed once, ever. At most 5 issues per run (`--limit`); existing issues are never edited or closed, and nothing starts until a maintainer adds the `agent` label to an issue. |


> **Concurrency:** the apply job and the nightly sync share the
> `mergeproof-ledger` concurrency group (`cancel-in-progress: false`), so
> ledger writes never overlap and a text rebase never has to merge two
> concurrent appends. GitHub keeps at most one pending run per group: when a
> third run arrives while one is running and one is queued, the queued one is
> dropped — that PR simply gets no verdict from this cycle. Re-run it with
> `gh workflow run mergeproof-pr.yml -f pr=<number>` (or the workflow's
> *Run workflow* dialog); nothing is lost, the dropped run wrote nothing.

`mergeproof init` fills in the placeholders and creates the `agent` and
`needs-human` labels. It never creates the `mergeproof-ledger` branch: the PR
workflow starts it as an orphan on its first write, so a fresh install simply
does not have one yet. Every job of every workflow checks the
`MERGEPROOF_MODE != 'off'` kill switch first; shadow vs
enforce lives in `.mergeproof.json`, not in this variable.

## Placeholders (filled by `mergeproof init`)

| Placeholder | In | Becomes |
|---|---|---|
| `{{CI_WORKFLOW}}` | `mergeproof-pr.yml` | The `name:` of the customer's CI workflow, whose completion on a PR triggers the gate. |
| `{{INSTALL_COMMAND}}` | `mergeproof-pr.yml`, `mergeproof-issue.yml` | The command that installs dependencies before tests run (e.g. `npm ci`); `:` or `echo` for repos with no install step. In the PR workflow only the gate job runs it (the apply job never installs anything); in the issue workflow it runs inside the agent's container before the agent starts. |

## Repository variables (Settings → Secrets and variables → Actions → Variables)

| Variable | Default | Who sets it | Meaning |
|---|---|---|---|
| `MERGEPROOF_MODE` | unset (runs) | Maintainer | **Kill switch only.** Set to `off` and every mergeproof workflow stops before doing anything. Shadow vs enforce mode is configured per repo in `.mergeproof.json`. |
| `MERGEPROOF_AGENT` | none | `mergeproof init` | Agent name for the trust bucket (`--agent`), e.g. `claude-code`. Never read from the PR. A PR whose author has an entry in `agents.identities` (base-branch `.mergeproof.json`) uses that entry's agent and model instead. |
| `MERGEPROOF_MODEL` | none | `mergeproof init` | Model name for the trust bucket (`--model` and the agent's `--model` arg), e.g. `glm-4.7`. |
| `MERGEPROOF_MODEL_BASE_URL` | unset | `mergeproof init` | Anthropic-compatible endpoint the claude harness talks to (as `ANTHROPIC_BASE_URL`, only together with `MERGEPROOF_MODEL_KEY`, never with the subscription token); `https://api.z.ai/api/anthropic` for GLM. Leave unset for Anthropic's own API. |
| `MERGEPROOF_AUTHORS` | empty | Maintainer | Comma-separated logins whose newly opened issues start the agent, e.g. `alice,bob`. Empty means only the `agent` or `agent:urgent` label (or a dispatch) starts runs. |
| `MERGEPROOF_BUGFIX_LABELS` | `bug` | Maintainer | Comma-separated issue labels that make the run a bugfix; every other issue is a feature. |
| `MERGEPROOF_DAILY_LIMIT` | `10` | Maintainer | Maximum runs of `mergeproof-issue.yml` per UTC day, this run included. Over the cap: a comment on the issue and a clean stop. |
| `MERGEPROOF_BOT_LOGIN` | none | `mergeproof init` | Login of the bot user whose token opens agent PRs; the issue workflow looks for its PRs on `agent/<kind>-<issue>-*` branches. |
| `MERGEPROOF_HARNESS` | `claude` | Maintainer | Which coding agent the issue workflow runs: `claude` (Claude Code), `gemini` (Gemini CLI) or `agy` (the Antigravity CLI). Each runs headless in the same credential-free container. `agy` also needs `MERGEPROOF_AGENT=agy`, so its PRs land in their own trust bucket; any other value stops the run. See [The agent harness](#the-agent-harness-mergeproof_harness). |
| `MERGEPROOF_ROUNDS` | `1` | Maintainer | How many times the agent loop may run the harness (1, 2 or 3). After each round `mergeproof loop` asks the gate's own `check --local` whether the change is proven and, if not, feeds the reasons back for another round. The job's 50 minutes are shared between the rounds. |
| `MERGEPROOF_AGENT_IMAGE` | `node:22-trixie@sha256:…` (pinned) | Maintainer | Container image the harness runs in (`MERGEPROOF_AGY_IMAGE` still works as the older name). It needs node and git (the repo's tests and `mergeproof check --local` run in it); set another image when your tests need more. Must be pinned by digest (`<image>@sha256:<64 hex>`) or the run stops. |
| `MERGEPROOF_CLAUDE_URL`, `MERGEPROOF_CLAUDE_SHA512` | the pinned Claude Code npm tarball | Maintainer | The release the claude harness installs and the SHA-512 (npm integrity, base64) it must match. Change them only together. |
| `MERGEPROOF_GEMINI_URL`, `MERGEPROOF_GEMINI_SHA512` | the pinned Gemini CLI npm tarball | Maintainer | The same for the gemini harness. |
| `MERGEPROOF_AGY_URL`, `MERGEPROOF_AGY_SHA512` | the pinned 1.4.6 tarball | Maintainer | The same for the agy harness (SHA-512 as hex). |

## Secrets (Settings → Secrets and variables → Actions → Secrets)

| Secret | Who sets it | Meaning |
|---|---|---|
| `MERGEPROOF_MODEL_KEY` | `mergeproof init` | API key for the model provider. The claude harness gets it as `ANTHROPIC_API_KEY` (only when `CLAUDE_CODE_OAUTH_TOKEN` is not set); gemini and agy get it as `GEMINI_API_KEY`. It reaches the run step of the `agent-run` job only, passed to the container by name. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Maintainer | Optional Claude subscription token for the claude harness; when set it is used instead of `MERGEPROOF_MODEL_KEY` and the base URL. Same scope as the model key: the run step only. |
| `MERGEPROOF_BOT_TOKEN` | `mergeproof init` | PAT of the bot user that pushes and opens agent PRs, so they trigger CI. Only the `agent-publish` job holds it (the push and stop-comment steps), and that job never runs agent code. Make it a fine-grained PAT for this one repository with `contents: write` and `pull-requests: write` only. The apply job never sees it: it lands with the job's `github.token`, whose comments are `github-actions[bot]`-authored (the attempt count and the agent's retry prompt read only those) and whose merges branch protection already allows — the accepted trade-off is that a mergeproof merge does not itself trigger the repo's push workflows (the gate pinned the merged head's CI instead). |

The gate job sees no secret at all; see [SECURITY.md](../SECURITY.md) for the
full per-job permission table.

## The agent harness (`MERGEPROOF_HARNESS`)

The issue workflow runs one of three coding agents with the same prompt, the
same trusted issue file and the same job split, so the agent never shares a
runner (or an environment) with a GitHub credential. `claude` is the default.
Set `MERGEPROOF_HARNESS=gemini` or `agy` together with `MERGEPROOF_AGENT` and
`MERGEPROOF_MODEL` for that agent's trust bucket (`agy` requires
`MERGEPROOF_AGENT=agy`; any other harness name stops the run) and a matching
`MERGEPROOF_MODEL_KEY`.

- **`agent`** builds the trusted issue file, applies the vouch rules, the
  identity guard and the daily cap, picks the kind, and uploads the issue file
  and the playbook as a one-day artifact. It holds no secret and never runs
  the agent. On a retry its context step also resolves the pull request's head
  branch name so the run job can start from it.
- **`agent-run`** installs the pinned harness and runs `mergeproof loop`
  inside a container (`MERGEPROOF_AGENT_IMAGE`, pinned by digest) that sees a
  copy of the checkout, the trusted issue file and playbook, mergeproof and
  the harness (read-only) and the handoff directory: no runner directory, no
  Docker socket, no Linux capabilities. `loop` runs the harness, asks the
  gate's own `check --local --json` whether the change is proven, and feeds
  the reasons back for up to `MERGEPROOF_ROUNDS` rounds. It never decides
  MERGE, RETRY or HUMAN: that happens later, on the real pull request. The
  job's only secrets are the model credentials, in the run step, passed to the
  container by name so they never sit in an argument list: no `GH_TOKEN`, no
  `MERGEPROOF_BOT_TOKEN`, no credential helper, `contents: read` and no
  `gh` call. A prompt-injected agent can leak the model key (the container
  has network for the model API and npm), but it holds no GitHub credential,
  cannot reach the runner's Actions runtime token or the Actions cache behind
  it, and cannot plant a fake `gh`/`git` or a `GIT_*`/`LD_PRELOAD`
  environment for a credentialed step to inherit: the credentialed work runs
  in a different job on a fresh runner. The branch (as a `git bundle` of
  `agent/*`) and the handoff files (`pr-title.txt`, `pr-body.md`,
  `stop-comment.md`, `loop.json`, `infra-error.txt`) leave as one more
  one-day artifact; only plain files with those names leave the container.
- **`agent-publish`** runs on a fresh runner that never runs the harness, npm
  or any code from the repo or the bundle (the one `node` use is an inline
  path-rule check with the pinned mergeproof checkout, reading git objects
  only). It downloads that artifact and treats every file in it as untrusted
  data: the bundle must verify and hold exactly one branch named
  `agent/<kind>-<issue>-<slug>` (on a retry, also exactly the pull request's
  head branch; a fork pull request is never retried), its tip must descend from
  the default-branch tip (a retry must fast-forward the current head, never
  force it), and the changes it introduces must not touch `.github/`,
  `.mergeproof.json` or `.mergeproof/` (checked on raw paths with renames
  split) nor edit an agent-instruction file or a file one imports
  (`paths.agentInstructions` from the base branch's config). The title must be
  one non-empty line of at most 200 characters without control characters, the
  body and the stop comment at most 60000 bytes, and gh receives them only
  through `--title` from a file-read variable and `--body-file`. Only then does
  the job push with `MERGEPROOF_BOT_TOKEN`, open the pull request (a retry
  just pushes), post the stop comment as the bot and post the dispatch marker
  with `github.token` (new runs only). An output that fails validation is
  refused: a comment on the issue, the `needs-human` label and a red run;
  nothing was pushed. A validation step that breaks or a push that fails gets
  the same. If the harness could not run (authentication, rate limit,
  overload, unknown model), `loop` leaves a single fixed line in
  `infra-error.txt`; `agent-publish` checks its shape and posts one notice on
  the issue (no label, nothing pushed) so you can re-add the `agent` label
  later. The bot's own comments never come back into a later run's issue file
  as trusted text.

A `github-actions[bot]` issue (opened by another workflow) never starts the
agent on its own; a writer's `agent` or `agent:urgent` label on it does, through
the same title-and-body vouch as for a human author.

Two things to know about the harnesses:

- **Supply chain.** Each harness is downloaded as one pinned release and the
  step fails unless its SHA-512 matches (npm tarballs for claude and gemini,
  Google's tarball for agy). None of the vendors' installers is run: they
  install whatever is newest and check it against a hash from the same host.
  Upgrading is your call: download the release, check its hash yourself, then
  set the `_URL` and `_SHA512` variables together.
- **Permissions.** Claude Code runs with a tool deny-list (web fetch and
  search, `curl`, `wget`, `gh`). Gemini CLI and agy run headless with their
  permission prompts off and have no deny-list, so for them the prompt's ban on
  fetching issues and web pages is not backed by anything. The trusted issue
  file is the only prompt-injection control; the job split bounds the blast
  radius, since an injected agent can reach GitHub only through work that
  `agent-publish` validates before anything is pushed.

`AGY_CLI_DISABLE_AUTO_UPDATE=1` and `DISABLE_AUTOUPDATER=1` keep the pinned
binaries from replacing themselves mid-run.
