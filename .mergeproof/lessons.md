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

