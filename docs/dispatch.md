# Local agent: agy (`mergeproof dispatch`)

Run the Antigravity CLI (`agy`) on an issue from your own machine. Its PR is then gated like any other agent PR.

## Setup

1. Give agy a machine account of its own (not your login).
2. List it in `.mergeproof.json` on the default branch, with its own trust bucket:

   ```json
   "agents": {
     "logins": ["my-claude-bot", "my-agy-bot"],
     "identities": { "my-agy-bot": { "agent": "agy", "model": "gemini-4-argon-high" } }
   }
   ```

3. Create a fine-grained PAT for that account, on this one repository, with `contents: write` and `pull-requests: write` only.

## Run

In a clone of the repo, with `gh` signed in as yourself and `agy` signed in:

```bash
read -rs MERGEPROOF_DISPATCH_TOKEN && export MERGEPROOF_DISPATCH_TOKEN
npx @ahmed-3m/mergeproof dispatch 17 --harness agy --dry-run   # prints the plan and the issue file
npx @ahmed-3m/mergeproof dispatch 17 --harness agy
```

What happens:

- `dispatch` reads the issue once and writes a trusted issue file. Comments are kept only from trusted authors.
- **Untrusted author** (not in `MERGEPROOF_AUTHORS`, not a write/maintain/admin collaborator): it stops. Read the file from `--dry-run`, then re-run with the `--vouch <digest>` it prints. The digest covers the exact file you read, so a later edit is refused.
- agy runs as `agy -p --dangerously-skip-permissions` in a throwaway worktree on a new `agent/issue-17` branch. Headless agy denies file writes without that flag, so it never runs in your checkout.
- The token reaches agy only, as `GH_TOKEN`. Your other tokens and keys are removed from its environment.
- agy pushes and opens the PR as its own account. The PR workflow gates it in the agy trust bucket.
- The worktree is removed when agy exits 0 and kept for inspection when it fails.

## Security

The worktree is **not a sandbox**. agy runs as your OS user with permission prompts off, and can read whatever you can, including SSH keys and your `gh` login. When the issue text is not yours, run `dispatch` under a dedicated OS user, or in a VM or container that holds only the clone, agy's login and the token.

## Limits

- A dispatched PR has no dispatch marker, so the gate gets no `--issue`. Every agy PR lands in the feature bucket (no bugfix split).
- A `RETRY` does not restart agy. Run `dispatch` again or fix the PR by hand.

To run agy from GitHub Actions instead, see [the agent harness](../templates/README.md#the-agent-harness-mergeproof_harness).
