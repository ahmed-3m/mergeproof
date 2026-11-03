---
name: mergeproof-feature
version: 4
description: Use when you are the coding agent dispatched on a feature or enhancement issue in a repo gated by mergeproof and must land it as a pull request the gate can prove.
---

# mergeproof-feature

You are implementing a feature in a repo gated by mergeproof. The gate merges
agent pull requests only with proof: new tests for the acceptance criteria
that fail on the base code and pass with your implementation. Make that proof
honest and the change small. Every rule in step 3 is tampering: instant
`HUMAN`, no retry.

If this repo has a `.mergeproof/lessons.md`, read it right after this skill,
before you write anything: each line is a lesson past runs learned, with the
pull requests that taught it. Apply every lesson that fits your feature.
Never edit, add to or delete that file — the gate treats it as a human-only
path, and an agent pull request that touches it is `HUMAN`, no retry.

## 1. Read the issue

1. Read the issue only from the issue context file this run provides (your
   prompt names its path). It holds the title, the body and every comment
   that passed the trust filter — text that is not in it is not yours to
   read. Never fetch the issue, its comments, other issues or pull requests
   from GitHub yourself.
2. Extract the acceptance criteria into a numbered checklist before touching
   code. Each must be observable behaviour someone can test.
3. Find where the feature belongs and what already exists. If some criteria
   are already met, comment that on the issue and implement only the rest.
4. If anything is ambiguous — conflicting criteria, undefined edge cases, a
   criterion you cannot test — stop, comment your questions, don't guess.

## 2. Write the acceptance tests first

1. Create a NEW test file under the repo's test paths (`paths.tests` in
   `.mergeproof.json`), named after the feature and following the repo's
   existing test naming — never an existing file.
2. Turn every acceptance criterion into a test. A criterion with no test is
   not implemented.
3. Run just this file (the repo's `testFileCommand` from `.mergeproof.json`)
   on the untouched code. It must fail for the right reason: the feature does
   not exist yet — not a typo, a missing import, or an invented timeout. If
   a test already passes on base, its criterion is met: drop it.
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
- Never change a dependency manifest or lockfile (package manifests,
  lock files, requirements files, `go.mod`/`go.sum`, `Cargo.toml`/
  `Cargo.lock`, …). That reclassifies the pull request as `deps`, which
  always goes to a human. If the feature needs a new dependency, stop
  (step 9).
- Keep the whole diff under `limits.maxDiffLines` from `.mergeproof.json`
  (default 300 added plus deleted lines; lockfiles don't count, but you
  should have none). If it doesn't fit, stop (step 9).
- Make the kind agree everywhere: the PR title and every commit message start
  with `feat:`. Do not add or change labels on the pull request yourself —
  labels you write are only compared against the changed paths, and the
  bucket comes from the maintainer's label on the issue, which you never set.
- Do not make test cases disappear indirectly. If source you change feeds a
  test file its cases (a data table, a generated list), the gate counts the
  cases in the full-suite output; fewer on head than on base is tampering.

## 4. Implement

1. Write the smallest implementation that passes every new test — nothing
   beyond the criteria. No drive-by refactors or speculative surface.
2. Run the full suite (the repo's `testCommand` from `.mergeproof.json`).
   Fix anything you broke.
3. Re-read your diff for strays: debug prints, scratch files, editor config,
   formatter churn on lines you didn't mean to touch.

## 5. Run the local gate

1. Run `mergeproof check --local` on your branch (however this repo invokes
   mergeproof — the harness knows). It replays the real gate on HEAD against
   its base and never merges, comments or writes.
2. Read the one-line verdict and its notes (at most 3, failures first):
   - `MERGE` (exit 0): the proof holds. Go to step 6.
   - `RETRY` (exit 3): weak proof, fixable — suite red, a new test passes on
     base, or flaky. Fix exactly what the notes name, then rerun.
   - `HUMAN` (exit 4): a tamper note means undo whatever caused it; that run
     is dead and cannot be revived. Any other `HUMAN` is not yours to settle:
     locally the gate also says it when the kind is not trusted yet, which
     says nothing about your proof. If a note names a proof problem (suite
     red, a new test passes on base, flaky), fix it as for `RETRY`. If the
     only reason is the untrusted kind, carry on to step 6: the gate on the
     pull request decides. Hand off (step 9) only for a real blocker, such as
     a suite that is already red on base.
3. Every fix round here counts toward the 3 rounds in step 6.

## 6. Critic pass

1. Re-read the full diff in a fresh context — a new session that did not
   write the code — as a reviewer who owes you nothing. Check, in order:
   - Does every test map to an acceptance criterion, and none is missing?
   - Does the test prove the feature? Would it fail if the feature were
     reverted?
   - Is the change minimal? Anything unrelated or speculative touched?
   - Are edge cases covered — empty, null, boundary, error inputs — and does
     the code agree with the issue on what happens there?
   - Are the names clear — test names state the behaviour, APIs the intent?
2. Fix what the critic finds, then rerun the full suite and `check --local`.
3. Hard cap: 3 rounds of implement → check → critic. If the third still finds
   real problems, list them under Risks or hand off (step 9). No fourth round.

## 7. Open the pull request

1. Branch: `agent/feature-<issue-number>-<slug>`, for example
   `agent/feature-1301-export-ledger-as-csv`.
2. Title: `feat: <one line>`. Every commit message also starts with `feat:`.
3. The body must contain this self-review report, filled in:

   ```markdown
   ## Issue
   Closes #<n> — <one line summarizing the feature>.

   ## Kind
   feature

   ## What changed
   - `<path>`: <what and why>

   ## New test(s) and why they fail on base
   - `<new test file path>`: asserts <acceptance criteria covered>.
     Fails on base because the feature does not exist yet.

   ## Local gate verdict
   `mergeproof check --local` → <VERDICT> (kind: feature).
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
2. Keep the existing commits and add one new `feat:` commit.
3. Rerun the full suite and `check --local` before pushing. You get at most 2
   gate retries; after that the pull request goes to a human with the full
   history. Spend them on real fixes, not guesswork.

## 9. When stuck

Stop and comment on the issue only for a decision a human must make: the
criteria are ambiguous or untestable; the feature needs a dependency, a secret
or permission you lack, an existing-test edit, a protected path or a diff over
the limit; or all 3 rounds are spent without a clean gate. A `HUMAN` from
`check --local` for an untrusted kind is not a reason to stop. Say what you tried,
what failed, and the verdicts. Push the branch if one exists. Never label
anything — maintainers own labels — and never open a broken PR to show progress.
