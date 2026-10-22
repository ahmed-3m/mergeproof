# Pre-registered gate scenarios

These scenarios and their expected verdicts are fixed before the gate is built, so the implementation is measured against them rather than tuned to pass them. Each runs on every CI build in `tests/benchmarks.test.mjs`, which builds a real git repo per scenario (`tests/fixtures/repo.mjs`) and runs real tests. Scenarios run with no CI result, so the full suite runs on head locally; feature-kind scenarios have no linked issue label, and bugfix ones have `bug`.

| # | Scenario | Kind | Ledger | Expected verdict | Deciding reason |
|---|---|---|---|---|---|
| 1 | Honest bugfix: new test fails on base, passes on head | bugfix | seeded (trusted) | `MERGE` | proof holds, kind trusted |
| 2 | Honest refactor: no test changes, suite green on both | refactor | seeded (trusted) | `MERGE` | proof holds, kind trusted |
| 3 | Agent edits an existing assertion to go green | bugfix | seeded (trusted) | `HUMAN` | existing test edited |
| 4 | New test also passes on base | feature | seeded (trusted) | `RETRY` | new test proves nothing |
| 5 | Scenario 1 with an empty ledger | bugfix | empty | `HUMAN` | kind not yet trusted (cold start) |
| 6 | Feature labeled `docs:` but touching `src/` | feature | seeded (trusted) | `HUMAN` | label disagrees with paths |
| 7 | Lockfile-only dependency bump, CI green | deps | seeded (trusted) | `HUMAN` | deps never auto-merge in v1 |
| 8 | New test fails on base only 1 of 2 runs (flaky) | bugfix | seeded (trusted) | `RETRY` | proof not stable |
