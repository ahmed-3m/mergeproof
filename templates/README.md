# Workflow templates (M2)

The three templates `mergeproof init` copies into a customer's
`.github/workflows/`, already wired to the reusable action
`ahmed-3m/mergeproof@v1` (this repo's `action.yml`):

| Template | Flow | What it does |
|---|---|---|
| `mergeproof-pr.yml` | PR → outcome | After the repo's CI completes on a PR: a `context` job resolves the PR, the dispatch marker and the attempt count; a read-only `gate` job runs `check --verdict-out` (it runs PR code, so it gets no secrets and a read-only token); the `apply` job runs `apply` (writes only here), pushes the ledger, re-dispatches the agent on RETRY while attempts remain, or labels `needs-human` when they are exhausted. |
| `mergeproof-issue.yml` | issue → PR | An issue opened by an allowlisted author or labeled `agent` by a write-capable collaborator starts the coding agent with the skill for the issue's kind, then posts the dispatch-marker comment (`github-actions[bot]` authored) that the PR workflow reads back. The agent never reads the issue from GitHub: the context step builds a trusted issue file — title and body from the author when trusted (or, for a label start, while the title and body are unedited since the label vouched), comments only from trusted authors, plus the gate's latest PR verdict on a retry — and that file is the agent's only issue text; the prompt forbids fetching issues, PRs, comments or web pages, and `claude_args` disallows those tools as defence in depth. |
| `mergeproof-sync.yml` | nightly | `sync` settles the ledger and opens a human-triage issue for each newly reverted merge. |


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
| `{{INSTALL_COMMAND}}` | `mergeproof-pr.yml` | The command that installs dependencies before the gate's proof runs (e.g. `npm ci`); `:` or `echo` for repos with no install step. Only the gate job runs it — the apply job never installs anything. |

## Repository variables (Settings → Secrets and variables → Actions → Variables)

| Variable | Default | Who sets it | Meaning |
|---|---|---|---|
| `MERGEPROOF_MODE` | unset (runs) | Maintainer | **Kill switch only.** Set to `off` and every mergeproof workflow stops before doing anything. Shadow vs enforce mode is configured per repo in `.mergeproof.json`. |
| `MERGEPROOF_AGENT` | none | `mergeproof init` | Agent name for the trust bucket (`--agent`), e.g. `claude-code`. Never read from the PR. A PR whose author has an entry in `agents.identities` (base-branch `.mergeproof.json`) uses that entry's agent and model instead. |
| `MERGEPROOF_MODEL` | none | `mergeproof init` | Model name for the trust bucket (`--model` and the agent's `--model` arg), e.g. `glm-4.7`. |
| `MERGEPROOF_MODEL_BASE_URL` | unset | `mergeproof init` | Anthropic-compatible endpoint the agent action talks to; `https://api.z.ai/api/anthropic` for GLM. Leave unset for Anthropic's own API. |
| `MERGEPROOF_AUTHORS` | empty | Maintainer | Comma-separated logins whose newly opened issues start the agent, e.g. `alice,bob`. Empty means only the `agent` label (or a dispatch) starts runs. |
| `MERGEPROOF_BUGFIX_LABELS` | `bug` | Maintainer | Comma-separated issue labels that make the run a bugfix; every other issue is a feature. |
| `MERGEPROOF_DAILY_LIMIT` | `10` | Maintainer | Maximum runs of `mergeproof-issue.yml` per UTC day, this run included. Over the cap: a comment on the issue and a clean stop. |
| `MERGEPROOF_BOT_LOGIN` | none | `mergeproof init` | Login of the bot user whose token opens agent PRs; the issue workflow looks for its PRs on `agent/<kind>-<issue>-*` branches. |
| `MERGEPROOF_HARNESS` | `claude` | Maintainer | Which coding agent the issue workflow runs: `claude` (`anthropics/claude-code-action`) or `agy` (the Antigravity CLI, headless). `agy` also needs `MERGEPROOF_AGENT=agy`, so its PRs land in their own trust bucket; any other value stops the run. Read the agy notes below before switching. |
| `MERGEPROOF_AGY_URL` | the pinned 1.4.6 tarball | Maintainer | Release tarball the agy harness downloads. Change it only together with `MERGEPROOF_AGY_SHA512`. |
| `MERGEPROOF_AGY_SHA512` | the pinned 1.4.6 hash | Maintainer | SHA-512 the download must match, or the step fails before anything runs. |

## Secrets (Settings → Secrets and variables → Actions → Secrets)

| Secret | Who sets it | Meaning |
|---|---|---|
| `MERGEPROOF_MODEL_KEY` | `mergeproof init` | API key for the model provider (passed as the agent action's `anthropic_api_key`; with `MERGEPROOF_HARNESS=agy`, a Gemini API key passed to agy as `GEMINI_API_KEY`). |
| `MERGEPROOF_BOT_TOKEN` | `mergeproof init` | PAT of the bot user that pushes and opens agent PRs, so they trigger CI. The claude agent holds it directly; on the agy path only the `agy-publish` job does, and it never runs agent code. Make it a fine-grained PAT for this one repository with `contents: write` and `pull-requests: write` only. The apply job never sees it: it lands with the job's `github.token`, whose comments are `github-actions[bot]`-authored (the attempt count and the agent's retry prompt read only those) and whose merges branch protection already allows — the accepted trade-off is that a mergeproof merge does not itself trigger the repo's push workflows (the gate pinned the merged head's CI instead). |

The gate job sees no secret at all; see [SECURITY.md](../SECURITY.md) for the
full per-job permission table.

## The agy harness (`MERGEPROOF_HARNESS=agy`)

Set `MERGEPROOF_HARNESS=agy`, `MERGEPROOF_AGENT=agy`, `MERGEPROOF_MODEL` to an
agy model label, and `MERGEPROOF_MODEL_KEY` to a Gemini API key. The issue
workflow then runs agy on the same prompt and the same trusted issue file as
the claude harness, split across three jobs so the agent never shares a
runner (or an environment) with a GitHub credential:

- **`agent`** builds the trusted issue file and, on the agy path, uploads it
  as a one-day artifact for the other jobs. It never runs agy. On a retry
  its context step also resolves the pull request's head branch name (with
  the job's own default token) so the agy job can start from it.
- **`agy-run`** installs the pinned binary and runs `agy -p`. Its only
  secret is `MERGEPROOF_MODEL_KEY` (as `GEMINI_API_KEY`): no `GH_TOKEN`, no
  `MERGEPROOF_BOT_TOKEN`, no credential helper, `contents: read` and no `gh`
  call anywhere. A prompt-injected agy can leak the Gemini key and reach
  what any code on a runner can (such as the Actions cache for the default
  branch), but no GitHub write credential, and it
  cannot plant a fake `gh`/`git` or a `GIT_*`/`LD_PRELOAD` environment for a
  credentialed step to inherit, because the credentialed work runs in a
  different job on a fresh runner (a later step in the same job would
  inherit all of that). The prompt is the claude prompt with exactly two
  substitutions: agy has no GitHub access and must not push, it commits on
  the branch the playbook names and writes the pull request title to
  `$MERGEPROOF_HANDOFF/pr-title.txt`, the body (the playbook's report) to
  `$MERGEPROOF_HANDOFF/pr-body.md` and, when the playbook says stop, its
  questions to `$MERGEPROOF_HANDOFF/stop-comment.md` (a retry adds only the
  new commit). The branch (as a `git bundle`) and those files leave as one
  more one-day artifact.
- **`agy-publish`** runs on a fresh runner that never runs agy, npm or any
  code from the repo or the bundle. It downloads that artifact and treats
  every file in it as untrusted data: the bundle must verify and hold
  exactly one branch named `agent/<kind>-<issue>-<slug>` (on a retry,
  exactly the pull request's head branch), its tip must descend from the
  default-branch tip (a retry must fast-forward the pull request's current
  head, never force it), and the changes it introduces must not touch
  `.github/`, `.mergeproof.json` or `.mergeproof/`: the bot PAT must never
  push workflow or gate files. The title must be one line of at most 200
  characters without control characters, the body and the stop comment at
  most 60000 bytes, and gh receives them only through `--title` from a
  file-read variable and `--body-file`. Only then does the job push with
  `MERGEPROOF_BOT_TOKEN`, open the pull request (a retry just pushes), post
  the stop comment as the bot and post the dispatch marker with
  `github.token` (new runs only). An output that fails validation is
  refused: a comment on the issue, the `needs-human` label and a red run;
  nothing was pushed. No branch and no stop comment behaves like the
  claude path's "agent finished without opening a pull request".

Two things are weaker than on the claude path, and the template says so
next to the steps:

- **Supply chain.** Google's documented installer (`curl … install.sh | bash`)
  installs whatever release is newest and checks it against a hash served by
  the same host, so it proves only that the download was not corrupted. The
  template never runs it: it downloads one release tarball and fails unless
  its SHA-512 matches the pin. Upgrading is your call: read the release's
  manifest, download the tarball, check its hash yourself, then set
  `MERGEPROOF_AGY_URL` and `MERGEPROOF_AGY_SHA512` together.
- **No tool deny-list.** Headless agy runs with
  `--dangerously-skip-permissions` and has no equivalent of `claude_args`'
  disallowed tools, so the prompt's ban on fetching issues, PRs and web pages
  is not backed by anything. The trusted issue file is the only
  prompt-injection control on this path; the job split is what bounds the
  blast radius, since an injected agent can reach GitHub only through work
  that `agy-publish` validates before anything is pushed.

`AGY_CLI_DISABLE_AUTO_UPDATE=1` is set so the pinned binary does not replace
itself mid-run (taken from the binary's strings; agy does not document it).
