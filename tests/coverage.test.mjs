// Diff-line coverage (proof.minDiffCoverage): the pure parser and merger in
// src/coverage.mjs, then the whole gate on real git repos — a refactor or
// feature whose tests never execute the added code is a weak proof (RETRY),
// and an honest change whose tests do still merges.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { addedLineNumbers, coveredLinesFromV8, computeDiffCoverage } from '../src/coverage.mjs';
import { createRepo, testFile, FIXED_MATH, BASE_FILES } from './fixtures/repo.mjs';
import { evaluate, defaultDeps } from '../src/commands/check.mjs';
import { parseConfig } from '../src/config.mjs';
import { readLedger } from '../src/ledger.mjs';

const SEEDED = readLedger(resolve('demo/ledger.json'));
const UNCOVERED_NOTE = /diff line coverage is \d+% \(needs 80%\)/;

test('addedLineNumbers reads multi-file, multi-hunk diffs, with or without context', () => {
  const withContext = [
    'diff --git a/src/one.mjs b/src/one.mjs',
    'index 111..222 100644',
    '--- a/src/one.mjs',
    '+++ b/src/one.mjs',
    '@@ -1,4 +1,5 @@',
    ' keep1', // context: head line 1
    '-old1',
    '+new1', // added: head line 2
    ' keep2', // context: head line 3
    '+new2', // added: head line 4
    ' keep3', // context: head line 5
    '@@ -10,2 +12,3 @@',
    ' keepA', // context: head line 12
    '+inserted', // added: head line 13
    ' keepB', // context: head line 14
    'diff --git a/gone.txt b/gone.txt',
    'deleted file mode 100644',
    '--- a/gone.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-bye',
    'diff --git a/two.js b/two.js',
    '--- a/two.js',
    '+++ b/two.js',
    '@@ -0,0 +1,2 @@',
    '+const a = 1;',
    '+const b = 2;',
  ].join('\n');
  assert.deepEqual(addedLineNumbers(withContext), { 'src/one.mjs': [2, 4, 13], 'two.js': [1, 2] }, 'deleted files are ignored');

  // -U0: no context lines at all, and a hunk count of 1 may be omitted.
  const u0 = ['+++ b/src/three.mjs', '@@ -3 +3 @@', '-was', '+now', '@@ -9,2 +10 @@', '+at ten'].join('\n');
  assert.deepEqual(addedLineNumbers(u0), { 'src/three.mjs': [3, 10] });
  assert.deepEqual(addedLineNumbers(''), {});
});

// A module with one function the tests call and one they never do, plus a
// brand-new file nothing imports: the three states diff coverage must tell
// apart (executed, defined but dead, never even loaded).
const LIVE = [
  'export function used(x) {',
  '  return x + 1;',
  '}',
  '',
  '// the tests never call this one',
  'export function dead(x) {',
  '  return x * 2;',
  '}',
  '',
].join('\n');
const DEAD = ['export const value = 1;', '', '// dead code', 'export function never() {', '  return 2;', '}', ''].join('\n');

// A V8 script entry for `text` with one range per function: the module range
// [0, length) plus, for each named function, its range and call count.
function v8For(root, path, counts) {
  const text = LIVE; // only live.mjs is ever turned into V8 data here
  const ranges = [{ startOffset: 0, endOffset: text.length, count: 1 }];
  for (const [name, count] of Object.entries(counts)) {
    const at = text.indexOf(`function ${name}`);
    const end = text.indexOf('}', text.indexOf('return', at)) + 1;
    ranges.push({ startOffset: at, endOffset: end, count });
  }
  return { url: pathToFileURL(join(root, path)).href, functions: [{ functionName: '', ranges }] };
}

function coverageRoot() {
  const root = mkdtempSync(join(tmpdir(), 'mp-cov-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'live.mjs'), LIVE);
  writeFileSync(join(root, 'src', 'dead.mjs'), DEAD);
  return root;
}

test('coveredLinesFromV8: the innermost range decides; node: and node_modules never count', () => {
  const root = coverageRoot();
  try {
    const blobs = [
      {
        result: [
          v8For(root, 'src/live.mjs', { used: 4, dead: 0 }),
          { url: 'node:internal/modules/run_main', functions: [{ ranges: [{ startOffset: 0, endOffset: 99, count: 1 }] }] },
        ],
      },
    ];
    const byFile = coveredLinesFromV8(blobs, root);
    const live = byFile['src/live.mjs'];
    assert.ok(live, 'the repo file is kept');
    // executable: lines 1,2 (used) and 6,7 (dead); 3/8 are lone '}', 4 blank, 5 a comment
    assert.deepEqual([...live.executable].sort((a, b) => a - b), [1, 2, 6, 7]);
    assert.deepEqual([...live.covered].sort((a, b) => a - b), [1, 2], 'dead() has count 0, however deep the outer ranges run');
    assert.ok(!('node:internal/modules/run_main' in byFile), 'node internals are dropped');
    assert.ok(!byFile['src/dead.mjs'], 'a file nothing loaded has no entry at all');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('coveredLinesFromV8 merges test processes: covered by any run counts', () => {
  const root = coverageRoot();
  try {
    // node --test spawns one process per file: each blob is one process, and
    // only together do the two runs execute both functions.
    const blobs = [{ result: [v8For(root, 'src/live.mjs', { used: 2, dead: 0 })] }, { result: [v8For(root, 'src/live.mjs', { used: 0, dead: 5 })] }];
    const live = coveredLinesFromV8(blobs, root)['src/live.mjs'];
    assert.deepEqual([...live.covered].sort((a, b) => a - b), [1, 2, 6, 7]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('computeDiffCoverage: added executable lines only, unimported files count as uncovered', () => {
  const root = coverageRoot();
  try {
    const v8Coverage = [{ result: [v8For(root, 'src/live.mjs', { used: 4, dead: 0 })] }];
    const input = (over = {}) => ({
      addedLinesByFile: { 'src/live.mjs': [1, 2, 4, 6, 7], 'src/dead.mjs': [1, 2, 3, 4, 5] },
      sourceFiles: ['src/live.mjs', 'src/dead.mjs'],
      v8Coverage,
      repoRoot: root,
      ...over,
    });
    // live: 4 added executable (1,2,6,7), 2 covered. dead: never loaded, so
    // its added executable lines (1,4,5 — not the blank or the comment) are
    // all uncovered. 2/7 covered.
    assert.deepEqual(computeDiffCoverage(input()), { total: 7, covered: 2, ratio: 2 / 7 });
    // Only changed source files count: drop dead.mjs and the ratio recovers.
    assert.deepEqual(computeDiffCoverage(input({ sourceFiles: ['src/live.mjs'] })), { total: 4, covered: 2, ratio: 0.5 });
    // Nothing executable added → ratio is 1, never a failure.
    assert.deepEqual(computeDiffCoverage(input({ addedLinesByFile: { 'src/live.mjs': [3, 4, 5] } })), { total: 0, covered: 0, ratio: 1 });
    assert.deepEqual(computeDiffCoverage(input({ sourceFiles: [] })), { total: 0, covered: 0, ratio: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A ~20-line uncalled function: enough added executable lines that a covered
// one or two elsewhere cannot reach 80%.
const GOLDBACH = [
  '',
  '// A sieve the tests never call.',
  'export function goldbach(n) {',
  '  const sieve = new Array(n + 1).fill(true);',
  '  for (let i = 2; i * i <= n; i++) {',
  '    if (!sieve[i]) continue;',
  '    for (let j = i * i; j <= n; j += i) sieve[j] = false;',
  '  }',
  '  const primes = [];',
  '  for (let i = 2; i <= n; i++) {',
  '    if (sieve[i]) primes.push(i);',
  '  }',
  '  for (let a = 0; a < primes.length; a++) {',
  '    for (let b = a; b < primes.length; b++) {',
  '      if (primes[a] + primes[b] === n) return [primes[a], primes[b]];',
  '    }',
  '  }',
  '  return null;',
  '}',
  '',
].join('\n');

function coverageRepo() {
  const repo = createRepo(undefined, { proof: { minDiffCoverage: 0.8 } });
  const baseSha = repo.git(['rev-parse', 'HEAD']);
  const config = parseConfig(repo.git(['show', `${baseSha}:.mergeproof.json`]));
  const gate = (change, message, labels = []) => {
    repo.git(['checkout', '--quiet', '-B', 'agent/work', baseSha]);
    repo.write(change);
    const headSha = repo.commit(message);
    repo.git(['checkout', '--quiet', 'main']);
    return evaluate(
      {
        root: repo.dir, baseSha, headSha, config,
        claims: { subjects: [message] }, ci: null, issueLabels: labels,
        agent: 'claude-code', model: 'glm-5.2', ledger: SEEDED,
      },
      defaultDeps,
    );
  };
  return { repo, gate };
}

test('a refactor adding a function the suite never calls is a weak proof', () => {
  const { repo, gate } = coverageRepo();
  try {
    // The demo ledger trusts refactor, so without the coverage floor this is
    // a MERGE; with it, the 20 added executable lines never execute.
    const result = gate({ 'src/math.mjs': BASE_FILES['src/math.mjs'] + GOLDBACH }, 'refactor: add goldbach');
    const why = JSON.stringify(result.verdict);
    assert.equal(result.verdict.kind, 'refactor', why);
    assert.equal(result.verdict.verdict, 'RETRY', why);
    assert.ok(result.verdict.notes.some((n) => UNCOVERED_NOTE.test(n.text)), why);
    assert.deepEqual(result.proof.reasons, [{ code: 'DIFF_UNCOVERED', pct: 0, minPct: 80 }], why);
    assert.equal(repo.git(['worktree', 'list']).split('\n').length, 1, 'proof worktrees are cleaned up');
  } finally {
    repo.cleanup();
  }
});

test('a feature whose new test never calls the new code is a weak proof too', () => {
  const { repo, gate } = coverageRepo();
  try {
    // The new test is honest about the bug (fails on base, passes on head)
    // but proves nothing about src/fib.mjs, which nothing ever imports.
    const result = gate(
      { 'src/math.mjs': FIXED_MATH, 'src/fib.mjs': GOLDBACH, 'tests/fib.test.mjs': testFile('mul by 3', ['assert.equal(mul(3, 2), 6);']) },
      'feat: fib',
    );
    const why = JSON.stringify(result.verdict);
    assert.equal(result.verdict.kind, 'feature', why);
    assert.equal(result.verdict.verdict, 'RETRY', why);
    assert.ok(result.verdict.notes.some((n) => UNCOVERED_NOTE.test(n.text)), why);
    assert.ok(result.proof.reasons.some((r) => r.code === 'DIFF_UNCOVERED' && r.pct < 80 && r.minPct === 80), why);
    assert.equal(repo.git(['worktree', 'list']).split('\n').length, 1, 'proof worktrees are cleaned up');
  } finally {
    repo.cleanup();
  }
});

test('honest changes whose tests execute the new code still merge', () => {
  const { repo, gate } = coverageRepo();
  try {
    // Bugfix: the changed line runs in the new test (and the old suite).
    const bugfix = gate(
      { 'src/math.mjs': FIXED_MATH, 'tests/mul.test.mjs': testFile('mul by 3', ['assert.equal(mul(3, 2), 6);']) },
      'fix: mul by 3',
      ['bug'],
    );
    assert.equal(bugfix.verdict.verdict, 'MERGE', JSON.stringify(bugfix.verdict));
    assert.equal(bugfix.proof.ok, true);

    // Refactor: the rewritten line runs in the existing suite.
    const refactor = gate(
      { 'src/math.mjs': BASE_FILES['src/math.mjs'].replace('return a + b;', 'return [a, b].reduce((x, y) => x + y, 0);') },
      'refactor: add via reduce',
    );
    const why = JSON.stringify(refactor.verdict);
    assert.equal(refactor.verdict.kind, 'refactor', why);
    assert.equal(refactor.verdict.verdict, 'MERGE', why);
    assert.ok(refactor.verdict.notes.every((n) => n.ok), why);
    assert.equal(repo.git(['worktree', 'list']).split('\n').length, 1, 'proof worktrees are cleaned up');
  } finally {
    repo.cleanup();
  }
});

test('minDiffCoverage is off by default: the pre-registered scenarios behave identically', () => {
  // The demo ledger trusts refactor; an uncalled function is no proof failure
  // unless the repo opted into the coverage floor.
  const repo = createRepo();
  try {
    const baseSha = repo.git(['rev-parse', 'HEAD']);
    repo.branch('agent/refactor').write({ 'src/math.mjs': BASE_FILES['src/math.mjs'] + GOLDBACH });
    const headSha = repo.commit('refactor: add goldbach');
    const result = evaluate(
      {
        root: repo.dir, baseSha, headSha,
        config: parseConfig(repo.git(['show', `${baseSha}:.mergeproof.json`])),
        claims: { subjects: ['refactor: add goldbach'] }, ci: null, issueLabels: [],
        agent: 'claude-code', model: 'glm-5.2', ledger: SEEDED,
      },
      defaultDeps,
    );
    assert.equal(result.verdict.verdict, 'MERGE', JSON.stringify(result.verdict));
    assert.equal(result.proof.ok, true);
  } finally {
    repo.cleanup();
  }
});
