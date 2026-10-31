// MP-117: `.mergeproof/lessons.md` is the persistent improvement harness —
// agents read it right after the skill, and it is a gate file. These tests
// pin the repo invariants (the file exists and documents its format; this
// repo's config lists it under paths.humanOnly, with commit-verified trust
// on) and the gate behavior through the real evaluate(): an agent PR that
// edits the lessons file is HUMAN even when `docs` is fully trusted, while
// an ordinary docs PR on the same trusted repo merges.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRepo, BASE_FILES } from './fixtures/repo.mjs';
import { evaluate } from '../src/commands/check.mjs';
import { parseConfig } from '../src/config.mjs';

const LESSONS = ['# Lessons', '', '- [L-1] Write the failing test first (evidence: #101).', ''].join('\n');

// A ledger that fully trusts docs for this agent/model: ten settled clean
// outcomes (minOutcomes 10, minCleanRate 0.9 by default).
function trustedDocsLedger() {
  return {
    schema: 'mergeproof-ledger@1',
    outcomes: Array.from({ length: 10 }, (_, i) => ({
      pr: i + 1,
      kind: 'docs',
      agent: 'claude-code',
      model: 'glm-5.2',
      skill: null,
      attempts: 1,
      verdict: 'MERGE',
      provenAt: '2026-09-01T10:00:00Z',
      mergedAt: `2026-09-${String(i + 1).padStart(2, '0')}T10:00:00Z`,
      mergeCommit: null,
      status: 'clean',
    })),
  };
}

// A repo like this one: docs globs by default, a lessons file listed under
// paths.humanOnly. `gatePath` picks where the lessons file lives.
function setup(lessonsPath) {
  const configText = JSON.stringify({
    testCommand: 'node --test',
    testFileCommand: 'node --test',
    paths: { humanOnly: [lessonsPath] },
  });
  const repo = createRepo({ ...BASE_FILES, '.mergeproof.json': configText, [lessonsPath]: LESSONS });
  const config = parseConfig(configText);
  const baseSha = repo.git(['rev-parse', 'HEAD']);
  return { repo, config, baseSha };
}

function gate({ repo, config, baseSha }, change, message) {
  repo.branch('agent/docs').write(change);
  const headSha = repo.commit(message);
  repo.git(['checkout', '--quiet', 'main']);
  return evaluate({
    root: repo.dir,
    baseSha,
    headSha,
    config,
    claims: { title: message, subjects: [message] },
    ci: 'green',
    issueLabels: [],
    agent: 'claude-code',
    model: 'glm-5.2',
    ledger: trustedDocsLedger(),
  });
}

test('this repo ships .mergeproof/lessons.md and gates it as human-only', () => {
  const file = resolve('.mergeproof/lessons.md');
  assert.ok(existsSync(file), '.mergeproof/lessons.md must exist');
  const text = readFileSync(file, 'utf8');
  assert.match(text, /- \[L-\d+\] .+\(evidence: #\d+(, #\d+)*\)/, 'the file documents its lesson-line format with a live example');
  assert.match(text, /read-only|never\s+(?:edit|write|add)/i, 'the file tells coding agents they never write it');
  const config = JSON.parse(readFileSync(resolve('.mergeproof.json'), 'utf8'));
  assert.ok(config.paths.humanOnly.includes('.mergeproof/lessons.md'), 'paths.humanOnly lists the lessons file');
  assert.equal(config.trust.verifyCommits, true, 'this repo anchors ledger trust in git history');
});

test('an agent PR editing .mergeproof/lessons.md is HUMAN (a gate file, tamper)', () => {
  const lessonsPath = '.mergeproof/lessons.md';
  const { repo, ...ctx } = setup(lessonsPath);
  try {
    const result = gate({ repo, ...ctx }, { [lessonsPath]: `${LESSONS}- [L-2] Also write the fix first. (evidence: #102)\n` }, 'docs: add a lesson');
    assert.equal(result.kind, 'docs', 'the lessons file is markdown, so the paths say docs');
    assert.equal(result.verdict.verdict, 'HUMAN');
    assert.ok(result.verdict.notes.some((n) => /lessons\.md/.test(n.text)), 'a note names the lessons file');
  } finally {
    repo.cleanup();
  }
});

test('a humanOnly lessons path is HUMAN even when docs is trusted (the hold, not tamper)', () => {
  // Outside .mergeproof/ the gate-file rule does not fire: only the
  // humanOnly hold stands between a trusted docs bucket and the merge.
  const lessonsPath = 'docs/lessons.md';
  const { repo, ...ctx } = setup(lessonsPath);
  try {
    const result = gate({ repo, ...ctx }, { [lessonsPath]: `${LESSONS}- [L-2] Also write the fix first. (evidence: #102)\n` }, 'docs: record a lesson');
    assert.equal(result.kind, 'docs');
    assert.deepEqual(result.tamperNotes, [], 'no tamper: only the human-only hold decides');
    assert.equal(result.trust.trusted, true, 'docs IS trusted — the HUMAN comes from the hold');
    assert.equal(result.verdict.verdict, 'HUMAN');
    assert.match(result.verdict.notes[0].text, /human-only path: docs\/lessons\.md/);
  } finally {
    repo.cleanup();
  }
});

test('control: an ordinary docs PR on the same trusted repo merges', () => {
  const lessonsPath = 'docs/lessons.md';
  const { repo, ...ctx } = setup(lessonsPath);
  try {
    const result = gate({ repo, ...ctx }, { 'README.md': '# Fixture\n\nDocs only.\n' }, 'docs: write the readme');
    assert.equal(result.kind, 'docs');
    assert.equal(result.trust.trusted, true);
    assert.equal(result.verdict.verdict, 'MERGE');
  } finally {
    repo.cleanup();
  }
});
