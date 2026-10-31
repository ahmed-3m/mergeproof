// MP-104: apply reads the @2 verdict file's structured reasons, re-derives
// what it can (NO_NEW_TEST, CI_RED), validates the rest against the
// re-derived world (a known code, a path among the re-derived added test
// files, counts that fit the config) and renders the text itself. Reasons
// never feed decide(): a forged reason keeps RETRY and renders "suspect",
// and a @1 file with no reasons lands on the generic weak note. Real git
// repos, a fake `gh`, a captured printer (tests/apply.test.mjs style).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRepo, testFile, FIXED_MATH, BASE_FILES } from './fixtures/repo.mjs';
import { runCheck, defaultDeps as checkDeps } from '../src/commands/check.mjs';
import { runApply } from '../src/commands/apply.mjs';
import { checksState, parsePrUrl } from '../src/adapters/gh.mjs';
import { readLedger } from '../src/ledger.mjs';
import { readVerdictFile } from '../src/verdictfile.mjs';

const URL = 'https://github.com/acme/app/pull/77';
const DEMO = resolve('demo/ledger.json');
const GREEN = [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const RED = [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }];

function fakeGh({ headSha, baseSha, author = 'agent-bot', headRef = 'agent/fix', isFork = false, state = 'OPEN', labels = ['bug'], checks = GREEN, title = 'fix: mul by 3' }) {
  const calls = { merge: [], comment: [], label: [], issueLabels: [] };
  let merged = null;
  return {
    calls,
    parsePrUrl,
    getPullRequest: () => ({
      number: 77, url: URL, title, author, state: merged ? 'MERGED' : state, headRef, headSha, baseRef: 'main', baseSha,
      labels: [], subjects: [title], isFork, mergeCommit: merged, mergedAt: merged ? '2026-10-22T12:00:00Z' : null, checks,
    }),
    getChecksStatus: () => checksState(checks),
    issueLabels: (url, numbers) => {
      calls.issueLabels.push(numbers);
      return labels;
    },
    squashMerge: (url, opts) => {
      calls.merge.push(opts);
      merged = 'f'.repeat(40);
    },
    comment: (url, body) => calls.comment.push(body),
    addLabel: (url, label) => calls.label.push(label),
    createIssue: () => assert.fail('apply never opens issues'),
  };
}

// A bugfix whose new test passes on base (it asserts the buggy behavior), so
// the gate's proof is weak for NEW_TEST_PASSES_ON_BASE.
const BASE_PASS_TEST = testFile('mul by 3', ['assert.equal(mul(3, 2), 7);']);
const WEAK_CHANGE = { 'src/math.mjs': FIXED_MATH, 'tests/mul.test.mjs': BASE_PASS_TEST };
// The honest fix: the new test fails on base and passes on head.
const HONEST_CHANGE = { 'src/math.mjs': FIXED_MATH, 'tests/mul.test.mjs': testFile('mul by 3', ['assert.equal(mul(3, 2), 6);']) };
// A bugfix without any new test file (only a support file under tests/): the
// gate's proof is weak for NO_NEW_TEST.
const NO_TEST_CHANGE = { 'src/math.mjs': FIXED_MATH, 'tests/helpers/util.mjs': 'export const noop = () => {};\n' };

function setup(config = {}, change = WEAK_CHANGE, message = 'fix: mul by 3') {
  const gate = { testCommand: 'node --test', testFileCommand: 'node --test', agents: { logins: ['agent-bot'], branchPrefixes: ['agent/'] }, ...config };
  const repo = createRepo({ ...BASE_FILES, '.mergeproof.json': JSON.stringify(gate) });
  const baseSha = repo.git(['rev-parse', 'HEAD']);
  repo.branch('agent/fix').write(change);
  const headSha = repo.commit(message);
  repo.git(['checkout', '--quiet', 'main']);
  const ledger = join(repo.dir, '.mergeproof', 'ledger.json');
  mkdirSync(join(repo.dir, '.mergeproof'), { recursive: true });
  copyFileSync(DEMO, ledger);
  return { repo, baseSha, headSha, ledger };
}

function deps(repo, gh, out) {
  return {
    ...checkDeps,
    git: {
      ...checkDeps.git,
      // The fixture has no origin: fake the fetch by pointing the requested
      // refs at the local branches they stand for.
      fetch: (root, refspecs) => {
        const local = { 'refs/mergeproof/base': 'main', 'refs/mergeproof/head': 'agent/fix' };
        for (const rs of refspecs) {
          const dst = rs.replace(/^\+/, '').split(':')[1];
          repo.git(['update-ref', dst, repo.git(['rev-parse', local[dst]])]);
        }
      },
    },
    gh,
    cwd: () => repo.dir,
    now: () => new Date('2026-10-22T12:00:00Z'),
    print: (s) => out.push(s),
  };
}

const AGENT = ['--agent', 'claude-code', '--model', 'glm-5.2', '--skill', 'bugfix@1'];
const PR_ARGS = [...AGENT, '--issue', '3'];

/** The verdict file the gate honestly produced, as JSON text (restored per forgery). */
function gateFile(repo, baseSha, headSha, extraChecks = {}) {
  const file = join(repo.dir, 'verdict.json');
  const out = [];
  const gh = fakeGh({ baseSha, headSha, ...extraChecks });
  return { file, gh, out, run: () => runCheck([URL, ...PR_ARGS, '--verdict-out', file], deps(repo, gh, out)) };
}

/** Rewrite a field of a verdict file the gate honestly produced (the forgery). */
function forge(file, mutate) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  mutate(data);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return file;
}

test('@2 round-trip: a weak gate run hands its reasons to apply, which renders them under the RETRY header', async () => {
  const { repo, baseSha, headSha, ledger } = setup({ mode: 'enforce' });
  try {
    const gate = gateFile(repo, baseSha, headSha);
    assert.equal(await gate.run(), 3, gate.out.join('\n'));
    // The file the gate wrote carries the structured reason, not free text.
    const v = readVerdictFile(gate.file);
    assert.equal(v.schema, 'mergeproof-verdict@2');
    assert.deepEqual(v.reasons, [{ code: 'NEW_TEST_PASSES_ON_BASE', path: 'tests/mul.test.mjs' }]);

    const gh = fakeGh({ baseSha, headSha });
    const out = [];
    assert.equal(await runApply([gate.file, '--pr', URL, ...PR_ARGS], deps(repo, gh, out)), 3, out.join('\n'));
    assert.deepEqual([gh.calls.merge.length, gh.calls.label.length], [0, 0], 'RETRY merges and labels nothing');
    assert.equal(gh.calls.comment.length, 1);
    const comment = gh.calls.comment[0];
    assert.match(comment, /Mergeproof — RETRY \(kind: bugfix\)/);
    assert.match(comment, /new test tests\/mul\.test\.mjs passes on base, so it proves nothing/);
    assert.equal(readLedger(ledger).outcomes.length, 20, 'weak proof is not logged');
  } finally {
    repo.cleanup();
  }
});

test('a forged reason keeps RETRY and renders "suspect": reasons never feed decide()', async () => {
  const { repo, baseSha, headSha, ledger } = setup({ mode: 'enforce' });
  try {
    const gate = gateFile(repo, baseSha, headSha);
    assert.equal(await gate.run(), 3, gate.out.join('\n'));
    const honest = readFileSync(gate.file, 'utf8');
    const cases = [
      ['forged code', (d) => { d.reasons = [{ code: 'FOO_BAR' }]; }],
      ['path outside the re-derived added tests', (d) => { d.reasons = [{ code: 'NEW_TEST_PASSES_ON_BASE', path: 'tests/not-in-diff.test.mjs' }]; }],
      ['n >= m', (d) => { d.reasons = [{ code: 'FLAKY_ON_BASE', path: 'tests/mul.test.mjs', n: 2, m: 2 }]; }],
      ['NO_NEW_TEST claimed although the PR adds a test', (d) => { d.reasons = [{ code: 'NO_NEW_TEST' }]; }],
      ['CI_RED claimed although CI is green', (d) => { d.reasons = [{ code: 'CI_RED' }]; }],
      ['DIFF_UNCOVERED claimed when minDiffCoverage is 0', (d) => { d.reasons = [{ code: 'DIFF_UNCOVERED', pct: 10, minPct: 80 }]; }],
      ['SUITE_RED_ON_BASE claimed on a RETRY verdict', (d) => { d.reasons = [{ code: 'SUITE_RED_ON_BASE' }]; }],
    ];
    for (const [name, mutate] of cases) {
      writeFileSync(gate.file, honest);
      forge(gate.file, mutate);
      const gh = fakeGh({ baseSha, headSha });
      const out = [];
      assert.equal(await runApply([gate.file, '--pr', URL, ...PR_ARGS], deps(repo, gh, out)), 3, `${name}: ${out.join('\n')}`);
      assert.equal(gh.calls.comment.length, 1, name);
      const comment = gh.calls.comment[0];
      assert.match(comment, /Mergeproof — RETRY \(kind: bugfix\)/, `${name}: the verdict is unchanged`);
      assert.match(comment, /gate reported an unverifiable reason \(suspect\)/, name);
      // The file's own words never reach the PR: neither the forged payload
      // nor the honest note text it still carries is posted.
      assert.ok(!comment.includes('FOO_BAR'), name);
      assert.ok(!comment.includes('passes on base'), name);
      assert.ok(!comment.includes('no new test file'), name);
      assert.deepEqual([gh.calls.merge.length, gh.calls.label.length], [0, 0], name);
      assert.equal(readLedger(ledger).outcomes.length, 20, `${name}: nothing logged`);
    }
  } finally {
    repo.cleanup();
  }
});

test('a @1 verdict file with no reasons key still lands cleanly on the generic weak note', async () => {
  const { repo, baseSha, headSha, ledger } = setup({ mode: 'enforce' });
  try {
    const gate = gateFile(repo, baseSha, headSha);
    assert.equal(await gate.run(), 3, gate.out.join('\n'));
    forge(gate.file, (d) => {
      d.schema = 'mergeproof-verdict@1';
      delete d.reasons;
    });
    const gh = fakeGh({ baseSha, headSha });
    const out = [];
    assert.equal(await runApply([gate.file, '--pr', URL, ...PR_ARGS], deps(repo, gh, out)), 3, out.join('\n'));
    assert.equal(gh.calls.comment.length, 1);
    assert.match(gh.calls.comment[0], /Mergeproof — RETRY \(kind: bugfix\)/);
    assert.match(gh.calls.comment[0], /proof was weak when the gate ran/);
    assert.deepEqual([gh.calls.merge.length, gh.calls.label.length], [0, 0]);
    assert.equal(readLedger(ledger).outcomes.length, 20);
  } finally {
    repo.cleanup();
  }
});

test('apply re-derives CI_RED itself: a RETRY from red CI posts the re-derived note', async () => {
  const { repo, baseSha, headSha } = setup({ mode: 'enforce' }, HONEST_CHANGE);
  try {
    const gate = gateFile(repo, baseSha, headSha, { checks: RED });
    assert.equal(await gate.run(), 3, gate.out.join('\n'));
    assert.deepEqual(readVerdictFile(gate.file).reasons, [{ code: 'CI_RED' }]);
    const gh = fakeGh({ baseSha, headSha, checks: RED });
    const out = [];
    assert.equal(await runApply([gate.file, '--pr', URL, ...PR_ARGS], deps(repo, gh, out)), 3, out.join('\n'));
    assert.match(gh.calls.comment[0], /Mergeproof — RETRY \(kind: bugfix\)/);
    assert.match(gh.calls.comment[0], /CI is red/);
  } finally {
    repo.cleanup();
  }
});

test('apply re-derives NO_NEW_TEST itself: a support file under tests/ proves nothing', async () => {
  const { repo, baseSha, headSha } = setup({ mode: 'enforce' }, NO_TEST_CHANGE);
  try {
    const gate = gateFile(repo, baseSha, headSha);
    assert.equal(await gate.run(), 3, gate.out.join('\n'));
    assert.deepEqual(readVerdictFile(gate.file).reasons, [{ code: 'NO_NEW_TEST' }]);
    const gh = fakeGh({ baseSha, headSha });
    const out = [];
    assert.equal(await runApply([gate.file, '--pr', URL, ...PR_ARGS], deps(repo, gh, out)), 3, out.join('\n'));
    assert.match(gh.calls.comment[0], /Mergeproof — RETRY \(kind: bugfix\)/);
    assert.match(gh.calls.comment[0], /no new test file to prove the change/);
  } finally {
    repo.cleanup();
  }
});
