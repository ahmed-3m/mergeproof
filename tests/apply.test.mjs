// The check/apply split: `check --verdict-out` is the read-only gate job (it
// writes nothing to GitHub), `apply` is the write job — it never runs PR code,
// so it re-derives everything but "the proof held" and refuses a verdict file
// that disagrees. Real git repos, a fake `gh`, a captured printer
// (tests/commands.test.mjs style).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRepo, testFile, FIXED_MATH, BASE_FILES } from './fixtures/repo.mjs';
import { runCheck, defaultDeps as checkDeps } from '../src/commands/check.mjs';
import { runApply } from '../src/commands/apply.mjs';
import { checksState, parsePrUrl } from '../src/adapters/gh.mjs';
import { emptyLedger, readLedger, writeLedger } from '../src/ledger.mjs';
import { parseTrailer } from '../src/trailer.mjs';
import { readVerdictFile, VERDICT_FILE_SCHEMA } from '../src/verdictfile.mjs';

const URL = 'https://github.com/acme/app/pull/77';
const DEMO = resolve('demo/ledger.json');
const GREEN = [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const RED = [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }];

function fakeGh({ headSha, baseSha, author = 'agent-bot', headRef = 'agent/fix', isFork = false, state = 'OPEN', labels = ['bug'], checks = [], title = 'fix: mul by 3' }) {
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

const BUGFIX_CHANGE = { 'src/math.mjs': FIXED_MATH, 'tests/mul.test.mjs': testFile('mul by 3', ['assert.equal(mul(3, 2), 6);']) };
const REFACTOR_MATH = BASE_FILES['src/math.mjs'].replace('return a + b;', 'return [a, b].reduce((x, y) => x + y, 0);');

function setup(config = {}, change = BUGFIX_CHANGE, message = 'fix: mul by 3') {
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
// The issue the workflow dispatched the agent for; its maintainer label makes the PR a bugfix.
const PR_ARGS = [...AGENT, '--issue', '3'];

// The workflow passes the same flags to the gate job and the apply job.
function gateOpts(baseSha, headSha, extra = {}) {
  return { baseSha, headSha, checks: GREEN, ...extra };
}

// A valid verdict file, mutated per case for the malformed-file test.
const MERGE_VERDICT = {
  schema: VERDICT_FILE_SCHEMA,
  url: URL,
  pr: 77,
  headSha: 'a'.repeat(40),
  kind: 'bugfix',
  verdict: 'MERGE',
  notes: [],
  proven: true,
  agent: 'claude-code',
  model: 'glm-5.2',
  skill: 'bugfix@1',
  attempts: 1,
  issue: 3,
};

function writeVerdict(dir, mutate) {
  const data = { ...MERGE_VERDICT };
  mutate?.(data);
  const file = join(dir, 'verdict.json');
  writeFileSync(file, `${JSON.stringify(data)}\n`);
  return file;
}

/** Rewrite a field of a verdict file the gate honestly produced (the forgery). */
function forge(file, mutate) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  mutate(data);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return file;
}

test('check --verdict-out writes a valid verdict file and nothing to GitHub or the ledger', async () => {
  const { repo, baseSha, headSha, ledger } = setup({ mode: 'enforce' });
  try {
    const gh = fakeGh(gateOpts(baseSha, headSha));
    const out = [];
    const file = join(repo.dir, 'verdict.json');
    assert.equal(await runCheck([URL, ...PR_ARGS, '--verdict-out', file], deps(repo, gh, out)), 0, out.join('\n'));
    assert.deepEqual([gh.calls.merge.length, gh.calls.comment.length, gh.calls.label.length], [0, 0, 0], 'the gate job writes nothing');
    assert.equal(readLedger(ledger).outcomes.length, 20, 'no ledger write');
    assert.match(out[0], /verdict-out: not merged/);
    const v = readVerdictFile(file); // passes the strict validation apply will run
    assert.deepEqual(
      { schema: v.schema, url: v.url, pr: v.pr, headSha: v.headSha, kind: v.kind, verdict: v.verdict, proven: v.proven, agent: v.agent, model: v.model, skill: v.skill, attempts: v.attempts, issue: v.issue },
      { schema: VERDICT_FILE_SCHEMA, url: URL, pr: 77, headSha, kind: 'bugfix', verdict: 'MERGE', proven: true, agent: 'claude-code', model: 'glm-5.2', skill: 'bugfix@1', attempts: 1, issue: 3 },
    );
    assert.ok(Array.isArray(v.notes) && v.notes.every((n) => n.ok), 'a MERGE carries only passing notes');
  } finally {
    repo.cleanup();
  }
});

test('apply lands a MERGE verdict in enforce mode: merge pinned to the gated head, pending outcome, comment', async () => {
  const { repo, baseSha, headSha, ledger } = setup({ mode: 'enforce' });
  try {
    const file = join(repo.dir, 'verdict.json');
    assert.equal(await runCheck([URL, ...PR_ARGS, '--verdict-out', file], deps(repo, fakeGh(gateOpts(baseSha, headSha)), [])), 0);

    const gh = fakeGh(gateOpts(baseSha, headSha));
    const out = [];
    assert.equal(await runApply([file, '--pr', URL, ...PR_ARGS], deps(repo, gh, out)), 0, out.join('\n'));
    assert.equal(gh.calls.merge.length, 1);
    assert.equal(gh.calls.merge[0].headSha, headSha, 'merge is pinned to the sha the gate proved');
    assert.deepEqual(parseTrailer(gh.calls.merge[0].body), { verdict: 'merge', pr: 77, kind: 'bugfix', agent: 'claude-code', model: 'glm-5.2', skill: 'bugfix@1', attempts: 1 });
    const last = readLedger(ledger).outcomes.at(-1);
    assert.equal(last.pr, 77);
    assert.equal(last.status, 'pending');
    assert.equal(last.mergeCommit, 'f'.repeat(40));
    assert.equal(gh.calls.comment.length, 1);
    assert.match(out[0], /MERGE \(kind: bugfix\)[\s\S]*enforce: merged/);
    assert.deepEqual(gh.calls.label, [], 'MERGE adds no label');
  } finally {
    repo.cleanup();
  }
});

test('apply refuses when the head moved, the PR closed, the author is not an agent login, or it is a fork', async () => {
  for (const [name, ghOpts, note] of [
    ['head moved', { headSha: 'e'.repeat(40) }, /PR changed after the gate ran/],
    ['closed', { state: 'CLOSED' }, /PR is CLOSED, not open/],
    ['not an agent login', { author: 'alice' }, /author alice is not in agents.logins/],
    ['fork', { isFork: true }, /PR comes from a fork/],
  ]) {
    const { repo, baseSha, headSha, ledger } = setup({ mode: 'enforce' });
    try {
      const file = join(repo.dir, 'verdict.json');
      assert.equal(await runCheck([URL, ...PR_ARGS, '--verdict-out', file], deps(repo, fakeGh(gateOpts(baseSha, headSha)), [])), 0);
      const gh = fakeGh(gateOpts(baseSha, headSha, ghOpts));
      const out = [];
      assert.equal(await runApply([file, '--pr', URL, ...PR_ARGS], deps(repo, gh, out)), 4, name);
      assert.match(out[0], note);
      assert.match(out[0], /nothing written/, `${name}: a benign refusal writes nothing`);
      assert.deepEqual([gh.calls.merge.length, gh.calls.comment.length, gh.calls.label.length], [0, 0, 0], `${name}: nothing written`);
      assert.equal(readLedger(ledger).outcomes.length, 20, `${name}: no ledger write`);
    } finally {
      repo.cleanup();
    }
  }
});

test('apply on a HUMAN verdict labels needs-human, records the proven outcome and does not merge', async () => {
  const { repo, baseSha, headSha, ledger } = setup({ mode: 'enforce' });
  try {
    const file = join(repo.dir, 'verdict.json');
    // No --issue, so the change is a feature, which the demo ledger hasn't trusted yet: HUMAN, proof held.
    assert.equal(await runCheck([URL, ...AGENT, '--verdict-out', file], deps(repo, fakeGh(gateOpts(baseSha, headSha)), [])), 4);
    const gh = fakeGh(gateOpts(baseSha, headSha));
    const out = [];
    assert.equal(await runApply([file, '--pr', URL, ...AGENT], deps(repo, gh, out)), 4, out.join('\n'));
    assert.equal(gh.calls.merge.length, 0);
    assert.deepEqual(gh.calls.label, ['needs-human']);
    assert.equal(gh.calls.comment.length, 1);
    const last = readLedger(ledger).outcomes.at(-1);
    assert.equal(last.pr, 77);
    assert.equal(last.kind, 'feature');
    assert.equal(last.status, 'open', 'a proven HUMAN outcome is still logged, for a human merge to earn trust');
  } finally {
    repo.cleanup();
  }
});

test('apply on a RETRY verdict only comments; the workflow counts retries', async () => {
  const { repo, baseSha, headSha, ledger } = setup({ mode: 'enforce' });
  try {
    const file = join(repo.dir, 'verdict.json');
    assert.equal(await runCheck([URL, ...PR_ARGS, '--verdict-out', file], deps(repo, fakeGh(gateOpts(baseSha, headSha, { checks: RED })), [])), 3);
    const gh = fakeGh(gateOpts(baseSha, headSha, { checks: RED }));
    const out = [];
    assert.equal(await runApply([file, '--pr', URL, ...PR_ARGS], deps(repo, gh, out)), 3, out.join('\n'));
    assert.deepEqual([gh.calls.merge.length, gh.calls.label.length], [0, 0], 'RETRY adds no label');
    assert.equal(gh.calls.comment.length, 1);
    assert.equal(readLedger(ledger).outcomes.length, 20, 'weak proof is not logged');
  } finally {
    repo.cleanup();
  }
});

test('apply in shadow mode never merges', async () => {
  const { repo, baseSha, headSha, ledger } = setup();
  try {
    const file = join(repo.dir, 'verdict.json');
    assert.equal(await runCheck([URL, ...PR_ARGS, '--verdict-out', file], deps(repo, fakeGh(gateOpts(baseSha, headSha)), [])), 0);
    const gh = fakeGh(gateOpts(baseSha, headSha));
    const out = [];
    assert.equal(await runApply([file, '--pr', URL, ...PR_ARGS], deps(repo, gh, out)), 0, out.join('\n'));
    assert.equal(gh.calls.merge.length, 0);
    assert.equal(readLedger(ledger).outcomes.at(-1).status, 'open');
    assert.equal(gh.calls.comment.length, 1);
    assert.match(out[0], /shadow: not merged/);
  } finally {
    repo.cleanup();
  }
});

test('apply --dry-run validates and prints what would happen, writing nothing', async () => {
  const { repo, baseSha, headSha, ledger } = setup({ mode: 'enforce' });
  try {
    const file = join(repo.dir, 'verdict.json');
    assert.equal(await runCheck([URL, ...PR_ARGS, '--verdict-out', file], deps(repo, fakeGh(gateOpts(baseSha, headSha)), [])), 0);
    const gh = fakeGh(gateOpts(baseSha, headSha));
    const out = [];
    assert.equal(await runApply([file, '--pr', URL, '--dry-run', ...PR_ARGS], deps(repo, gh, out)), 0, out.join('\n'));
    assert.match(out[0], /dry-run: would record the outcome, merge, comment/);
    assert.deepEqual([gh.calls.merge.length, gh.calls.comment.length, gh.calls.label.length], [0, 0, 0]);
    assert.equal(readLedger(ledger).outcomes.length, 20);
  } finally {
    repo.cleanup();
  }
});

test('a forged MERGE for a bucket the apply job’s ledger does not trust is refused, labelled and never merged', async () => {
  const { repo, baseSha, headSha, ledger } = setup({ mode: 'enforce' });
  try {
    const file = join(repo.dir, 'verdict.json');
    assert.equal(await runCheck([URL, ...PR_ARGS, '--verdict-out', file], deps(repo, fakeGh(gateOpts(baseSha, headSha)), [])), 0);

    // The gate job saw a trusted bucket; the apply job's ledger is cold.
    const cold = join(repo.dir, 'cold-ledger.json');
    writeLedger(cold, emptyLedger());
    const gh = fakeGh(gateOpts(baseSha, headSha));
    const out = [];
    assert.equal(await runApply([file, '--pr', URL, ...PR_ARGS, '--ledger', cold], deps(repo, gh, out)), 4, out.join('\n'));
    assert.match(out[0], /verdict file disagrees with the re-check \(re-check says HUMAN\)/);
    assert.match(out[0], /bugfix for claude-code\/glm-5.2 not trusted yet/);
    assert.equal(gh.calls.merge.length, 0);
    assert.deepEqual(gh.calls.label, ['needs-human']);
    assert.equal(gh.calls.comment.length, 1);
    assert.equal(readLedger(cold).outcomes.length, 0, 'nothing logged');
    assert.equal(readLedger(ledger).outcomes.length, 20, 'the default ledger is untouched');
  } finally {
    repo.cleanup();
  }
});

test('a forged kind (file says bugfix, paths say refactor) is refused', async () => {
  const { repo, baseSha, headSha, ledger } = setup({ mode: 'enforce' }, { 'src/math.mjs': REFACTOR_MATH }, 'refactor: add via reduce');
  try {
    const file = join(repo.dir, 'verdict.json');
    assert.equal(
      await runCheck([URL, ...AGENT, '--verdict-out', file], deps(repo, fakeGh(gateOpts(baseSha, headSha, { title: 'refactor: add via reduce' })), [])),
      0,
      'refactor is trusted in the seeded ledger',
    );
    forge(file, (d) => { d.kind = 'bugfix'; });
    const gh = fakeGh(gateOpts(baseSha, headSha, { title: 'refactor: add via reduce' }));
    const out = [];
    assert.equal(await runApply([file, '--pr', URL, ...AGENT], deps(repo, gh, out)), 4, out.join('\n'));
    assert.match(out[0], /file says bugfix, paths say refactor/);
    assert.equal(gh.calls.merge.length, 0);
    assert.deepEqual(gh.calls.label, ['needs-human']);
    assert.equal(gh.calls.comment.length, 1);
    assert.equal(readLedger(ledger).outcomes.length, 20, 'nothing logged');
  } finally {
    repo.cleanup();
  }
});

test('a gate HUMAN for a tamper note lands as that HUMAN, not as a forged file', async () => {
  // The demo's test-edit PR: the gate said HUMAN for editing an existing test,
  // and apply used to report the honest file as one that "disagrees".
  const edit = BASE_FILES['tests/add.test.mjs'].replace('add(2, 2), 4', 'add(2, 3), 5');
  const { repo, baseSha, headSha, ledger } = setup({ mode: 'enforce' }, { ...BUGFIX_CHANGE, 'tests/add.test.mjs': edit });
  try {
    const file = join(repo.dir, 'verdict.json');
    assert.equal(await runCheck([URL, ...PR_ARGS, '--verdict-out', file], deps(repo, fakeGh(gateOpts(baseSha, headSha)), [])), 4);
    const gh = fakeGh(gateOpts(baseSha, headSha));
    const out = [];
    assert.equal(await runApply([file, '--pr', URL, ...PR_ARGS], deps(repo, gh, out)), 4, out.join('\n'));
    assert.doesNotMatch(out[0], /disagrees|did not survive/);
    assert.match(out[0], /edits existing test tests\/add\.test\.mjs/);
    assert.equal(gh.calls.merge.length, 0);
    assert.deepEqual(gh.calls.label, ['needs-human']);
    assert.equal(readLedger(ledger).outcomes.length, 20, 'no proof, nothing logged');

    // The same note under a forged MERGE is still refused.
    forge(file, (d) => { d.verdict = 'MERGE'; d.proven = true; });
    const gh2 = fakeGh(gateOpts(baseSha, headSha));
    const out2 = [];
    assert.equal(await runApply([file, '--pr', URL, ...PR_ARGS], deps(repo, gh2, out2)), 4);
    assert.match(out2[0], /verdict file disagrees with the re-check/);
    assert.equal(gh2.calls.merge.length, 0);
  } finally {
    repo.cleanup();
  }
});

test('a verdict file for another PR is refused: proof never transfers between PRs', async () => {
  const { repo, baseSha, headSha, ledger } = setup({ mode: 'enforce' });
  try {
    const file = join(repo.dir, 'verdict.json');
    assert.equal(await runCheck([URL, ...PR_ARGS, '--verdict-out', file], deps(repo, fakeGh(gateOpts(baseSha, headSha)), [])), 0);
    const gh = fakeGh(gateOpts(baseSha, headSha));
    const out = [];
    const otherPr = ['--pr', 'https://github.com/acme/app/pull/78', ...PR_ARGS];
    assert.equal(await runApply([file, ...otherPr], deps(repo, gh, out)), 4, out.join('\n'));
    assert.match(out[0], /verdict file is for a different pull request/);
    assert.equal(gh.calls.merge.length, 0);
    assert.equal(readLedger(ledger).outcomes.length, 20, 'nothing logged');
  } finally {
    repo.cleanup();
  }
});

test('a verdict file that does not match the workflow’s flags is refused', async () => {
  const { repo, baseSha, headSha, ledger } = setup({ mode: 'enforce' });
  try {
    const file = join(repo.dir, 'verdict.json');
    assert.equal(await runCheck([URL, ...PR_ARGS, '--verdict-out', file], deps(repo, fakeGh(gateOpts(baseSha, headSha)), [])), 0);
    const gh = fakeGh(gateOpts(baseSha, headSha));
    const out = [];
    const otherAgent = ['--agent', 'codex-agent', '--model', 'glm-5.2', '--skill', 'bugfix@1', '--issue', '3'];
    assert.equal(await runApply([file, '--pr', URL, ...otherAgent], deps(repo, gh, out)), 4, out.join('\n'));
    assert.match(out[0], /verdict file does not match the workflow's flags/);
    assert.equal(gh.calls.merge.length, 0);
    assert.deepEqual(gh.calls.label, ['needs-human']);
    assert.equal(gh.calls.comment.length, 1);
    assert.equal(readLedger(ledger).outcomes.length, 20, 'nothing logged');
  } finally {
    repo.cleanup();
  }
});

test('a MERGE whose CI is now red lands as RETRY, not merged', async () => {
  const { repo, baseSha, headSha, ledger } = setup({ mode: 'enforce' });
  try {
    const file = join(repo.dir, 'verdict.json');
    assert.equal(await runCheck([URL, ...PR_ARGS, '--verdict-out', file], deps(repo, fakeGh(gateOpts(baseSha, headSha)), [])), 0);
    const gh = fakeGh(gateOpts(baseSha, headSha, { checks: RED }));
    const out = [];
    assert.equal(await runApply([file, '--pr', URL, ...PR_ARGS], deps(repo, gh, out)), 3, out.join('\n'));
    assert.match(out[0], /RETRY \(kind: bugfix\)[\s\S]*CI is red/);
    assert.equal(gh.calls.merge.length, 0);
    assert.deepEqual(gh.calls.label, [], 'RETRY adds no label');
    assert.equal(gh.calls.comment.length, 1);
    assert.equal(readLedger(ledger).outcomes.length, 20, 'weak proof is not logged');
  } finally {
    repo.cleanup();
  }
});

test('an inconsistent proof block (proven false, verdict MERGE) is refused', async () => {
  const { repo, baseSha, headSha, ledger } = setup({ mode: 'enforce' });
  try {
    const file = join(repo.dir, 'verdict.json');
    assert.equal(await runCheck([URL, ...PR_ARGS, '--verdict-out', file], deps(repo, fakeGh(gateOpts(baseSha, headSha)), [])), 0);
    forge(file, (d) => { d.proven = false; });
    const gh = fakeGh(gateOpts(baseSha, headSha));
    const out = [];
    assert.equal(await runApply([file, '--pr', URL, ...PR_ARGS], deps(repo, gh, out)), 4, out.join('\n'));
    assert.match(out[0], /MERGE with proven false/);
    assert.equal(gh.calls.merge.length, 0);
    assert.deepEqual(gh.calls.label, ['needs-human']);
    assert.equal(readLedger(ledger).outcomes.length, 20, 'nothing logged');
  } finally {
    repo.cleanup();
  }
});

test('malformed verdict files are rejected before anything is fetched or written', async () => {
  const { repo, baseSha, headSha } = setup({ mode: 'enforce' });
  try {
    const cases = [
      [(d) => { d.schema = 'mergeproof-verdict@2'; }, /schema must be/],
      [(d) => { d.headSha = 'not-a-sha'; }, /headSha must be/],
      [(d) => { d.verdict = 'MAYBE'; }, /verdict must be one of/],
      [(d) => { d.url = 'https://github.com/acme/app/issues/77'; }, /url must be a pull request URL/],
      [(d) => { d.pr = 78; }, /pr must be the PR number/],
      [(d) => { d.attempts = 0; }, /attempts must be/],
      [(d) => { d.notes = 'ok'; }, /notes must be an array/],
      [(d) => { delete d.agent; }, /missing key "agent"/],
      [(d) => { d.notes = [1, 2, 3, 4].map(() => ({ ok: true, text: 'ok' })); }, /at most 3 entries/],
      [(d) => { d.notes = [{ ok: true, text: 'x'.repeat(301) }]; }, /text must be at most 300 characters/],
      [(d) => { d.notes = [{ ok: true, text: 'a`b' }]; }, /must not contain newlines, backticks or control characters/],
      [(d) => { d.notes = [{ ok: true, text: 'line\nbreak' }]; }, /must not contain newlines, backticks or control characters/],
    ];
    const gh = fakeGh(gateOpts(baseSha, headSha));
    const out = [];
    const d = deps(repo, gh, out);
    for (const [mutate, note] of cases) {
      await assert.rejects(
        runApply([writeVerdict(repo.dir, mutate), '--pr', URL, ...PR_ARGS], d),
        (err) => err.name === 'FileFormatError' && note.test(err.message),
        'a malformed verdict file never reaches GitHub',
      );
    }
    assert.deepEqual([gh.calls.merge.length, gh.calls.comment.length, gh.calls.label.length], [0, 0, 0]);
  } finally {
    repo.cleanup();
  }
});

test('--verdict-out with --local is a usage error: the apply job lands a PR verdict', async () => {
  await assert.rejects(runCheck(['--local', '--verdict-out', 'v.json']), /--verdict-out only applies to a pull request, not --local/);
});

test('apply without --agent and --model is a usage error', async () => {
  await assert.rejects(runApply(['v.json', '--pr', URL]), /apply requires --agent and --model/);
});

test('cli: apply with no file is a usage error', () => {
  const cli = resolve('bin/mergeproof.mjs');
  const res = spawnSync(process.execPath, [cli, 'apply'], { encoding: 'utf8' });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /expected exactly one <verdict-file>/);
});

test('a pinned head that moved stands down, and apply supersedes the stale run with nothing written', async () => {
  const { repo, baseSha, headSha, ledger } = setup({ mode: 'enforce' });
  try {
    // The event's CI completed on baseSha; the live PR head is headSha. The
    // gate must not judge a commit its CI never covered.
    const gh = fakeGh(gateOpts(baseSha, headSha));
    const out = [];
    const file = join(repo.dir, 'verdict.json');
    assert.equal(await runCheck([URL, ...PR_ARGS, '--head', baseSha, '--verdict-out', file], deps(repo, gh, out)), 4, out.join('\n'));
    assert.match(out[0], /superseded: the PR changed after its CI completed/);
    assert.deepEqual([gh.calls.merge.length, gh.calls.comment.length, gh.calls.label.length], [0, 0, 0], 'the stale gate run writes nothing');
    assert.equal(readLedger(ledger).outcomes.length, 20, 'no ledger write');
    const v = readVerdictFile(file); // passes the strict validation apply will run
    assert.equal(v.headSha, baseSha, "the file names the CI'd commit");
    assert.equal(v.proven, false);
    assert.equal(v.verdict, 'HUMAN');
    // The workflow passes the same --head to apply; the live head differs, so
    // the refusal is benign — print only, no label, no comment, no merge.
    const out2 = [];
    assert.equal(await runApply([file, '--pr', URL, '--head', baseSha, ...AGENT, '--issue', '3'], deps(repo, gh, out2)), 4, out2.join('\n'));
    assert.deepEqual([gh.calls.merge.length, gh.calls.comment.length, gh.calls.label.length], [0, 0, 0], 'the stale apply writes nothing');
    assert.match(out2[0], /PR changed after the gate ran[\s\S]*nothing written/);
  } finally {
    repo.cleanup();
  }
});

test("apply refuses a file whose head disagrees with the workflow's --head", async () => {
  const { repo, baseSha, headSha } = setup({ mode: 'enforce' });
  try {
    const gh = fakeGh(gateOpts(baseSha, headSha));
    const file = writeVerdict(repo.dir, (d) => {
      d.headSha = 'b'.repeat(40);
    });
    const out = [];
    assert.equal(await runApply([file, '--pr', URL, '--head', 'a'.repeat(40), ...AGENT, '--issue', '3'], deps(repo, gh, out)), 4);
    assert.equal(gh.calls.comment.length, 1, 'a flags mismatch is suspicious: commented');
    assert.equal(gh.calls.label.length, 1, 'and labeled needs-human');
    assert.equal(gh.calls.merge.length, 0);
    assert.match(out[0], /gate output did not survive the re-check/);
  } finally {
    repo.cleanup();
  }
});

test('--head with --local is a usage error', async () => {
  await assert.rejects(runCheck(['--local', '--head', 'a'.repeat(40)]), /--head only applies to a pull request/);
  await assert.rejects(runCheck([URL, '--head', 'not-a-sha']), /--head must be a 40-character commit sha/);
});
