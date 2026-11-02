# The mirql bridge

This repository and [mirql](https://github.com/ahmed-3m/mirql) share one
lineage: this repo is the original public prototype of the gate; mirql is the
private factory that carries it forward (`packages/mergeproof/**`). The bridge
connects the two **at the process level only** — no submodules, no
dependencies, nothing automatic lands in either codebase:

```
this repo (public lab)                     mirql (private factory)
──────────────────────                     ────────────────────────
push to main                                tracking issue opens
   │ mirql-upstream-watch                      │ triage → port semantics
   └────────────────────────────────────►      │ red/green reproducer (Law 16)
                                               ▼
                                               mirql's review gate ratifies
                                               the port

release artifacts ◄─────────────────────────  mirql main
   mirql-gate-promote (manual dispatch): exports packages/mergeproof plus its
   transitive packages/core imports as a verified, checksummed tarball
```

Upstream ideas influence the gate only after passing mirql's own review —
never by direct content flow.

## One-time setup (repository owner)

1. **Actions variable** `MIRQL_TARGET_REPO` = the mirql repository slug
   (Settings → Secrets and variables → Actions → Variables). Already set.
2. **Actions secret** `MIRQL_BRIDGE_TOKEN` = a fine-grained personal access
   token (GitHub → Settings → Developer settings → Fine-grained tokens):
   - Repository access: **only** the mirql repository.
   - Permissions: **Contents: Read-only** (promote checkout) and
     **Issues: Read and write** (watch creates tracking issues).
   - Paste it as the `MIRQL_BRIDGE_TOKEN` secret in this repository.

Both workflows degrade to a logged notice and exit green when either value is
missing — the bridge is quiet, never red, until it is configured.

## mirql-upstream-watch

Runs on every push to `main` here plus daily. When this repo's tip advances
past the commit recorded in the newest `upstream:mergeproof`-labeled issue in
mirql, it opens one new tracking issue: commit list, compare link, and a port
checklist mirql's agents work through. State lives in the issue bodies
(`<!-- bridge-tip:<sha> -->` marker) — there is no separate state file to
drift. Re-running with no new commits is a no-op.

## mirql-gate-promote

Manual dispatch (Actions → mirql-gate-promote → Run). Checks out mirql's
`main`, extracts the gate bundle
(`scripts/mirql-bridge/extract-gate.mjs`), verifies every relative import in
the bundle resolves inside the bundle — **without executing any extracted
code** — and attaches `mirql-gate-<shortsha>.tgz` + `SHA256SUMS` to a GitHub
release. `manifest.json` inside the tarball records the source commit and a
SHA-256 per file.

Releases are public: the bundle is gate **code only**. Policies, keys,
ledgers and the constitution never leave mirql.

## Why not a hard connection

mirql's constitution forbids external dependencies (Law 0) and requires the
system to work offline (Law 1); its review gate must be base-authored (Law 7).
A submodule or package dependency would violate all three and hand a public
repository influence over the private trust root. A gated bridge gives the
same outcome — updates on either side reach the other — with every change
ratified by the receiving side's own review.
