// MP-107/MP-108: the events log. Unit tests for readEvents/appendEvent/
// unionEvents (shape, validation, atomic append, dedupe, union semantics),
// an end-to-end run of `apply --events` (exactly one re-derived record per
// landing — MERGE, RETRY and a tamper landing; nothing for dry-run, refusals
// or a re-landing), and the pin that trustFor never reads events.jsonl.
// Real git repos, a fake `gh`, a captured printer (tests/apply-reasons.test.mjs style).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRepo, testFile, FIXED_MATH, BASE_FILES } from './fixtures/repo.mjs';
import { runCheck, defaultDeps as checkDeps } from '../src/commands/check.mjs';
import { runApply } from '../src/commands/apply.mjs';
import { checksState, parsePrUrl } from '../src/adapters/gh.mjs';
import { readLedger, trustFor } from '../src/ledger.mjs';
import { readEvents, appendEvent, unionEvents, DEFAULT_EVENTS } from '../src/events.mjs';
import { defaultConfig } from '../src/config.mjs';

const URL = 'https://github.com/acme/app/pull/77';
const DEMO = resolve('demo/ledger.json');
const GREEN = [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }];

// ---- readEvents / appendEvent / unionEvents (pure file behavior) ----------

const event = (over = {}) => ({
  id: '77:abc:1',
  at: '2026-10-22T12:00:00.000Z',
  pr: 77,
  issue: 3,
  kind: 'bugfix',
  agent: 'claude-code',
  model: 'glm-5.2',
  skill: 'bugfix@1',
  attempt: 1,
  verdict: 'RETRY',
  proven: false,
  reasons: ['NEW_TEST_PASSES_ON_BASE'],
  tamperRules: [],
  held: false,
  mode: 'enforce',
  merged: false,
  ...over,
});

test('DEFAULT_EVENTS lives under .mergeproof/, like the ledger', () => {
  assert.equal(DEFAULT_EVENTS, '.mergeproof/events.jsonl');
});

test('readEvents: a missing file is an empty log; a written log round-trips', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-events-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'events.jsonl');
  assert.deepEqual(readEvents(file), []);
  appendEvent(file, event());
  appendEvent(file, event({ id: '78:abc:1', pr: 78, verdict: 'MERGE', proven: true, merged: true }));
  assert.deepEqual(readEvents(file), [event(), event({ id: '78:abc:1', pr: 78, verdict: 'MERGE', proven: true, merged: true })]);
});

test('readEvents: malformed JSON, a missing id, pr or verdict is a FileFormatError', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-events-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'events.jsonl');
  const cases = [
    ['{not json}', /line 1 is not valid JSON/],
    [JSON.stringify({ pr: 77, verdict: 'MERGE' }), /line 1\.id must be a non-empty string/],
    [JSON.stringify({ id: 'x', verdict: 'MERGE' }), /line 1\.pr must be a PR number/],
    [JSON.stringify({ id: 'x', pr: 77 }), /line 1\.verdict must be one of MERGE \| RETRY \| HUMAN/],
  ];
  for (const [line, re] of cases) {
    writeFileSync(file, `${line}\n`);
    assert.throws(() => readEvents(file), re, line);
  }
  // A blank line is skipped (a trailing newline is the normal file ending).
  writeFileSync(file, '\n');
  assert.deepEqual(readEvents(file), []);
});

test('appendEvent: appends one JSONL line, atomically creating parents; same id twice appends once', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-events-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'deep', 'nested', 'events.jsonl');
  appendEvent(file, event());
  assert.equal(readFileSync(file, 'utf8'), `${JSON.stringify(event())}\n`);
  // Re-appending the same landing (same id, whatever the content) is a no-op.
  appendEvent(file, event({ verdict: 'MERGE', proven: true }));
  assert.equal(readEvents(file).length, 1);
  assert.equal(readEvents(file)[0].verdict, 'RETRY');
  appendEvent(file, event({ id: '77:abc:2', attempt: 2 }));
  assert.equal(readEvents(file).length, 2);
});

test('appendEvent: an invalid event is a TypeError, never a written line', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-events-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'events.jsonl');
  for (const bad of [null, 'x', [], {}]) {
    assert.throws(() => appendEvent(file, bad), TypeError, JSON.stringify(bad));
  }
  assert.throws(() => appendEvent(file, event({ verdict: 'MAYBE' })), /event\.verdict/);
  assert.throws(() => appendEvent(file, event({ pr: 0 })), /event\.pr/);
  assert.ok(!existsSync(file));
});

test('unionEvents: two concurrent landings both survive, no duplicates by id', () => {
  const a = event({ id: 'a' });
  const b = event({ id: 'b', pr: 78 });
  const c = event({ id: 'c', pr: 79 });
  // The remote (already pushed) has a and b; the stale local clone has a (its
  // own copy of the shared landing) and c (its own new landing).
  const remote = [a, b].map((e) => JSON.stringify(e)).join('\n') + '\n';
  const local = [a, c].map((e) => JSON.stringify(e)).join('\n') + '\n';
  const merged = unionEvents(remote, local);
  const events = merged.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => e.id), ['a', 'b', 'c'], 'remote order first, then only new local records');
  assert.equal(merged, [a, b, c].map((e) => JSON.stringify(e)).join('\n') + '\n');
});

test('unionEvents: a record already on the remote is never rewritten by a stale push', () => {
  const remote = `${JSON.stringify(event({ id: 'a', verdict: 'RETRY', reasons: ['NO_NEW_TEST'] }))}\n`;
  // The stale local copy claims the same landing merged with different data.
  const local = `${JSON.stringify(event({ id: 'a', verdict: 'MERGE', proven: true, merged: true, reasons: [] }))}\n`;
  const events = unionEvents(remote, local).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(events, [event({ id: 'a', verdict: 'RETRY', reasons: ['NO_NEW_TEST'] })]);
  // Empty inputs stay empty: no fabricated newline, no fabricated record.
  assert.equal(unionEvents('', ''), '');
});

// ---- apply --events (one re-derived record per landing) --------------------

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

// The honest fix (new test fails on base, passes on head) merges once bugfix
// is trusted (the demo ledger has exactly 10 clean bugfix outcomes).
const HONEST_CHANGE = { 'src/math.mjs': FIXED_MATH, 'tests/mul.test.mjs': testFile('mul by 3', ['assert.equal(mul(3, 2), 6);']) };
// A bugfix whose new test passes on base: the gate's proof is weak for
// NEW_TEST_PASSES_ON_BASE, so apply lands a RETRY.
const WEAK_CHANGE = { 'src/math.mjs': FIXED_MATH, 'tests/mul.test.mjs': testFile('mul by 3', ['assert.equal(mul(3, 2), 7);']) };
// A source change bundled with an edit to an existing test: the tamper rule
// existingTestEdited fires (HUMAN, no retry) and apply lands that HUMAN.
const TAMPER_CHANGE = {
  'src/math.mjs': FIXED_MATH,
  'tests/add.test.mjs': BASE_FILES['tests/add.test.mjs'].replace('assert.equal(add(2, 2), 4);', 'assert.equal(add(2, 2), 5);'),
};

function setup(change = WEAK_CHANGE, message = 'fix: mul by 3') {
  const gate = { testCommand: 'node --test', testFileCommand: 'node --test', mode: 'enforce', agents: { logins: ['agent-bot'], branchPrefixes: ['agent/'] } };
  const repo = createRepo({ ...BASE_FILES, '.mergeproof.json': JSON.stringify(gate) });
  const baseSha = repo.git(['rev-parse', 'HEAD']);
  repo.branch('agent/fix').write(change);
  const headSha = repo.commit(message);
  repo.git(['checkout', '--quiet', 'main']);
  mkdirSync(join(repo.dir, '.mergeproof'), { recursive: true });
  copyFileSync(DEMO, join(repo.dir, '.mergeproof', 'ledger.json'));
  return { repo, baseSha, headSha };
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

const PR_ARGS = ['--agent', 'claude-code', '--model', 'glm-5.2', '--skill', 'bugfix@1', '--issue', '3'];

/** Run the gate honestly for the repo's current change, then hand the file to apply. */
async function land(repo, baseSha, headSha, ghOverrides = {}, applyArgs = []) {
  const file = join(repo.dir, 'verdict.json');
  const gateGh = fakeGh({ baseSha, headSha, ...ghOverrides });
  const gateOut = [];
  await runCheck([URL, ...PR_ARGS, '--verdict-out', file], deps(repo, gateGh, gateOut));
  const gh = fakeGh({ baseSha, headSha, ...ghOverrides });
  const out = [];
  const code = await runApply([file, '--pr', URL, ...PR_ARGS, ...applyArgs], deps(repo, gh, out));
  return { code, gh, out };
}

test('apply --events writes exactly one record per landing, re-derived', async () => {
  const { repo, baseSha, headSha } = setup(WEAK_CHANGE);
  try {
    const eventsFile = join(repo.dir, '.mergeproof', 'events.jsonl');
    const { code, gh } = await land(repo, baseSha, headSha, {}, ['--events', eventsFile]);
    assert.equal(code, 3, 'the weak change lands as RETRY');
    assert.deepEqual(readEvents(eventsFile), [
      {
        id: `77:${headSha}:1`,
        at: '2026-10-22T12:00:00.000Z',
        pr: 77,
        issue: 3,
        kind: 'bugfix',
        agent: 'claude-code',
        model: 'glm-5.2',
        skill: 'bugfix@1',
        attempt: 1,
        verdict: 'RETRY',
        proven: false,
        reasons: ['NEW_TEST_PASSES_ON_BASE'],
        tamperRules: [],
        held: false,
        mode: 'enforce',
        merged: false,
      },
    ]);
    assert.equal(gh.calls.merge.length, 0);
  } finally {
    repo.cleanup();
  }
});

test('apply --events records a MERGE with proven and merged, and an empty reasons list', async () => {
  const { repo, baseSha, headSha } = setup(HONEST_CHANGE);
  try {
    const eventsFile = join(repo.dir, '.mergeproof', 'events.jsonl');
    const { code, gh } = await land(repo, baseSha, headSha, {}, ['--events', eventsFile]);
    assert.equal(code, 0, 'the honest, trusted change merges');
    assert.equal(gh.calls.merge.length, 1);
    assert.deepEqual(readEvents(eventsFile), [
      {
        id: `77:${headSha}:1`,
        at: '2026-10-22T12:00:00.000Z',
        pr: 77,
        issue: 3,
        kind: 'bugfix',
        agent: 'claude-code',
        model: 'glm-5.2',
        skill: 'bugfix@1',
        attempt: 1,
        verdict: 'MERGE',
        proven: true,
        reasons: [],
        tamperRules: [],
        held: false,
        mode: 'enforce',
        merged: true,
      },
    ]);
  } finally {
    repo.cleanup();
  }
});

test('apply --events records a tamper landing with its rule names', async () => {
  const { repo, baseSha, headSha } = setup(TAMPER_CHANGE);
  try {
    const eventsFile = join(repo.dir, '.mergeproof', 'events.jsonl');
    const { code } = await land(repo, baseSha, headSha, {}, ['--events', eventsFile]);
    assert.equal(code, 4, 'an edited existing test lands as HUMAN');
    const events = readEvents(eventsFile);
    assert.equal(events.length, 1);
    assert.equal(events[0].verdict, 'HUMAN');
    assert.equal(events[0].proven, false);
    assert.ok(events[0].tamperRules.includes('existingTestEdited'));
  } finally {
    repo.cleanup();
  }
});

test('a re-landing of the same PR, head and attempt never duplicates the record', async () => {
  const { repo, baseSha, headSha } = setup(WEAK_CHANGE);
  try {
    const eventsFile = join(repo.dir, '.mergeproof', 'events.jsonl');
    await land(repo, baseSha, headSha, {}, ['--events', eventsFile]);
    await land(repo, baseSha, headSha, {}, ['--events', eventsFile]);
    assert.equal(readEvents(eventsFile).length, 1);
  } finally {
    repo.cleanup();
  }
});

test('dry-run and suspect refusals write no event', async () => {
  const { repo, baseSha, headSha } = setup(WEAK_CHANGE);
  try {
    const eventsFile = join(repo.dir, '.mergeproof', 'events.jsonl');
    // dry-run: apply plans and writes nothing.
    await land(repo, baseSha, headSha, {}, ['--events', eventsFile, '--dry-run']);
    assert.ok(!existsSync(eventsFile), 'dry-run writes no event');
    // A forged file (MERGE claimed for a proof that did not hold) is refused
    // before the landing: nothing it says is measured.
    const file = join(repo.dir, 'verdict.json');
    const gateGh = fakeGh({ baseSha, headSha });
    await runCheck([URL, ...PR_ARGS, '--verdict-out', file], deps(repo, gateGh, []));
    const forged = JSON.parse(readFileSync(file, 'utf8'));
    forged.verdict = 'MERGE';
    writeFileSync(file, `${JSON.stringify(forged, null, 2)}\n`);
    const gh = fakeGh({ baseSha, headSha });
    const out = [];
    assert.equal(await runApply([file, '--pr', URL, ...PR_ARGS, '--events', eventsFile], deps(repo, gh, out)), 4);
    assert.ok(!existsSync(eventsFile), 'a suspect refusal writes no event');
  } finally {
    repo.cleanup();
  }
});

test('without --events apply writes no events file at all', async () => {
  const { repo, baseSha, headSha } = setup(WEAK_CHANGE);
  try {
    await land(repo, baseSha, headSha);
    assert.ok(!existsSync(join(repo.dir, '.mergeproof', 'events.jsonl')));
    assert.ok(!existsSync(join(repo.dir, 'events.jsonl')));
  } finally {
    repo.cleanup();
  }
});

// ---- the trust pin ---------------------------------------------------------

test('trustFor reads only ledger.outcomes: events.jsonl never feeds trust', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-events-trust-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = defaultConfig().trust;
  // Nine settled clean outcomes: one short of trust.minOutcomes (10).
  const outcome = (pr) => ({
    pr, kind: 'bugfix', agent: 'claude-code', model: 'glm-5.2', skill: 'bugfix@1',
    attempts: 1, verdict: 'MERGE', provenAt: '2026-09-01T10:00:00Z',
    mergedAt: `2026-09-${String(pr + 10).padStart(2, '0')}T10:00:00Z`, mergeCommit: null, status: 'clean',
  });
  const ledgerFile = join(dir, 'ledger.json');
  writeFileSync(ledgerFile, `${JSON.stringify({ schema: 'mergeproof-ledger@1', outcomes: Array.from({ length: 9 }, (_, i) => outcome(i + 1)) }, null, 2)}\n`);
  const eventsFile = join(dir, 'events.jsonl');
  // An events log bursting with clean merges for the very same bucket.
  const brag = event({ id: 'x', verdict: 'MERGE', proven: true, merged: true, reasons: [], attempt: 1 });
  appendEvent(eventsFile, brag);
  appendEvent(eventsFile, event({ ...brag, id: 'y' }));

  const without = trustFor(readLedger(ledgerFile), { kind: 'bugfix', agent: 'claude-code', model: 'glm-5.2' }, config);
  assert.equal(without.trusted, false, 'nine outcomes do not trust yet');
  const withEventsOnDisk = trustFor(readLedger(ledgerFile), { kind: 'bugfix', agent: 'claude-code', model: 'glm-5.2' }, config);
  // Deleting the events log changes nothing: trust never looked at it.
  rmSync(eventsFile);
  const withoutEvents = trustFor(readLedger(ledgerFile), { kind: 'bugfix', agent: 'claude-code', model: 'glm-5.2' }, config);
  assert.deepEqual(withEventsOnDisk, withoutEvents);
  assert.deepEqual(without, withoutEvents);
  assert.match(without.text, /9\/10 outcomes/);
});
