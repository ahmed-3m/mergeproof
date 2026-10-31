# Lessons

What mergeproof runs learned in this repo, kept so the next run starts
smarter. A coding agent reads this file right after its skill; it never
writes here — `.mergeproof/lessons.md` is a human-only path, and an agent
pull request that edits it goes to a human, however good the rest of the
diff is. Lessons are added by a maintainer (or the reviewed reflect-publish
job), each with the pull requests that taught it.

Format — one lesson per line, numbered, evidence last:

```markdown
- [L-1] <one-line lesson> (evidence: #101, #102)
```

- `L-n` numbers never change or repeat; new lessons take the next number.
- One line, plain text, no headings, no code blocks.
- Evidence PRs must exist in `.mergeproof/events.jsonl` and share a reason
  code — a lesson nobody can trace to real runs is an opinion, not a lesson.

## Lessons

- [L-1] Read `.mergeproof.json` before writing code: the repo's test paths, `testCommand`, `testFileCommand` and `limits.maxDiffLines` decide what the gate accepts, not your habits. (evidence: #12, #31)
- [L-2] Make the new test fail on base for the exact reported reason before touching source; a test that fails for a different reason proves nothing and burns a retry. (evidence: #7, #22)
- [L-3] Run the full suite before `check --local`: a red suite from an earlier stray edit reads as your regression in the gate's output. (evidence: #14, #40)
