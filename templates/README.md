# Workflow templates (M2)

The three templates `mergeproof init` copies into a customer's
`.github/workflows/`, already wired to the reusable action
`ahmed-3m/mergeproof@v1` (this repo's `action.yml`):

| Template | Flow | What it does |
|---|---|---|
| `mergeproof-pr.yml` | PR → outcome | After the repo's CI completes on a PR: a `context` job resolves the PR, the dispatch marker and the attempt count; a read-only `gate` job runs `check --verdict-out` (it runs PR code, so it gets no secrets and a read-only token); the `apply` job runs `apply` (writes only here), pushes the ledger, re-dispatches the agent on RETRY while attempts remain, or labels `needs-human` when they are exhausted. |
| `mergeproof-issue.yml` | issue → PR | An issue opened by an allowlisted author or labeled `agent` by a write-capable collaborator starts the coding agent with the skill for the issue's kind, then posts the dispatch-marker comment (`github-actions[bot]` authored) that the PR workflow reads back. |
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
`needs-human` labels and the `mergeproof-ledger` branch. Every job of every
workflow checks the `MERGEPROOF_MODE != 'off'` kill switch first; shadow vs
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
| `MERGEPROOF_AGENT` | none | `mergeproof init` | Agent name for the trust bucket (`--agent`), e.g. `claude-code`. Never read from the PR. |
| `MERGEPROOF_MODEL` | none | `mergeproof init` | Model name for the trust bucket (`--model` and the agent's `--model` arg), e.g. `glm-4.7`. |
| `MERGEPROOF_MODEL_BASE_URL` | unset | `mergeproof init` | Anthropic-compatible endpoint the agent action talks to; `https://api.z.ai/api/anthropic` for GLM. Leave unset for Anthropic's own API. |
| `MERGEPROOF_AUTHORS` | empty | Maintainer | Comma-separated logins whose newly opened issues start the agent, e.g. `alice,bob`. Empty means only the `agent` label (or a dispatch) starts runs. |
| `MERGEPROOF_BUGFIX_LABELS` | `bug` | Maintainer | Comma-separated issue labels that make the run a bugfix; every other issue is a feature. |
| `MERGEPROOF_DAILY_LIMIT` | `10` | Maintainer | Maximum runs of `mergeproof-issue.yml` per UTC day, this run included. Over the cap: a comment on the issue and a clean stop. |
| `MERGEPROOF_BOT_LOGIN` | none | `mergeproof init` | Login of the bot user whose token opens agent PRs; the issue workflow looks for its PRs on `agent/<kind>-<issue>-*` branches. |

## Secrets (Settings → Secrets and variables → Actions → Secrets)

| Secret | Who sets it | Meaning |
|---|---|---|
| `MERGEPROOF_MODEL_KEY` | `mergeproof init` | API key for the model provider (passed as the agent action's `anthropic_api_key`). |
| `MERGEPROOF_BOT_TOKEN` | `mergeproof init` | PAT of the bot user with `contents` write. The agent pushes and opens PRs with it, so they trigger CI. The apply job never sees it: it lands with the job's `github.token`, whose comments are `github-actions[bot]`-authored (the attempt count and the agent's retry prompt read only those) and whose merges branch protection already allows — the accepted trade-off is that a mergeproof merge does not itself trigger the repo's push workflows (the gate pinned the merged head's CI instead). |

The gate job sees no secret at all; see [SECURITY.md](../SECURITY.md) for the
full per-job permission table.
