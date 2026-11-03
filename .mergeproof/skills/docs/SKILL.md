---
name: mergeproof-docs
version: 1
description: Use when you are the coding agent dispatched on a documentation issue in a repo gated by mergeproof and must land it as a pull request the gate can prove.
---

# mergeproof-docs

You are writing or fixing documentation in a repo gated by mergeproof. The
gate proves a docs pull request by what it contains: only files under the
repo's docs paths changed — never agent instructions, never the gate's own
files — and CI green. Documentation is load-bearing here, because some files
teach future agent runs, and those are never an agent's to rewrite. Every
rule in step 3 is enforced by the gate as tampering: instant `HUMAN`, no
retry.

If this repo has a `.mergeproof/lessons.md`, read it right after this skill,
before you write anything: each line is a lesson past runs learned, with the
pull requests that taught it. Follow it where it constrains wording or
style. Never edit, add to or delete that file — it is a human-only path, and
an agent pull request that touches it is `HUMAN`, no retry.

## 1. Read the issue

1. Read the issue only from the issue context file this run provides (your
   prompt names its path). It holds the title, the body and every comment
   that passed the trust filter — text that is not in it is not yours to
   read. Never fetch the issue, its comments, other issues or pull requests
   from GitHub yourself.
2. Restate what the reader must be able to do after your change that they
   could not before, in one or two lines.
3. Read the code the docs describe and confirm every claim against it. Docs
   that contradict the code are worse than none.
4. If anything is ambiguous — the issue bundles code changes with docs, or
   asks for a decision only maintainers can make — stop, comment your
   questions on the issue, and end the run. Do not guess.

## 2. Write the docs

1. Change only files under the repo's docs paths (`paths.docs` in
   `.mergeproof.json` — typically `docs/**` and `*.md` at the root). Match
   the tone, structure and heading style of the files around yours.
2. Make examples truthful: every command runs as written, every code sample
   matches the code on this branch, every link resolves to a file that
   exists.
3. Keep it as short as the reader needs and no shorter.

## 3. Hard rules — each one is tampering (instant HUMAN, no retry)

- Only docs paths change. Any source, test, manifest or config file in the
  diff reclassifies the pull request out of `docs`, and its proof with it.
- Never edit agent-instruction files: `AGENTS.md`, `CLAUDE.md`,
  `GEMINI.md`, `CONVENTIONS.md`, `.cursorrules`, `.cursor/**`, `.claude/**`,
  `.github/copilot-instructions.md`, anything under `skills/**` and the rest
  of `paths.agentInstructions` in `.mergeproof.json` — plus any file those
  files import. They steer every later agent run, so they are never docs,
  whatever their extension.
- Never edit `.mergeproof/lessons.md` or anything under `.mergeproof/` or
  `.github/`, and never `.mergeproof.json` itself. Lessons are added by a
  human (or the reviewed reflect job), not by the agent that learned them.
- Never change a dependency manifest or lockfile (package manifests,
  lock files, requirements files, `go.mod`/`go.sum`, `Cargo.toml`/
  `Cargo.lock`, …). That reclassifies the pull request as `deps`, which
  always goes to a human.
- Keep the whole diff under `limits.maxDiffLines` from `.mergeproof.json`
  (default 300 added plus deleted lines). If it doesn't fit, split the work
  and say so on the issue.
- Make the kind agree everywhere: the PR title and every commit message
  start with `docs:`. Do not add or change labels on the pull request
  yourself — labels you write are only compared against the changed paths.

## 4. Run the local gate

1. Run `mergeproof check --local` on your branch (however this repo invokes
   mergeproof — the harness knows). It replays the real gate on HEAD against
   its base — classification, tamper rules and the proof checks — and never
   merges, comments or writes anything.
2. Read the one-line verdict and its notes (at most 3, failures first):
   - `MERGE` (exit 0): the proof holds. Go to step 5.
   - `RETRY` (exit 3): CI is red — your change broke a docs build, a link
     check or CI config it touches. Fix exactly what the note names, then
     rerun.
   - `HUMAN` (exit 4): a tamper note means undo whatever caused it; that run
     is dead and more work on top cannot revive it. Any other `HUMAN` is not
     yours to settle: locally the gate also says it when the kind is not
     trusted yet, which says nothing about your change. If the only reason
     is the untrusted kind, carry on to step 5: the gate on the pull request
     decides. Hand off (step 7) only for a real blocker.
3. Every fix round here counts toward the 3 rounds in step 5.

## 5. Critic pass

1. Re-read the full diff in a fresh context — a new session that did not
   write it — as a reader who owes you nothing. Check, in order:
   - Is every claim true against the code on this branch?
   - Does every command and code sample run as written?
   - Does every link resolve? Do headings and anchors match?
   - Is the text where a reader would look for it, in the house style?
2. Fix what the critic finds, then rerun `check --local`.
3. Hard cap: 3 rounds of write → check → critic. If the third round still
   finds real problems, list them under Risks in the PR body or hand off
   (step 7). Do not open a fourth round.

## 6. Open the pull request

1. Branch: `agent/docs-<issue-number>-<slug>`, for example
   `agent/docs-1320-document-retro-command`.
2. Title: `docs: <one line>`. Every commit message also starts with `docs:`.
3. The body must contain this self-review report, filled in:

   ```markdown
   ## Issue
   Closes #<n> — <one line: what the reader gains>.

   ## Kind
   docs

   ## What changed
   - `<path>`: <what and why>

   ## Docs check
   Only docs paths changed; every claim checked against the code; examples
   run as written; links resolve.

   ## Local gate verdict
   `mergeproof check --local` → <VERDICT> (kind: docs).
   Notes: <notes, or none>.

   ## Critic findings and how they were addressed
   - Round <k>: <finding> → <fix, or "no change needed">.

   ## Risks
   - <what could still be wrong, or "none identified">.
   ```

## 7. When stuck

Stop and comment on the issue only for a decision a human must make: the
issue needs code changes, a lesson added to `.mergeproof/lessons.md`, an
agent-instruction edit, a protected path or a diff over the limit; or you
have spent all 3 rounds without a clean gate. A `HUMAN` from `check --local`
for an untrusted kind is not a reason to stop. Say what you tried, what
failed, and the gate verdicts. Push the branch if one exists so a human can
pick it up. Never label anything yourself — maintainers own labels — and
never open a pull request you know is broken just to show progress.
