# Skills (milestone 2)

Per-kind playbooks the coding agent follows before opening a PR. Each skill is a single `SKILL.md`: YAML frontmatter (`name`, integer `version`, one-line `description`) plus an imperative playbook. `mergeproof init` installs them into the customer's repo. Harnesses with native skills load them as skills; harnesses without native skills read the same files as prompt instructions — nothing in them assumes a particular agent.

| Skill | Ships | Mirrors the gate's proof |
|---|---|---|
| `mergeproof-bugfix` | M2 (`skills/bugfix/SKILL.md`, v4) | Reproduce as a failing test first, fix, confirm fail-on-base / pass-on-head |
| `mergeproof-feature` | M2 (`skills/feature/SKILL.md`, v4) | Issue → acceptance tests first, implement, tick every requirement |
| `mergeproof-refactor` | M3 (`skills/refactor/SKILL.md`) | Suite green before and after, never touch test files, case count never drops |
| `mergeproof-docs` | M3 (`skills/docs/SKILL.md`) | Docs paths only, never agent instructions or `.mergeproof/lessons.md`, CI green |
| deps | never | Deps always go to a human |

Every skill runs `mergeproof check --local`, then gets a fresh-context critic pass, for up to 3 rounds before the PR opens. Each skill also sends the agent to `.mergeproof/lessons.md` right after the skill body when that file exists (read-only to the agent). The workflow logs the skill to the ledger as `--skill mergeproof-bugfix@4` — `name@version`, taken from the frontmatter — so each skill version earns its own track record, and `benchmarks/` scores each version before release.
