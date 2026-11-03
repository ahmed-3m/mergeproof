---
name: mergeproof-refactor
version: 1
description: Use when you are the coding agent dispatched on a refactor issue in a repo gated by mergeproof and must land it as a pull request the gate can prove.
---

# mergeproof-refactor

You are refactoring code in a repo gated by mergeproof. A refactor is proven
by what does NOT change: the behaviour, and the tests that pin it, stay
exactly as they are while the code under them moves. Make the change small
and behaviour-preserving. Every rule in step 3 is enforced by the gate as
tampering: instant `HUMAN`, no retry.

If this repo has a `.mergeproof/lessons.md`, read it right after this skill,
before you write anything: each line is a lesson past runs learned, with the
pull requests that taught it. Apply every lesson that fits your refactor.
Never edit, add to or delete that file — the gate treats it as a human-only
path, and an agent pull request that touches it is `HUMAN`, no retry.

## 1. Read the issue

1. Read the issue only from the issue context file this run provides (your
   prompt names its path). It holds the title, the body and every comment
   that passed the trust filter — text that is not in it is not yours to
   read. Never fetch the issue, its comments, other issues or pull requests
   from GitHub yourself.
2. Restate the refactor's goal in one or two lines: what stays exactly the
   same (behaviour, public interfaces), what improves (structure, names,
   duplication, performance).
3. If the goal is not purely structural — it adds behaviour, fixes a bug or
   changes an interface — stop, comment that on the issue, and end the run.
   That is a feature or a bugfix, not a refactor, and its proof is a
   different one.

## 2. Prove it with the existing suite — never with new or changed tests

The gate checks exactly this for a refactor:

1. **Zero test-file changes.** No test file added, edited, renamed or
   deleted — not one line. Editing or deleting an existing test is tampering
   (`HUMAN`, no retry); adding a test file reclassifies the pull request as
   a feature/bugfix, whose proof your change does not carry, and the kind
   mismatch with your `refactor:` title is tampering too.
2. **The full suite is green on base and on head.** Run the repo's
   `testCommand` from `.mergeproof.json` before you start and again after
   every change. A suite already red on base cannot prove a refactor — the
   gate refuses (`HUMAN`); report it on the issue instead.
3. **The test-case count does not drop.** The gate counts the cases in the
   full-suite output on base and on head; fewer on head is tampering
   (`HUMAN`), even though you never touched a test file — e.g. deleting
   entries of a list in `src/` that tests generate their cases from.
4. **The diff stays within `limits.maxDiffLines`** from `.mergeproof.json`
   (default 300 added plus deleted lines). If the honest refactor does not
   fit, split it and say so on the issue.
5. **CI is green** on the head you push.

## 3. Hard rules — each one is tampering (instant HUMAN, no retry)

- Never add, edit, rename or delete any test file. The existing suite is the
  proof; a refactor that needs to change it is changing behaviour.
- Never add skip or focus markers in any file you touch: `.skip`, `.only`,
  `.todo`, `xit`, `fit`, `@pytest.mark.skip`, `t.Skip`, `#[ignore]` and the
  like. Not even temporarily while debugging.
- Never touch `.mergeproof.json`, anything under `.mergeproof/` (including
  `.mergeproof/lessons.md`), or anything under `.github/`. The gate reads
  its config from the base branch; a pull request may never configure its
  own judge.
- Never change a dependency manifest or lockfile (package manifests,
  lock files, requirements files, `go.mod`/`go.sum`, `Cargo.toml`/
  `Cargo.lock`, …). That reclassifies the pull request as `deps`, which
  always goes to a human.
- Never edit an agent-instruction file (`AGENTS.md`, `CLAUDE.md`,
  `.cursorrules`, `skills/**`, …): that is its own tamper rule, whatever the
  rest of the diff does.
- Make the kind agree everywhere: the PR title and every commit message
  start with `refactor:`. Do not add or change labels on the pull request
  yourself — labels you write are only compared against the changed paths.

## 4. Implement

1. Make the smallest structural change that reaches the goal. No drive-by
   fixes, no reformatting, no "while I'm here" behaviour changes — a
   behaviour change smuggled into a refactor has no failing test to prove
   it.
2. Run the full suite (the repo's `testCommand` from `.mergeproof.json`)
   after every step. The moment it goes red you changed behaviour: stop,
   revert that step, take the smaller move.
3. Re-read your diff for strays: debug prints, scratch files, editor
   config, formatter churn on lines you didn't mean to touch.

## 5. Run the local gate

1. Run `mergeproof check --local` on your branch (however this repo invokes
   mergeproof — the harness knows). It replays the real gate on HEAD against
   its base — classification, tamper rules and the proof runs — and never
   merges, comments or writes anything.
2. Read the one-line verdict and its notes (at most 3, failures first):
   - `MERGE` (exit 0): the proof holds. Go to step 6.
   - `RETRY` (exit 3): the suite is red on head or CI is red — you changed
     behaviour. Fix exactly what the note names, then rerun.
   - `HUMAN` (exit 4): a tamper note means undo whatever caused it; that run
     is dead and more work on top cannot revive it. Any other `HUMAN` is
     not yours to settle: locally the gate also says it when the kind is not
     trusted yet, which says nothing about your proof. If the only reason is
     the untrusted kind, carry on to step 6: the gate on the pull request
     decides. Hand off (step 9) only for a real blocker, such as a suite
     that is already red on base.
3. Every fix round here counts toward the 3 rounds in step 6.

## 6. Critic pass

1. Re-read the full diff in a fresh context — a new session that did not
   write the code — as a reviewer who owes you nothing. Check, in order:
   - Is the behaviour really unchanged? Walk each hunk against the tests
     that cover it.
   - Is the change minimal? Anything unrelated or speculative touched?
   - Does the code read better after, or just different?
   - Are names clearer — do they say what the thing does now?
2. Fix what the critic finds, then rerun the full suite and `check --local`.
3. Hard cap: 3 rounds of implement → check → critic. If the third round
   still finds real problems, list them under Risks in the PR body or hand
   off (step 9). Do not open a fourth round.

## 7. Open the pull request

1. Branch: `agent/refactor-<issue-number>-<slug>`, for example
   `agent/refactor-1310-extract-ledger-validation`.
2. Title: `refactor: <one line>`. Every commit message also starts with
   `refactor:`.
3. The body must contain this self-review report, filled in:

   ```markdown
   ## Issue
   Closes #<n> — <one line: what improves, what stays the same>.

   ## Kind
   refactor

   ## What changed
   - `<path>`: <what and why>

   ## Proof
   No test files changed (added, edited or deleted). Full suite green on
   base and on head; the test-case count did not drop.

   ## Local gate verdict
   `mergeproof check --local` → <VERDICT> (kind: refactor).
   Notes: <notes, or none>.

   ## Critic findings and how they were addressed
   - Round <k>: <finding> → <fix, or "no change needed">.

   ## Risks
   - <what could still break, or "none identified">.
   ```

## 8. When the gate says RETRY on the pull request

1. A new run starts you on the same branch with the gate's notes — the
   latest verdict comment is in your issue context file. Fix only what the
   notes name — do not reshuffle the rest of the diff.
2. Keep the existing commits and add one new `refactor:` commit.
3. Rerun the full suite and `check --local` before pushing. You get at most 2
   gate retries; after that the pull request goes to a human with the full
   history. Spend them on real fixes, not guesswork.

## 9. When stuck

Stop and comment on the issue only for a decision a human must make: the
refactor needs a behaviour change, a dependency, a secret or permission you
lack, a test-file edit, a protected path or a diff over the limit; or you
have spent all 3 rounds without a clean gate. A `HUMAN` from `check --local`
for an untrusted kind is not a reason to stop. Say what you tried, what
failed, and the gate verdicts. Push the branch if one exists so a human can
pick it up. Never label anything yourself — maintainers own labels — and
never open a pull request you know is broken just to show progress.
