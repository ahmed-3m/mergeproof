// check and sync as commands: real git repos, a fake `gh`, a captured printer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRepo, testFile, FIXED_MATH, BASE_FILES } from './fixtures/repo.mjs';
import { runCheck, evaluate, defaultDeps as checkDeps } from '../src/commands/check.mjs';
import { runSync, settle, defaultDeps as syncDeps } from '../src/commands/sync.mjs';
import { checksState, normalizePr, parsePrUrl } from '../src/adapters/gh.mjs';
import { parseConfig } from '../src/config.mjs';
import { emptyLedger, readLedger, writeLedger, LEDGER_SCHEMA } from '../src/ledger.mjs';
import { parseTrailer } from '../src/trailer.mjs';

const URL = 'https://github.com/acme/app/pull/77';
const DEMO = resolve('demo/ledger.json');

function fakeGh(repo, { headSha, baseSha, author = 'agent-bot', headRef = 'agent/fix', isFork = false, labels = ['bug'], checks = [] }) {
  const calls = { merge: [], comment: [], issue: [], issueLabels: [] };
  let merged = null;
  return {
    calls,
    parsePrUrl,
    getPullRequest: () => ({
      number: 77, url: URL, title: 'fix: mul by 3', author, state: merged ? 'MERGED' : 'OPEN', headRef, headSha, baseRef: 'main', baseSha,
      labels: [], subjects: ['fix: mul by 3'], isFork, mergeCommit: merged, mergedAt: merged ? '2026-10-22T12:00:00Z' : null, checks,
    }),
    issueLabels: (url, numbers) => {
      calls.issueLabels.push(numbers);
      return labels;
    },
    squashMerge: (url, opts) => {
      calls.merge.push(opts);
      merged = 'f'.repeat(40);
    },
    comment: (url, body) => calls.comment.push(body),
    createIssue: (opts) => calls.issue.push(opts) && 'https://github.com/acme/app/issues/99',
  };
}

function setup(config = {}) {
  const gate = { testCommand: 'node --test', testFileCommand: 'node --test', agents: { logins: ['agent-bot'], branchPrefixes: ['agent/'] }, ...config };
  const repo = createRepo({ ...BASE_FILES, '.mergeproof.json': JSON.stringify(gate) });
  const baseSha = repo.git(['rev-parse', 'HEAD']);
  repo.branch('agent/fix').write({ 'src/math.mjs': FIXED_MATH, 'tests/mul.test.mjs': testFile('mul by 3', ['assert.equal(mul(3, 2), 6);']) });
  const headSha = repo.commit('fix: mul by 3');
  repo.git(['checkout', '--quiet', 'main']);
  const ledger = join(repo.dir, '.mergeproof', 'ledger.json');
  mkdirSync(join(repo.dir, '.mergeproof'), { recursive: true });
  copyFileSync(DEMO, ledger);
  return { repo, baseSha, headSha, ledger };
}

function deps(repo, gh, out) {
  return {
    ...checkDeps,
    git: { ...checkDeps.git, fetch: () => {} },
    gh,
    cwd: () => repo.dir,
    now: () => new Date('2026-10-22T12:00:00Z'),
    print: (s) => out.push(s),
  };
}

const AGENT = ['--agent', 'claude-code', '--model', 'glm-5.2', '--skill', 'bugfix@1'];
// The issue the workflow dispatched the agent for; its maintainer label makes the PR a bugfix.
const PR_ARGS = [...AGENT, '--issue', '3'];

test('enforce mode merges a proven, trusted PR with a trailer and logs it', async () => {
  const { repo, baseSha, headSha, ledger } = setup({ mode: 'enforce' });
  try {
    const gh = fakeGh(repo, { baseSha, headSha, checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] });
    const out = [];
    const code = await runCheck([URL, ...PR_ARGS], deps(repo, gh, out));
    assert.equal(code, 0, out.join('\n'));
    assert.equal(gh.calls.merge.length, 1);
    assert.equal(gh.calls.merge[0].headSha, headSha, 'merge is pinned to the proven commit');
    assert.deepEqual(parseTrailer(gh.calls.merge[0].body), { verdict: 'merge', pr: 77, kind: 'bugfix', agent: 'claude-code', model: 'glm-5.2', skill: 'bugfix@1', attempts: 1 });
    const last = readLedger(ledger).outcomes.at(-1);
    assert.equal(last.pr, 77);
    assert.equal(last.status, 'pending');
    assert.equal(last.mergeCommit, 'f'.repeat(40));
    assert.match(out[0], /MERGE \(kind: bugfix\)[\s\S]*enforce: merged/);
    assert.equal(gh.calls.comment.length, 1);
  } finally {
    repo.cleanup();
  }
});

test('shadow mode reports MERGE but never merges, and logs the PR as open', async () => {
  const { repo, baseSha, headSha, ledger } = setup();
  try {
    const gh = fakeGh(repo, { baseSha, headSha, checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] });
    const out = [];
    assert.equal(await runCheck([URL, ...PR_ARGS, '--json'], deps(repo, gh, out)), 0);
    assert.equal(gh.calls.merge.length, 0);
    assert.deepEqual(JSON.parse(out[0]).merged, false);
    assert.equal(JSON.parse(out[0]).mode, 'shadow');
    assert.equal(readLedger(ledger).outcomes.at(-1).status, 'open');
  } finally {
    repo.cleanup();
  }
});

test('--dry-run never merges, comments or writes the ledger', async () => {
  const { repo, baseSha, headSha, ledger } = setup({ mode: 'enforce' });
  try {
    const gh = fakeGh(repo, { baseSha, headSha, checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] });
    assert.equal(await runCheck([URL, ...PR_ARGS, '--dry-run'], deps(repo, gh, [])), 0);
    assert.deepEqual([gh.calls.merge.length, gh.calls.comment.length], [0, 0]);
    assert.equal(readLedger(ledger).outcomes.length, 20);
  } finally {
    repo.cleanup();
  }
});

test('red CI is weak proof; human, spoofed and fork PRs go to a human; off mode merges nothing', async () => {
  for (const [config, ghOpts, expected, note] of [
    [{ mode: 'enforce' }, { checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }] }, 3, /CI is red/],
    [{ mode: 'enforce' }, { author: 'alice', headRef: 'feature/x' }, 4, /not an agent PR/],
    [{ mode: 'enforce' }, { author: 'alice', headRef: 'agent/fix' }, 4, /author alice is not in agents.logins/],
    [{ mode: 'enforce' }, { isFork: true }, 4, /PR comes from a fork/],
    [{ mode: 'enforce' }, { headRef: 'feature/x' }, 4, /agent branch feature\/x does not start with agent\//],
    [{ mode: 'off' }, {}, 4, /mergeproof is off/],
  ]) {
    const { repo, baseSha, headSha } = setup(config);
    try {
      const gh = fakeGh(repo, { baseSha, headSha, ...ghOpts });
      const out = [];
      assert.equal(await runCheck([URL, ...PR_ARGS], deps(repo, gh, out)), expected, out.join('\n'));
      assert.match(out[0], note);
      assert.equal(gh.calls.merge.length, 0);
    } finally {
      repo.cleanup();
    }
  }
});

test('the PR cannot loosen its own gate: config is read from base', async () => {
  const { repo, baseSha } = setup({ mode: 'enforce' });
  try {
    repo.git(['checkout', '--quiet', 'agent/fix']);
    repo.write({ '.mergeproof.json': JSON.stringify({ mode: 'enforce', trust: { minOutcomes: 1 } }) });
    const headSha = repo.commit('chore: tune');
    const gh = fakeGh(repo, { baseSha, headSha });
    const out = [];
    assert.equal(await runCheck([URL, ...PR_ARGS], deps(repo, gh, out)), 4);
    assert.match(out[0], /edits gate file .mergeproof.json/);
  } finally {
    repo.cleanup();
  }
});

test('config comes from the base tip, not the older merge-base the PR branched from', async () => {
  const { repo, headSha } = setup({ mode: 'enforce' });
  try {
    repo.write({ '.mergeproof.json': JSON.stringify({ mode: 'off' }) });
    const tip = repo.commit('chore: pause the gate');
    const gh = fakeGh(repo, { baseSha: tip, headSha, checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] });
    const out = [];
    assert.equal(await runCheck([URL, ...PR_ARGS], deps(repo, gh, out)), 4);
    assert.match(out[0], /mergeproof is off/);
    assert.equal(gh.calls.merge.length, 0);
  } finally {
    repo.cleanup();
  }
});

test('the bugfix issue comes only from --issue, never from the PR', async () => {
  const { repo, baseSha, headSha } = setup({ mode: 'enforce' });
  try {
    const gh = fakeGh(repo, { baseSha, headSha, checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] });
    const out = [];
    // Without --issue the PR is a feature, which the demo ledger hasn't trusted yet.
    assert.equal(await runCheck([URL, ...AGENT, '--dry-run'], deps(repo, gh, out)), 4);
    assert.match(out[0], /HUMAN \(kind: feature\)/);
    assert.deepEqual(gh.calls.issueLabels, []);
    assert.equal(await runCheck([URL, ...PR_ARGS, '--dry-run'], deps(repo, gh, out)), 0);
    assert.deepEqual(gh.calls.issueLabels, [[3]]);
    await assert.rejects(runCheck([URL, ...AGENT, '--issue', '3x'], deps(repo, gh, out)), /--issue must be an issue number/);
  } finally {
    repo.cleanup();
  }
});

test('a test run that writes to the shared .git/config is caught before the gate calls git again', async () => {
  const { repo, baseSha, ledger } = setup({ mode: 'enforce' });
  try {
    repo.git(['checkout', '--quiet', 'agent/fix']);
    // Worktrees have a `.git` file pointing at <common>/worktrees/<name>.
    const plant = [
      "import * as plantFs from 'node:fs';",
      "import * as plantPath from 'node:path';",
      "const gitdir = plantFs.readFileSync('.git', 'utf8').replace('gitdir:', '').trim();",
      "plantFs.appendFileSync(plantPath.resolve(gitdir, '..', '..', 'config'), '\\n[core]\\n\\tfsmonitor = ./evil\\n');",
    ].join('\n');
    repo.write({ 'tests/plant.test.mjs': `${plant}\n${testFile('mul by 3 again', ['assert.equal(mul(3, 3), 9);'])}` });
    repo.git(['add', 'tests/plant.test.mjs']);
    repo.git(['commit', '--quiet', '-m', 'test: plant']);
    const headSha = repo.git(['rev-parse', 'HEAD']);
    repo.git(['checkout', '--quiet', 'main']);
    const gh = fakeGh(repo, { baseSha, headSha, checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] });
    const out = [];
    assert.equal(await runCheck([URL, ...PR_ARGS], deps(repo, gh, out)), 4, out.join('\n'));
    assert.match(out[0], /test run changed the git config, hooks or ledger/);
    assert.equal(gh.calls.merge.length, 0);
    assert.equal(readLedger(ledger).outcomes.length, 20, 'nothing is logged');
  } finally {
    repo.cleanup();
  }
});

test('check --local runs end to end through the CLI', () => {
  const { repo } = setup();
  try {
    repo.git(['checkout', '--quiet', 'agent/fix']);
    const cli = resolve('bin/mergeproof.mjs');
    const env = { ...process.env, NODE_TEST_CONTEXT: '' };
    delete env.NODE_TEST_CONTEXT;
    const res = spawnSync(process.execPath, [cli, 'check', '--local', '--base', 'main', ...AGENT, '--ledger', DEMO], { cwd: repo.dir, encoding: 'utf8', env });
    // No linked issue locally, so the change is a feature, which the demo ledger hasn't trusted yet.
    assert.equal(res.status, 4, res.stdout + res.stderr);
    assert.match(res.stdout, /HUMAN \(kind: feature\)[\s\S]*feature for claude-code\/glm-5.2 not trusted yet[\s\S]*fail on base 2\/2/);
    assert.match(res.stdout, /\(local\)/);
  } finally {
    repo.cleanup();
  }
});

test('a refactor that makes generated test cases disappear is tampering', () => {
  // The suite builds its cases from a list in src/, so deleting an entry makes
  // a test disappear without touching a test file. node --test reports
  // "ℹ tests 2" on base and "ℹ tests 1" on head.
  const generated = [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from '../src/math.mjs';",
    "import { cases } from '../src/cases.mjs';",
    '',
    'for (const [a, b, sum] of cases) {',
    "  test(`add(${a}, ${b})`, () => {",
    '    assert.equal(add(a, b), sum);',
    '  });',
    '}',
    '',
  ].join('\n');
  const repo = createRepo({
    ...BASE_FILES,
    'tests/add.test.mjs': null,
    'src/cases.mjs': 'export const cases = [[1, 1, 2], [2, 2, 4]];\n',
    'tests/cases.test.mjs': generated,
  });
  try {
    const baseSha = repo.git(['rev-parse', 'HEAD']);
    repo.branch('agent/refactor').write({ 'src/cases.mjs': 'export const cases = [[1, 1, 2]];\n' });
    const headSha = repo.commit('refactor: fewer cases');
    const result = evaluate(
      {
        root: repo.dir,
        baseSha,
        headSha,
        config: parseConfig(repo.git(['show', `${baseSha}:.mergeproof.json`])),
        claims: { subjects: ['refactor: fewer cases'] },
        ci: null,
        issueLabels: [],
        agent: 'claude-code',
        model: 'glm-5.2',
        ledger: readLedger(DEMO),
      },
      checkDeps,
    );
    const why = JSON.stringify(result.verdict);
    assert.equal(result.verdict.verdict, 'HUMAN', why);
    assert.ok(result.verdict.notes.some((n) => /test count dropped from 2/.test(n.text)), why);
    assert.deepEqual(result.tamperNotes.map((n) => n.rule), ['testCountDropped']);
    assert.equal(result.proof.ok, false, 'a tampered PR is never recorded in the ledger');
    assert.equal(repo.git(['worktree', 'list']).split('\n').length, 1, 'proof worktrees are cleaned up');
  } finally {
    repo.cleanup();
  }
});

test('gh output is normalized and CI collapses to one state', () => {
  const pr = normalizePr({ number: 3, author: { login: 'bot' }, labels: [{ name: 'x' }], commits: [{ messageHeadline: 'fix: a' }], isCrossRepository: false, mergeCommit: null });
  assert.deepEqual([pr.author, pr.labels, pr.subjects, pr.isFork], ['bot', ['x'], ['fix: a'], false]);
  assert.equal(normalizePr({ number: 3 }).isFork, true, 'unknown origin counts as a fork');
  assert.equal(checksState([]), 'none');
  assert.equal(checksState([{ name: 'mergeproof', status: 'IN_PROGRESS' }]), 'none', 'the gate ignores its own job');
  assert.equal(checksState([{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }, { context: 'lint', state: 'SUCCESS' }]), 'green');
  assert.equal(checksState([{ name: 'ci', status: 'IN_PROGRESS', conclusion: '' }]), 'pending');
  assert.equal(checksState([{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }, { name: 'e2e', status: 'COMPLETED', conclusion: 'TIMED_OUT' }]), 'red');
  assert.deepEqual(parsePrUrl(URL), { host: 'github.com', repo: 'acme/app', number: 77 });
  assert.equal(parsePrUrl('https://github.com/acme/app/issues/77'), null);
});

const DAY = 24 * 3600 * 1000;
const base = { kind: 'bugfix', agent: 'claude-code', model: 'glm-5.2', url: URL };

test('settle moves outcomes through open → pending → clean or reverted', () => {
  const now = new Date('2026-10-22T00:00:00Z');
  const iso = (daysAgo) => new Date(now.getTime() - daysAgo * DAY).toISOString();
  const ledger = {
    schema: LEDGER_SCHEMA,
    outcomes: [
      { ...base, pr: 1, status: 'open' },
      { ...base, pr: 2, status: 'open' },
      { ...base, pr: 3, status: 'pending', mergedAt: iso(20), mergeCommit: 'a'.repeat(40) },
      { ...base, pr: 4, status: 'pending', mergedAt: iso(5), mergeCommit: 'b'.repeat(40) },
      { ...base, pr: 5, status: 'pending', mergedAt: iso(30), mergeCommit: 'c'.repeat(40) },
    ],
  };
  const commits = [
    { sha: 'r1', date: iso(1), message: `Revert "fix"\n\nThis reverts commit ${'b'.repeat(40)}.` },
    { sha: 'r2', date: iso(2), message: `Revert "old"\n\nThis reverts commit ${'c'.repeat(40)}.` },
  ];
  const states = { 1: { state: 'MERGED', mergedAt: iso(1), mergeCommit: 'd'.repeat(40) }, 2: { state: 'CLOSED' } };
  let n = 0;
  const { ledger: after, newlyReverted } = settle(ledger, { commits, prState: () => states[++n], now, windowDays: 14 });
  assert.deepEqual(after.outcomes.map((o) => o.status), ['pending', 'closed', 'clean', 'reverted', 'clean']);
  assert.deepEqual(newlyReverted.map((o) => o.pr), [4], 'a revert after the window does not count');
});

test('sync writes the settled ledger and opens a human-triage issue', async () => {
  const repo = createRepo();
  try {
    const ledgerPath = join(repo.dir, '.mergeproof', 'ledger.json');
    const mergedSha = repo.git(['rev-parse', 'HEAD']);
    repo.git(['revert', '--no-edit', 'HEAD']);
    writeLedger(ledgerPath, { ...emptyLedger(), outcomes: [{ ...base, pr: 7, status: 'pending', mergedAt: new Date().toISOString(), mergeCommit: mergedSha }] });
    const issues = [];
    const out = [];
    const code = await runSync([], {
      ...syncDeps,
      gh: { getPullRequest: () => assert.fail('no open PRs to look up'), createIssue: (o) => issues.push(o) && 'url' },
      cwd: () => repo.dir,
      print: (s) => out.push(s),
    });
    assert.equal(code, 0);
    assert.equal(readLedger(ledgerPath).outcomes[0].status, 'reverted');
    assert.equal(issues.length, 1);
    assert.equal(issues[0].repo, 'acme/app');
    assert.match(issues[0].body, /not meant for an agent/);
    assert.match(out[0], /1 newly reverted/);
  } finally {
    repo.cleanup();
  }
});
