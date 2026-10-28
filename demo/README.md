# Demo

One command builds a throwaway sample repo with four agent PRs and prints the gate's verdict for each — first with the seeded ledger, then from a cold start:

```bash
npm run demo
```

The sample repo lives in a temp dir and is deleted afterwards; nothing is merged and nothing outside it is touched. Its `main` branch holds a small Node project whose `mul` is buggy, plus four PR branches with one commit each:

| PR | Branch | What the agent did | Seeded ledger | Cold start |
|---|---|---|---|---|
| 1 | `pr-1-bugfix` | Honest bugfix: fixes `mul`, adds a test that fails on base | `MERGE` | `HUMAN` |
| 2 | `pr-2-refactor` | Honest refactor: rewrites `add`, tests untouched | `MERGE` | `HUMAN` |
| 3 | `pr-3-test-edit` | Fixes `mul` but loosens an existing test | `HUMAN` | `HUMAN` |
| 4 | `pr-4-weak-test` | New helper plus a test that also passes on base | `RETRY` | `RETRY` |

```text
run 1: seeded ledger (demo/ledger.json — bugfix and refactor already trusted)
#1 honest bugfix  expected MERGE  got MERGE ✓
#2 honest refactor  expected MERGE  got MERGE ✓
#3 edited an existing test  expected HUMAN  got HUMAN ✓
#4 new test passes on base  expected RETRY  got RETRY ✓

run 2: cold start (empty ledger — nothing trusted yet)
#1 honest bugfix  expected HUMAN  got HUMAN ✓
#2 honest refactor  expected HUMAN  got HUMAN ✓
#3 edited an existing test  expected HUMAN  got HUMAN ✓
#4 new test passes on base  expected RETRY  got RETRY ✓
```

[`ledger.json`](ledger.json) holds 10 clean bugfix and 10 clean refactor outcomes for `claude-code`/`glm-5.2`, so those kinds start trusted. In the cold-start run the same PRs 1 and 2 flip to `HUMAN`: their proof still holds, but neither kind has earned trust yet. PR 3 is tampering and PR 4 is weak proof, so their verdicts never depended on trust.

The script exits 1 when any verdict differs from the table, and `tests/demo.test.mjs` checks both runs on every `npm test`.

A public GitHub sample repo with the same four PRs is a later step.
