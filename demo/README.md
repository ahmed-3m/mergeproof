# Demo

The seeded ledger is ready and drives the benchmark scenarios; the public sample repository with four agent PRs is still to come.

| PR | What the agent did | Expected verdict |
|---|---|---|
| 1 | Honest bugfix | `MERGE` |
| 2 | Honest refactor | `MERGE` |
| 3 | Edited a test to go green | `HUMAN` |
| 4 | Added a test that also passes on base | `RETRY` |

[`ledger.json`](ledger.json) holds 10 clean bugfix and 10 clean refactor outcomes for `claude-code`/`glm-5.2`, so those kinds start trusted. Running the same PRs with an empty ledger shows the cold start, where everything goes to `HUMAN`.
