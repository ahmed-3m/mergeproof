# RFC 0001: Trust without a human on every PR

- Status: draft, open for comment
- Date: 2026-11-12
- Scope: the trust half of the gate (`src/ledger.mjs`, `src/commands/sync.mjs`, `src/retro.mjs`) and the HUMAN rows of the decision table
- Roadmap items: MP-122 to MP-125 in `ROADMAP.md` (Phase H)

This document is written to be handed to a coding agent that has not seen the discussion behind it. Section 8 says what to build first and how to land it.

## 1. Summary

The goal is to stop needing a human on every agent PR. The finding is that the human cannot be removed, only moved: a trust signal needs a source of truth the judged agent cannot write, the gate may not call a model, and every such source in this repo is a human act. The proposal moves the human from "reviews every PR" to three cheap points: labelling bugs, auditing a sample, and cutting releases.

Phase 1 changes no verdict. It only measures the candidate signals, so later phases can be decided on data. Phase 1 is four small roadmap items the bot can build.

## 2. Constraints that bound every option

From `AGENTS.md` and `briefs/m3-self-loop.md`:

- The gate never calls an LLM. An LLM reviewer standing in for the human is not an option.
- The verdict contract (`MERGE | RETRY | HUMAN` and the exit codes) is frozen.
- A kind-label mismatch is tampering (constraint 3), and benchmark scenario 6 pre-registers HUMAN for it.
- Deps PRs never auto-merge in v1.
- The PR never configures its own gate; `paths.humanOnly` files always need a human.
- Events and retro output never feed `trustFor` (M3 principle 1). The ledger is the only source of trust.
- The last release runs the loop; a human release activates gate changes (M3 principle 2).
- `apply` trusts the verdict file for one fact only: that the proof held. Anything that runs PR code belongs in the gate job.

## 3. How trust works today

- `trustFor` (`src/ledger.mjs`) unlocks a (kind, agent, model) bucket after `trust.minOutcomes` (10) settled outcomes at `trust.minCleanRate` (90%) with no recent revert.
- `settle` (`src/commands/sync.mjs`) moves outcomes `open → pending → clean | reverted`, or `open → closed` when the PR is closed unmerged.
- An outcome is `clean` when no revert landed within `trust.revertWindowDays` (14).
- A proven PR is logged even when a human must merge it, so cold-start trust grows from human merges (`src/land.mjs`).

## 4. Problems found

1. **Trust depends on a human reverting.** Only a human reverts. With no human, every merge turns clean and trust measures nothing.
2. **Rejections are dropped.** `trustFor` counts `pending`, `clean` and `reverted` only. A proven PR that a maintainer closes becomes `closed`, which "never counts". An agent with 10 accepted and 30 rejected proven PRs reads as 100% clean. Nothing in the repo closes PRs automatically.
3. **"Clean" is a timeout, not exposure.** Gate merges use `github.token`, and such a merge starts no push workflows on `main` (`.github/workflows/mergeproof-pr.yml`, the comment above the apply step's `GH_TOKEN`). Fourteen days can pass with nothing having exercised the change.
4. **Ten outcomes prove little.** 10 clean of 10 is consistent, at 95% confidence, with a true clean rate as low as 74%.
5. **There is almost no data.** On 2026-11-12 the real ledger (`ledger.json` on the `mergeproof-ledger` branch) held two outcomes, both `docs` for `claude-code/claude-opus-5-5`, both from PRs with no linked issue. None came from the bot loop. `demo/ledger.json` on the same branch is the seeded demo, not real history.

## 5. Approaches rejected, and why

Do not rebuild these.

- **Auto-revert when `main` goes red.** The trigger never fires, because gate merges start no CI on `main` (problem 3). A revert PR opened with `github.token` starts no CI either. Even with CI dispatched, the PR's CI was already green and the proof ran the full suite on head, so red `main` only means merge skew or a flaky test. It is not a quality signal.
- **RETRY for "hygiene" tamper rules (`diffTooLarge`, `kindLabelMismatch`).** The mismatch half contradicts constraint 3 and scenario 6. The size half buys little: `mergeproof loop` already feeds `check --local` notes back for up to three rounds and opens no PR unless the change is proven, and a RETRY on a PR with no linked issue goes straight to `needs-human`. The one recorded mismatch (PR 64, titled `docs:`, classified `refactor`) looks like a classification gap for asset files, not something a retry would fix; that was inferred from the changelog and not confirmed against the PR's file list.
- **Blaming a merge when a later fix rewrites its lines.** The fixing agent chooses which lines it edits, so it can steer the signal.

## 6. Candidate signals

Every signal stays penalty-only, as reverts are today: a false match costs trust and never adds it.

| Signal | Who originates the truth | Can the judged agent steer it? | Where it is computed | Phase |
|---|---|---|---|---|
| A rejected proven PR counts against trust | Maintainer closing the PR | No; it holds no GitHub credential, and an author close already counts for nothing | `sync`, no code run | 1 measure, 2 enforce |
| Settle at release: `clean` only once a release contains the merge | Maintainer cutting the release | No, provided the bot cannot push tags (not checked) | `sync`, no code run | 1 measure, 3 enforce |
| Sampled audit: 1 in N trusted PRs still goes to HUMAN | Maintainer merging or closing | Only if the sample depends on something it picks, such as the head SHA | `decide` and `apply` | 3 |
| Regression bisect: a later bugfix's new test passes before a gated merge and fails after it | Maintainer's `bug` label | It can dodge blame, never gain trust | Gate job (it runs code) | 4, measured first |

## 7. Phases

### Phase 1: measure (buildable now)

Four roadmap items, all `status: later` until a maintainer flips them to `ready`. Each touches no human-only path and adds a new test file.

- **MP-122** `sync` records who closed an unmerged proven PR: `closedBy` and `closedByAuthor` on the outcome.
- **MP-123** `retro` shows maintainer rejections per bucket and the clean rate if they counted.
- **MP-124** `sync` records the release tag that first shipped each merge: `releasedIn`.
- **MP-125** `retro` shows how many clean outcomes shipped in a release before settling.

Order: MP-122, then MP-123; MP-124, then MP-125. The two pairs are independent. The full acceptance lists are in `ROADMAP.md` and are the contract.

### Phase 2: count rejections (human-landed, after data)

Add a status such as `rejected` to `STATUSES` and count it as a failure in `trustFor`. This changes `src/ledger.mjs` (human-only), the PROTOTYPE assumption that success means "merged and not reverted within 14 days", and the tests that pin `closed` as never counting (`tests/commands.test.mjs`, `tests/ledger-verify.test.mjs`, `tests/retro.test.mjs`). It needs a rule that separates a rejection from a superseded PR; a maintainer label is the likely answer.

### Phase 3: sampled audit and settle at release (human-landed)

- The audit adds a HUMAN row to the decision table in `src/decide.mjs` and PROTOTYPE. The sample must be decided once per PR from values the agent does not choose, and stay fixed across retries. Computing it in `apply` (which can only lower a MERGE) allows a salt the gate job never sees.
- Settle at release changes when `pending` becomes `clean` in `settle`.

### Phase 4: regression bisect (design only)

When a bugfix PR is gated, run its new tests on the parent of each recent gated merge and on the merge itself. A test that passes before and fails after names that merge. The result would be a second fact crossing from the gate job to `apply`, and must enter trust as a ledger outcome through `sync` once the blaming PR is merged. It needs `bug`-labelled issues to exist first; no recorded event has one.

## 8. Handoff: what to build and how

Build Phase 1 only. Do not start Phases 2 to 4; they change the gate's decisions and need a maintainer's design sign-off.

1. Read `AGENTS.md`, then the MP-122 to MP-125 entries in `ROADMAP.md`.
2. One PR per item, in the order above. Keep each diff under `limits.maxDiffLines` (300).
3. Hard rules for these PRs:
   - Zero dependencies; child processes only through `runProcess` with argv arrays.
   - Do not touch `src/ledger.mjs`, `src/decide.mjs`, `src/prove.mjs`, `src/tamper.mjs`, `src/land.mjs`, `src/commands/apply.mjs`, `templates/**`, `action.yml` or `benchmarks/**`.
   - Add a new `tests/*.test.mjs` file per item. Editing an existing test file is the `existingTestEdited` tamper rule on an agent PR.
   - New fields are extra keys on ledger outcomes. `validateOutcome` ignores unknown keys, and `trustFor` must return the same result with and without them; each item asserts that.
   - Update `CHANGELOG.md` under `[Unreleased]` in the same change.
4. Run `npm test` (never `node --test tests/` on the directory).
5. Useful facts already checked:
   - `tests/structure.test.mjs` checks that listed exports exist; a new export in `src/adapters/git.mjs` does not break it.
   - `tests/retro.test.mjs` matches `formatRetro` output by regex and never compares whole group objects, so new fields and one new line are safe.
   - `settle` is called in existing tests with a `prState` stub that returns only `state`, `mergedAt` and `mergeCommit`; new inputs must be optional.
   - The sync workflow checks out with `fetch-depth: 0` and commits the whole ledger directory, so no workflow change is needed.

## 9. Open questions

- Can the sync workflow's token (`contents: write`, `issues: write`) read a PR's close event through `repos/{repo}/issues/{n}/events` on a private repo? MP-122 falls back to null if not.
- `ahmed-3m` is both the maintainer and an agent login, so a close of their own `agent/` PR reads as an author close. MP-122 only says something about PRs opened by `mergeproof-bot`. Is that enough data, or should maintainer-authored agent PRs be measured another way?
- Which tags count as releases in a user's repo? MP-124 records any tag; enforcing settle-at-release would need a config pattern.
- Can the bot account push tags? If so, settle-at-release is steerable and needs a ruleset.
- What separates "rejected" from "superseded" when a maintainer closes a PR?
- Asset files (for example `assets/logo/**`) appear to classify as source, so a `docs:` logo PR is a kind mismatch. Confirm against PR 64's file list, then decide whether `paths.docs` should cover them.
- Human steps outside the decision table are not addressed here: the `agent` label that starts a run, exhausted retries, automatic re-check when CI was pending or the base was red, and merges of reflector PRs.
