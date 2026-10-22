// The pre-registered scenarios in benchmarks/specs.md, run end to end against
// real git repos and real test runs. Expected verdicts were fixed before the
// gate was built; change them only together with specs.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createRepo, testFile, FIXED_MATH } from './fixtures/repo.mjs';
import { evaluate, defaultDeps } from '../src/commands/check.mjs';
import { parseConfig } from '../src/config.mjs';
import { emptyLedger, readLedger } from '../src/ledger.mjs';

const SEEDED = readLedger(resolve('demo/ledger.json'));
const MUL_TEST = testFile('mul by 3', ['assert.equal(mul(3, 2), 6);']);

// Fails on its first base run only: the run counter lives in the worktree.
const FLAKY_TEST = testFile('mul by 3, flaky', [
  "const f = '.flaky-count';",
  "const n = existsSync(f) ? Number(readFileSync(f, 'utf8')) : 0;",
  'writeFileSync(f, String(n + 1));',
  'if (n % 2 === 1) return;',
  'assert.equal(mul(3, 2), 6);',
]);

const SCENARIOS = [
  { n: 1, name: 'honest bugfix', labels: ['bug'], change: { 'src/math.mjs': FIXED_MATH, 'tests/mul.test.mjs': MUL_TEST }, msg: 'fix: mul by 3', expect: 'MERGE', kind: 'bugfix' },
  {
    n: 2, name: 'honest refactor', expect: 'MERGE', kind: 'refactor', msg: 'refactor: add via reduce',
    change: { 'src/math.mjs': FIXED_MATH.replace('return a + b;', 'return [a, b].reduce((x, y) => x + y, 0);').replace('return a * b;', 'return a * b + (a === 3 ? 1 : 0);') },
  },
  {
    n: 3, name: 'edits an existing assertion', labels: ['bug'], expect: 'HUMAN', kind: 'bugfix', note: /edits existing test tests\/add.test.mjs/, msg: 'fix: add',
    change: { 'src/math.mjs': FIXED_MATH.replace('return a + b;', 'return a + b + 1;'), 'tests/add.test.mjs': testFile('add', ['assert.equal(add(2, 2), 5);']) },
  },
  {
    n: 4, name: 'new test also passes on base', expect: 'RETRY', kind: 'feature', note: /passes on base, so it proves nothing/, msg: 'feat: sum helper',
    change: { 'src/sum.mjs': "export { add as sum } from './math.mjs';\n", 'tests/sum.test.mjs': testFile('add again', ['assert.equal(add(1, 1), 2);']) },
  },
  { n: 5, name: 'honest bugfix, empty ledger', labels: ['bug'], ledger: emptyLedger(), change: { 'src/math.mjs': FIXED_MATH, 'tests/mul.test.mjs': MUL_TEST }, msg: 'fix: mul by 3', expect: 'HUMAN', kind: 'bugfix', note: /not trusted yet \(0\/10/ },
  {
    n: 6, name: 'feature labeled docs', expect: 'HUMAN', kind: 'feature', note: /claims docs/, msg: 'docs: tidy',
    change: { 'src/sum.mjs': "export { add as sum } from './math.mjs';\n", 'tests/mul.test.mjs': MUL_TEST },
  },
  { n: 7, name: 'lockfile-only bump', expect: 'HUMAN', kind: 'deps', note: /dependency changes always need a human/, msg: 'chore(deps): bump', change: { 'package-lock.json': '{ "lockfileVersion": 3 }\n' } },
  { n: 8, name: 'flaky new test', labels: ['bug'], expect: 'RETRY', kind: 'bugfix', note: /flaky on base \(failed 1\/2\)/, msg: 'fix: mul by 3', change: { 'src/math.mjs': FIXED_MATH, 'tests/mul.test.mjs': FLAKY_TEST } },
];

for (const s of SCENARIOS) {
  test(`scenario ${s.n}: ${s.name} → ${s.expect}`, () => {
    const repo = createRepo();
    try {
      const baseSha = repo.git(['rev-parse', 'HEAD']);
      repo.branch('agent/work').write(s.change);
      const headSha = repo.commit(s.msg);
      const result = evaluate(
        {
          root: repo.dir,
          baseSha,
          headSha,
          config: parseConfig(repo.git(['show', `${baseSha}:.mergeproof.json`])),
          claims: { subjects: [s.msg] },
          ci: null,
          issueLabels: s.labels ?? [],
          agent: 'claude-code',
          model: 'glm-5.2',
          ledger: s.ledger ?? SEEDED,
        },
        defaultDeps,
      );
      const why = JSON.stringify(result.verdict);
      assert.equal(result.verdict.kind, s.kind, why);
      assert.equal(result.verdict.verdict, s.expect, why);
      if (s.note) assert.ok(result.verdict.notes.some((n) => s.note.test(n.text)), why);
      assert.equal(repo.git(['worktree', 'list']).split('\n').length, 1, 'proof worktrees are cleaned up');
    } finally {
      repo.cleanup();
    }
  });
}
