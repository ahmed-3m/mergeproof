// MP-108: the ledger push union-merges events.jsonl by id.
//
// The push step in templates/workflows/mergeproof-pr.yml is extracted
// VERBATIM (string parse, dedented) and executed against a real bare
// remote with two concurrent clones — the same failure mode concurrent
// apply jobs hit:
// 1. two clones appending different records end with both on the remote,
//    no duplicates by id;
// 2. a record already on the remote is never rewritten by a stale push;
// 3. a malformed line fails the step instead of landing corrupt output.
// Structural tests pin the apply step recording events while the gate's
// check stays read-only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runProcess } from '../src/adapters/process.mjs';

const PR = readFileSync(resolve('templates/workflows/mergeproof-pr.yml'), 'utf8').replace(/\r\n/g, '\n');

/** A `run: |` block that follows a step with the given name, dedented. */
function runBlockAfterStep(text, stepName) {
  const nameIdx = text.indexOf(`name: ${stepName}`);
  assert.ok(nameIdx !== -1, `step "${stepName}" not found`);
  const runIdx = text.indexOf('run: |', nameIdx);
  assert.ok(runIdx !== -1, `no run block after "${stepName}"`);
  const lines = text.slice(runIdx + 'run: |'.length).split('\n');
  const indent = lines[0].match(/^\s*/)[0].length;
  const block = [];
  for (const line of lines.slice(1)) {
    if (line.trim() === '' || /^\s/.test(line)) block.push(line.slice(indent));
    else break;
  }
  return block.join('\n');
}

const PUSH_STEP = runBlockAfterStep(PR, 'Commit and push the ledger');

const git = (args, cwd, opts = {}) => {
  const res = runProcess('git', args, { cwd, timeoutMs: 60000, ...opts });
  assert.equal(res.code, 0, `git ${args.join(' ')} failed in ${cwd}: ${res.stderr}`);
  return res;
};

/** Run the verbatim push step inside `cloneDir` (env supplies the variables). */
function runPushStep(cloneDir, tmpDir, { timeoutMs = 120000, dates } = {}) {
  // The runner pre-creates RUNNER_TEMP; a sandbox must do it itself.
  mkdirSync(tmpDir, { recursive: true });
  return runProcess('bash', ['-c', PUSH_STEP], {
    cwd: cloneDir,
    timeoutMs,
    env: {
      ...process.env,
      ...(dates ? { GIT_AUTHOR_DATE: dates, GIT_COMMITTER_DATE: dates } : {}),
      LEDGER_DIR: join(cloneDir, '.mergeproof-ledger'),
      LEDGER_BRANCH: 'mergeproof-ledger',
      RUNNER_TEMP: tmpDir,
    },
  });
}

/** Bare remote + two independent clones with ledger worktrees, seeded. */
function sandbox(base) {
  const origin = join(base, 'origin.git');
  const seed = join(base, 'seed');
  const identity = {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
    },
  };
  git(['init', '--bare', '--initial-branch=main', origin], base);
  git(['clone', origin, seed], base, identity);
  git(['checkout', '-b', 'mergeproof-ledger'], seed);
  writeFileSync(join(seed, 'ledger.json'), JSON.stringify({ schema: 'mergeproof-ledger@1', outcomes: [] }, null, 2) + '\n', 'utf8');
  git(['add', '.'], seed);
  git(['commit', '-q', '-m', 'seed ledger'], seed, identity);
  git(['push', '-q', 'origin', 'mergeproof-ledger'], seed, identity);

  const clones = [];
  for (const name of ['a', 'b']) {
    const dir = join(base, name);
    git(['clone', '-q', origin, dir], base);
    git(['worktree', 'add', join(dir, '.mergeproof-ledger'), 'origin/mergeproof-ledger'], dir);
    clones.push(dir);
  }
  return { origin, clones };
}

/** Record one landing in a clone's ledger worktree (the way apply leaves it). */
function stageLanding(cloneDir, event, outcome) {
  appendFileSync(join(cloneDir, '.mergeproof-ledger', 'events.jsonl'), JSON.stringify(event) + '\n', 'utf8');
  const ledgerPath = join(cloneDir, '.mergeproof-ledger', 'ledger.json');
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  ledger.outcomes.push(outcome);
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n', 'utf8');
}

test('template wiring: apply records events, the gate stays read-only', () => {
  // The apply invocation carries --events; the check (gate) one does not:
  // the gate runs unprivileged in the proof worktrees and must never write
  // to the ledger branch.
  const applyIdx = PR.indexOf('command: apply');
  const applyBlock = PR.slice(applyIdx, PR.indexOf('Fail on apply', applyIdx));
  assert.match(applyBlock, /--events \.mergeproof-ledger\/events\.jsonl/);
  const checkIdx = PR.indexOf('command: check');
  const checkBlock = PR.slice(checkIdx, PR.indexOf('Fail on the gate', checkIdx));
  assert.doesNotMatch(checkBlock, /--events/);
  // The push step saves the events log aside before the retry loop.
  assert.match(PUSH_STEP, /events\.ours\.jsonl/);
});

test('two clones appending different records end with both on the remote (no dup ids)', () => {
  const base = mkdtempSync(join(tmpdir(), 'mp-events-union-'));
  try {
    const { clones } = sandbox(base);
    const [a, b] = clones;
    // Clone A records PR 11 and pushes (wins the race).
    stageLanding(a, { id: '11:aaaa:1', pr: 11, verdict: 'MERGE' }, { pr: 11, status: 'open' });
    const resA = runPushStep(a, join(base, 'tmp-a'));
    assert.equal(resA.code, 0, `push in A failed: ${resA.stderr}`);

    // Clone B was cloned before A pushed, so its remote refs are stale. It
    // records PR 12 and pushes: the retry must union-merge, not clobber.
    stageLanding(b, { id: '12:bbbb:1', pr: 12, verdict: 'HUMAN' }, { pr: 12, status: 'open' });
    const resB = runPushStep(b, join(base, 'tmp-b'));
    assert.equal(resB.code, 0, `push in B failed: ${resB.stderr}`);

    // The remote holds both records, each exactly once.
    git(['fetch', 'origin', 'mergeproof-ledger'], a);
    const events = git(['show', 'FETCH_HEAD:events.jsonl'], a).stdout;
    const ids = events.trim().split('\n').map((l) => JSON.parse(l).id);
    assert.deepEqual(ids.sort(), ['11:aaaa:1', '12:bbbb:1'], `remote events: ${events}`);
    const outcomes = JSON.parse(git(['show', 'FETCH_HEAD:ledger.json'], a).stdout).outcomes;
    assert.deepEqual(outcomes.map((o) => o.pr).sort(), [11, 12], 'both ledger outcomes land');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a stale push never rewrites a record already on the remote (remote wins by id)', () => {
  const base = mkdtempSync(join(tmpdir(), 'mp-events-stale-'));
  try {
    const { clones } = sandbox(base);
    const [a, b] = clones;
    // Both clones hold the SAME id with DIFFERENT content; A also carries
    // its own fresh record. B pushes first; A is then stale. The union must
    // keep the remote's version of the shared id, append A's fresh record,
    // and land nothing twice.
    stageLanding(b, { id: '13:cccc:1', pr: 13, verdict: 'HUMAN', fresh: true }, { pr: 13, status: 'open' });
    stageLanding(a, { id: '13:cccc:1', pr: 13, verdict: 'MERGE', fresh: false }, { pr: 13, status: 'open' });
    stageLanding(a, { id: '15:eeee:1', pr: 15, verdict: 'MERGE' }, { pr: 15, status: 'open' });
    const resB = runPushStep(b, join(base, 'tmp-b'));
    assert.equal(resB.code, 0, `push in B failed: ${resB.stderr}`);
    const resA = runPushStep(a, join(base, 'tmp-a'));
    assert.equal(resA.code, 0, `push in A failed: ${resA.stderr}`);
    git(['fetch', 'origin', 'mergeproof-ledger'], a);
    const events = git(['show', 'FETCH_HEAD:events.jsonl'], a).stdout;
    const records = events.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(records.filter((r) => r.id === '13:cccc:1').length, 1, 'exactly one record for the shared id');
    assert.equal(records.find((r) => r.id === '13:cccc:1').verdict, 'HUMAN', 'the remote version survived');
    assert.ok(records.some((r) => r.id === '15:eeee:1'), "the stale clone's fresh record still lands");
    const outcomes = JSON.parse(git(['show', 'FETCH_HEAD:ledger.json'], a).stdout).outcomes;
    assert.deepEqual(outcomes.map((o) => o.pr).sort(), [13, 15], 'both ledger outcomes land exactly once');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a malformed events line fails the merge instead of landing corrupt output', () => {
  const base = mkdtempSync(join(tmpdir(), 'mp-events-malformed-'));
  try {
    const { clones } = sandbox(base);
    const [a, b] = clones;
    // B wins the race with a clean record. A carries a malformed line, so
    // the union merge must fail the step rather than push corruption.
    stageLanding(b, { id: '14:dddd:1', pr: 14 }, { pr: 14, status: 'open' });
    runPushStep(b, join(base, 'tmp-b'));
    appendFileSync(join(a, '.mergeproof-ledger', 'events.jsonl'), '{not json\n', 'utf8');
    const resA = runPushStep(a, join(base, 'tmp-a'));
    assert.notEqual(resA.code, 0, 'the merge must fail on malformed input');
    git(['fetch', 'origin', 'mergeproof-ledger'], a);
    const events = git(['show', 'FETCH_HEAD:events.jsonl'], a).stdout;
    assert.ok(!events.includes('not json'), 'corrupt output never lands on the remote');
    assert.match(events, /14:dddd:1/, "the winner's clean record is intact");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('an event-only first landing on a fresh install persists instead of failing', () => {
  const base = mkdtempSync(join(tmpdir(), 'mp-events-fresh-'));
  try {
    // Fresh install: no ledger branch at all. The template bootstraps the
    // worktree as an orphan, exactly like its "start it as an orphan" step.
    const origin = join(base, 'origin.git');
    const identity = {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
      },
    };
    git(['init', '--bare', '--initial-branch=main', origin], base);
    const seed = join(base, 'seed');
    git(['clone', origin, seed], base, identity);
    writeFileSync(join(seed, 'README.md'), 'seed\n', 'utf8');
    git(['add', '.'], seed);
    git(['commit', '-q', '-m', 'seed'], seed, identity);
    git(['push', '-q', 'origin', 'main'], seed, identity);

    const clone = join(base, 'clone');
    git(['clone', '-q', origin, clone], base);
    const worktree = join(clone, '.mergeproof-ledger');
    git(['worktree', 'add', '--detach', worktree, 'HEAD'], clone);
    git(['checkout', '--orphan', 'mergeproof-ledger'], worktree);
    // The template runs `git rm -r --ignore-unmatch . || true` (the orphan
    // index still carries the detached tree); -f is the deterministic form.
    git(['rm', '-r', '--quiet', '--force', '--ignore-unmatch', '.'], worktree);

    // An unproven landing appends its event but writes no ledger entry, so
    // the worktree carries events.jsonl and nothing else.
    appendFileSync(join(worktree, 'events.jsonl'), JSON.stringify({ id: '20:ffff:1', pr: 20, verdict: 'RETRY' }) + '\n', 'utf8');
    const res = runPushStep(clone, join(base, 'tmp'));
    assert.equal(res.code, 0, `event-only push failed: ${res.stderr}`);

    // The ledger branch is born carrying the event — not lost, not red.
    git(['fetch', 'origin', 'mergeproof-ledger'], clone);
    const events = git(['show', 'FETCH_HEAD:events.jsonl'], clone).stdout;
    assert.match(events, /20:ffff:1/, 'the event-only landing persisted');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a retry whose union leaves nothing new is a no-op success', () => {
  const base = mkdtempSync(join(tmpdir(), 'mp-events-noop-'));
  try {
    const { clones } = sandbox(base);
    const [a, b] = clones;
    // Both clones record byte-identical landings. B pushes first; A's push
    // is rejected, and after the union nothing of A's is new — success, not
    // a "nothing to commit" failure. Pinned commit dates keep the two
    // commits distinct SHAs on every filesystem speed: on a fast runner the
    // identical trees would otherwise collide into the SAME commit (same
    // tree, parent, author and second), A's push would be an instant
    // "Everything up-to-date" and never exercise the union at all.
    const landing = [{ id: '21:aaaa:1', pr: 21, verdict: 'MERGE' }, { pr: 21, status: 'open' }];
    stageLanding(b, ...landing);
    stageLanding(a, ...landing);
    const resB = runPushStep(b, join(base, 'tmp-b'), { dates: '2005-04-07T22:13:13Z' });
    assert.equal(resB.code, 0, `push in B failed: ${resB.stderr}`);
    const resA = runPushStep(a, join(base, 'tmp-a'), { dates: '2020-01-01T00:00:00Z' });
    assert.equal(resA.code, 0, `no-op push failed: ${resA.stderr}`);
    assert.match(
      resA.stdout,
      /already carries everything/,
      `the no-op path says so (stdout=${JSON.stringify(resA.stdout)} stderr=${JSON.stringify(resA.stderr)})`,
    );

    git(['fetch', 'origin', 'mergeproof-ledger'], a);
    const events = git(['show', 'FETCH_HEAD:events.jsonl'], a).stdout;
    assert.equal(events.trim().split('\n').length, 1, 'exactly one record on the remote');
    const outcomes = JSON.parse(git(['show', 'FETCH_HEAD:ledger.json'], a).stdout).outcomes;
    assert.equal(outcomes.length, 1, 'exactly one outcome on the remote');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
