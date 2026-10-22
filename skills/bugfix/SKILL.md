---
name: mergeproof-bugfix
version: 1
description: Use when you are the coding agent dispatched on a bug-labeled issue in a repo gated by mergeproof and must land the fix as a pull request the gate can prove.
---

# mergeproof-bugfix

You are fixing a bug in a repo gated by mergeproof. The gate merges agent pull
requests only with proof: a new test that fails on the base code and passes
with your fix. Make that proof honest and the fix small. Every rule in step 3
is enforced by the gate as tampering: instant `HUMAN`, no retry.

## 1. Read the issue

1. Read the issue and all of its comments.
2. Restate the bug before touching code, in one or two lines:
   `Expected: <what should happen>. Actual: <what happens instead>.`
3. Find the code path involved and confirm the actual behaviour is real.
4. If anything is ambiguous — no reproducible steps, the report contradicts
   the code, or it bundles several unrelated problems — stop, comment your
   questions on the issue, and end the run. Do not guess.

## 2. Write the proof test first

1. Create a NEW test file under the repo's test paths, named after the bug
   (for example `tests/issue-<n>-<slug>.test.mjs`) — never an existing file.
2. Write the smallest test that reproduces the bug: call the code the way the
   issue does and assert the expected behaviour. It must fail on the current
   code.
3. Run just this file (the repo's `testFileCommand` from `.mergeproof.json`)
   and read the failure. It must fail for the right reason — the bug — not
   because of a typo, a missing import, or a timeout you invented.
4. Make it deterministic. The gate runs this file 2 times on base and 3 times
   on head and judges each file by exit code: fail on base every run, pass on
   head every run. One flaky run is a RETRY. No real-time waits, no network,
   no unseeded randomness, and no dependence on test order, other files,
   dates, timezone or locale.

## 3. Hard rules — each one is tampering (instant HUMAN, no retry)

- Never edit, rename, move or delete an existing test file. New test files
  only, always.
- Never add skip or focus markers in any file you touch: `.skip`, `.only`,
  `.todo`, `xit`, `fit`, `@pytest.mark.skip`, and the like. Not even
  temporarily while debugging.
- Never touch `.mergeproof.json`, anything under `.mergeproof/`, or anything
  under `.github/`. The gate reads its config from the base branch; a pull
  request may never configure its own judge.
- Never change a manifest or a lockfile (`package.json`, lock files, …). That
  reclassifies the pull request as `deps`, which always goes to a human. If
  the fix seems to need a new dependency, stop (step 9).
- Keep the whole diff under `limits.maxDiffLines` from `.mergeproof.json`
  (default 300 added plus deleted lines; lockfiles don't count, but you
  should have none). If the honest fix doesn't fit, stop (step 9).
- Make the kind agree everywhere: the PR title and every commit message start
  with `fix:`. Do not add or change labels on the pull request yourself —
  labels you write are only compared against the changed paths, and the
  deciding bugfix label lives on the issue, where only maintainers set it.
- Do not make test cases disappear indirectly. If source you change feeds a
  test file its cases (a data table, a generated list), the gate counts the
  cases in the full-suite output; fewer on head than on base is tampering.

## 4. Implement

1. Make the smallest change that makes the new test pass. No drive-by
   refactors, no reformatting, no "while I'm here" fixes.
2. Run the full suite (the repo's `testCommand`, `npm test` by default). Fix
   anything you broke.
3. Re-read your diff for strays: debug prints, scratch files, editor config,
   formatter churn on lines you didn't mean to touch.

## 5. Run the local gate

1. Run `npx @ahmed-3m/mergeproof check --local` on your branch. It replays the
   real gate on HEAD against its base — classification, tamper rules and the
   proof runs — and never merges, comments or writes anything.
2. Read the one-line verdict and its notes (at most 3, failures first):
   - `MERGE` (exit 0): the proof holds. Go to step 6.
   - `RETRY` (exit 3): weak proof, fixable. The notes name the problem —
     suite red, the new test passes on base, or flakiness. Fix exactly what
     they name, then rerun the suite and the gate.
   - `HUMAN` (exit 4): a tamper note means undo whatever caused it; that run
     is dead and more work on top cannot revive it. Any other `HUMAN`
     (untrusted kind, suite already red on base) means hand off (step 9).
3. Every fix round here counts toward the 3 rounds in step 6.

## 6. Critic pass

1. Re-read the full diff in a fresh context — a new session that did not
   write the code — as a reviewer who owes you nothing. Check, in order:
   - Does the test prove the issue? Would it fail again if the bug returned?
   - Is the change minimal? Is anything unrelated touched?
   - Are edge cases covered: empty, null, boundary and error inputs?
   - Are the names clear — does the test name state the behaviour?
   - Does the test fail on base for the stated reason?
2. Fix what the critic finds, then rerun the full suite and `check --local`.
3. Hard cap: 3 rounds of implement → check → critic. If the third round still
   finds real problems, list them under Risks in the PR body or hand off
   (step 9). Do not open a fourth round.

## 7. Open the pull request

1. Branch: `agent/bugfix-<issue-number>-<slug>`, for example
   `agent/bugfix-1284-parser-crash-on-empty-payload`.
2. Title: `fix: <one line>`. Every commit message also starts with `fix:`.
3. The body must contain this self-review report, filled in:

   ```markdown
   ## Issue
   Closes #<n> — <one line: expected vs actual behaviour>.

   ## Kind
   bugfix

   ## What changed
   - `<path>`: <what and why>

   ## New test(s) and why they fail on base
   - `tests/<file>`: asserts <behaviour>. Fails on base because <reason>.

   ## Local gate verdict
   `npx @ahmed-3m/mergeproof check --local` → <VERDICT> (kind: bugfix).
   Notes: <notes, or none>.

   ## Critic findings and how they were addressed
   - Round <k>: <finding> → <fix, or "no change needed">.

   ## Risks
   - <what could still break, or "none identified">.
   ```

## 8. When the gate says RETRY on the pull request

1. A new run starts you on the same branch with the gate's notes. Fix only
   what the notes name — do not reshuffle the rest of the diff.
2. Keep the existing commits and add one new `fix:` commit.
3. Rerun the full suite and `check --local` before pushing. You get at most 2
   gate retries; after that the pull request goes to a human with the full
   history. Spend them on real fixes, not guesswork.

## 9. When stuck

Stop and comment on the issue when: the bug is ambiguous or not reproducible;
the fix needs a dependency, an existing-test edit, or a diff over the limit;
or you have spent all 3 rounds without a clean gate. Say what you tried, what
failed, and the gate verdicts. Push the branch if one exists so a human can
pick it up. Never label anything yourself — maintainers own labels — and never
open a pull request you know is broken just to show progress.
