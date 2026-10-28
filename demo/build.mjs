// Builds the demo sample repo and runs the gate on its four agent PRs
// (PROTOTYPE.md "Notes", demo/README.md). `npm run demo` prints each verdict
// twice — with the seeded ledger, then from a cold start — and exits 1 if any
// verdict differs from the documented one.
//
// The sample repo is throwaway: a temp dir with a `main` branch holding a
// small Node project whose `mul` is buggy, plus four PR branches, one commit
// each. Nothing is merged and nothing outside the temp dir is touched.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../src/adapters/process.mjs';
import { mergeBase, showFile } from '../src/adapters/git.mjs';
import { evaluate, defaultDeps } from '../src/commands/check.mjs';
import { CONFIG_FILE, parseConfig } from '../src/config.mjs';
import { emptyLedger, readLedger } from '../src/ledger.mjs';

const AGENT = 'claude-code';
const MODEL = 'glm-5.2';

const BASE_MATH = [
  'export function add(a, b) {',
  '  return a + b;',
  '}',
  '',
  '// Bug: multiplying by 3 is off by one.',
  'export function mul(a, b) {',
  '  return a * b + (a === 3 ? 1 : 0);',
  '}',
  '',
].join('\n');

// PR 1 and PR 3 fix the bug; only PR 1 proves it with a new test.
const FIXED_MATH = BASE_MATH.replace('// Bug: multiplying by 3 is off by one.\n', '').replace(' + (a === 3 ? 1 : 0)', '');

// PR 2 rewrites add() without changing behaviour, and leaves mul() as-is.
const REFACTOR_MATH = BASE_MATH.replace('return a + b;', 'return [a, b].reduce((x, y) => x + y, 0);');

const ADD_TEST = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { add } from '../src/math.mjs';",
  '',
  "test('add', () => {",
  '  assert.equal(add(2, 2), 4);',
  '});',
  '',
].join('\n');

// PR 3's edit: the agent loosens the existing assertion so the suite stays green.
const LOOSE_ADD_TEST = ADD_TEST.replace('assert.equal(add(2, 2), 4);', 'assert.ok(add(2, 2) == 4); // loosened to keep the suite green');

// Fails on base (mul(3, 2) is 7 there), passes on head — real proof.
const MUL_TEST = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { mul } from '../src/math.mjs';",
  '',
  "test('mul by 3', () => {",
  '  assert.equal(mul(3, 2), 6);',
  '});',
  '',
].join('\n');

// PR 4's test exercises add(), not the new sum helper, so it passes on base too.
const SUM_TEST = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { add } from '../src/math.mjs';",
  '',
  "test('sum helper', () => {",
  '  assert.equal(add(1, 1), 2);',
  '});',
  '',
].join('\n');

const BASE_FILES = {
  'package.json': `${JSON.stringify({ name: 'mergeproof-demo', type: 'module', private: true }, null, 2)}\n`,
  '.mergeproof.json': `${JSON.stringify({ testCommand: 'node --test', testFileCommand: 'node --test' }, null, 2)}\n`,
  'src/math.mjs': BASE_MATH,
  'tests/add.test.mjs': ADD_TEST,
};

const PRS = [
  {
    number: 1, branch: 'pr-1-bugfix', name: 'honest bugfix',
    title: 'fix: mul by 3 was off by one', issueLabels: ['bug'], expected: { seeded: 'MERGE', cold: 'HUMAN' },
    files: { 'src/math.mjs': FIXED_MATH, 'tests/mul.test.mjs': MUL_TEST },
  },
  {
    number: 2, branch: 'pr-2-refactor', name: 'honest refactor',
    title: 'refactor: compute add with reduce', issueLabels: [], expected: { seeded: 'MERGE', cold: 'HUMAN' },
    files: { 'src/math.mjs': REFACTOR_MATH },
  },
  {
    number: 3, branch: 'pr-3-test-edit', name: 'edited an existing test',
    title: 'fix: mul by 3 was off by one', issueLabels: ['bug'], expected: { seeded: 'HUMAN', cold: 'HUMAN' },
    files: { 'src/math.mjs': FIXED_MATH, 'tests/add.test.mjs': LOOSE_ADD_TEST },
  },
  {
    number: 4, branch: 'pr-4-weak-test', name: 'new test passes on base',
    title: 'feat: add sum helper', issueLabels: [], expected: { seeded: 'RETRY', cold: 'RETRY' },
    files: { 'src/sum.mjs': "export { add as sum } from './math.mjs';\n", 'tests/sum.test.mjs': SUM_TEST },
  },
];

// Every git call goes through runProcess with an argv array, never a shell
// string (AGENTS.md spawn safety).
function git(cwd, args) {
  const res = runProcess('git', args, { cwd });
  if (res.code !== 0) throw new Error(`git ${args.join(' ')}: ${(res.stderr || res.stdout).trim().split('\n')[0]}`);
  return res.stdout.trim();
}

function writeFiles(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

/** git-init the sample repo at `dir` and return its main sha and PR metadata. */
export function buildDemoRepo(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '--quiet', '--initial-branch=main']);
  for (const [key, value] of [
    ['user.name', 'Demo Agent'],
    ['user.email', 'demo-agent@example.com'],
    ['commit.gpgsign', 'false'],
    ['core.autocrlf', 'false'],
  ]) {
    git(dir, ['config', key, value]);
  }
  writeFiles(dir, BASE_FILES);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', 'chore: seed sample repo']);
  const main = git(dir, ['rev-parse', 'HEAD']);

  const prs = PRS.map((pr) => {
    git(dir, ['checkout', '--quiet', '-b', pr.branch]);
    writeFiles(dir, pr.files);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '--quiet', '-m', pr.title]);
    const headSha = git(dir, ['rev-parse', 'HEAD']);
    git(dir, ['checkout', '--quiet', 'main']);
    return { number: pr.number, branch: pr.branch, title: pr.title, headSha, issueLabels: pr.issueLabels, expected: pr.expected };
  });
  return { dir, main, prs };
}

/**
 * Build the sample repo in a fresh temp dir, gate every PR, return the rows.
 * `run` picks the documented expectation: 'seeded' (demo/ledger.json) or 'cold'.
 */
export function runDemo({ ledger, run = 'seeded' }) {
  const dir = mkdtempSync(join(tmpdir(), 'mergeproof-demo-'));
  try {
    const repo = buildDemoRepo(dir);
    // The gate's config comes from the base branch tip, never the PR.
    const config = parseConfig(showFile(dir, repo.main, CONFIG_FILE));
    return repo.prs.map((pr) => {
      const result = evaluate(
        {
          root: dir,
          baseSha: mergeBase(dir, repo.main, pr.headSha),
          headSha: pr.headSha,
          config,
          claims: { title: pr.title, labels: [], subjects: [pr.title] },
          ci: null,
          issueLabels: pr.issueLabels,
          agent: AGENT,
          model: MODEL,
          ledger,
          ledgerPath: null,
        },
        defaultDeps,
      );
      // Expectations are fixed per run, never derived from the gate's own trust
      // logic, so a trust bug shows up as a mismatch.
      return {
        number: pr.number,
        title: pr.title,
        expected: pr.expected[run],
        verdict: result.verdict.verdict,
        kind: result.kind,
        notes: result.verdict.notes.map((n) => n.text),
      };
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function printRun(header, rows) {
  console.log(header);
  let mismatched = 0;
  for (const row of rows) {
    const name = PRS.find((p) => p.number === row.number)?.name ?? row.title;
    const ok = row.verdict === row.expected;
    if (!ok) mismatched++;
    console.log(`#${row.number} ${name}  expected ${row.expected}  got ${row.verdict} ${ok ? '✓' : '✗'}`);
    if (!ok) for (const note of row.notes) console.log(`    ${note}`);
  }
  return mismatched;
}

const runAsScript = resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url));
if (runAsScript) {
  const seeded = readLedger(join(dirname(fileURLToPath(import.meta.url)), 'ledger.json'));
  console.log('mergeproof demo — four agent PRs against the gate (throwaway repo in a temp dir)\n');
  let mismatched = 0;
  mismatched += printRun('run 1: seeded ledger (demo/ledger.json — bugfix and refactor already trusted)', runDemo({ ledger: seeded }));
  console.log('');
  mismatched += printRun('run 2: cold start (empty ledger — nothing trusted yet)', runDemo({ ledger: emptyLedger(), run: 'cold' }));
  if (mismatched > 0) {
    console.error(`\n${mismatched} verdict(s) differ from demo/README.md`);
    process.exitCode = 1;
  }
}
