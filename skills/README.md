# Skills (milestone 2)

Per-kind playbooks the coding agent follows before opening a PR. `mergeproof init` will install them into the customer's repo as `SKILL.md` files. Harnesses without native skills read the same files as prompt instructions.

| Skill | Ships | Mirrors the gate's proof |
|---|---|---|
| `bugfix` | M2 | Reproduce as a failing test first, fix, confirm fail-on-base / pass-on-head |
| `feature` | M2 | Issue → acceptance tests first, implement, tick every requirement |
| `refactor` | next | Suite before and after, never touch test files |
| `docs` | next | Docs paths only, links and code samples work |
| `deps` | never | Deps always go to a human |

Every skill runs `mergeproof check --local`, then gets a fresh-context critic pass, for up to 3 rounds before the PR opens. The ledger records the skill name and version, and `benchmarks/` scores each version before release.
