// `mergeproof retro` (MP-109): pure summarize/formatRetro tests plus the
// command pipeline over temp files (no network, no git).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarize, formatRetro } from '../src/retro.mjs';
import { runRetro, defaultDeps } from '../src/commands/retro.mjs';
import { UsageError } from '../src/errors.mjs';

const event = (over = {}) => ({
  id: '1:abc:1',
  at: '2026-10-01T00:00:00Z',
  pr: 1,
  issue: null,
  kind: 'bugfix',
  agent: 'claude-code',
  model: 'glm-5.2',
  skill: 'bugfix@4',
  attempt: 1,
  verdict: 'MERGE',
  proven: true,
  reasons: [],
  tamperRules: [],
  held: false,
  mode: 'enforce',
  merged: true,
  ...over,
});

// ---- summarize -------------------------------------------------------------

test('summarize groups by (kind, agent, model, skill) and counts the core rates', () => {
  const groups = summarize(
    [
      event({ pr: 1, attempt: 1, proven: true, merged: true }),
      event({ id: '1:abc:2', pr: 1, attempt: 2, proven: false, verdict: 'RETRY', merged: false }),
      event({ id: '2:abc:1', pr: 2, attempt: 1, proven: false, verdict: 'RETRY', merged: false }),
      // A different skill version is its own row; a different kind too.
      event({ id: '3:abc:1', pr: 3, skill: 'bugfix@3', proven: true, merged: false }),
      event({ id: '4:abc:1', pr: 4, kind: 'docs', skill: null, merged: false }),
    ],
    null,
    { minN: 3 },
  );
  assert.equal(groups.length, 3);
  const bugfix = groups[0];
  assert.deepEqual([bugfix.kind, bugfix.agent, bugfix.model, bugfix.skill], ['bugfix', 'claude-code', 'glm-5.2', 'bugfix@4']);
  assert.equal(bugfix.runs, 3);
  assert.equal(bugfix.insufficient, false); // 3 runs meet minN 3
  assert.equal(bugfix.firstTryProvenRate, 1 / 2); // pr1 proven, pr2 not
  assert.equal(bugfix.retryProvenRate, 0 / 1); // the pr1 retry stayed weak
  assert.equal(bugfix.meanAttempts, (2 + 1) / 2); // max attempt per distinct pr
  assert.equal(bugfix.mergeRate, 1 / 2); // distinct prs 1 (merged) and 2 (not)
  assert.deepEqual(bugfix.humanReasons, { tamper: 0, humanOnly: 0, untrusted: 0, other: 0 });
  assert.equal(bugfix.revertRate, null); // no ledger supplied
  // null skill normalizes to 'none'
  assert.deepEqual([groups[2].kind, groups[2].skill], ['docs', 'none']);
});

test('summarize: 3 runs are insufficient at minN 5, sufficient at minN 3', () => {
  const events = [event(), event({ id: 'b' }), event({ id: 'c' })];
  assert.equal(summarize(events, null, { minN: 5 })[0].insufficient, true);
  assert.equal(summarize(events, null, { minN: 3 })[0].insufficient, false);
});

test('summarize: rates are null when the group has no first-try or no retry runs', () => {
  const onlyRetries = summarize([event({ id: 'r1', pr: 9, attempt: 2 }), event({ id: 'r2', pr: 9, attempt: 3, proven: false })]);
  assert.equal(onlyRetries[0].firstTryProvenRate, null);
  assert.equal(onlyRetries[0].retryProvenRate, 1 / 2);
  const onlyFirst = summarize([event(), event({ id: 'f2', pr: 8 })]);
  assert.equal(onlyFirst[0].retryProvenRate, null);
});

test('summarize: HUMAN reasons keep tamper, human-only holds, untrusted and other apart', () => {
  const groups = summarize([
    event({ id: 't', pr: 1, verdict: 'HUMAN', proven: false, tamperRules: ['existingTestEdited'], merged: false }),
    event({ id: 't2', pr: 2, verdict: 'HUMAN', proven: true, tamperRules: ['gateFilesEdited', 'kindLabelMismatch'], merged: false }),
    event({ id: 'h', pr: 3, verdict: 'HUMAN', proven: true, held: true, merged: false }),
    event({ id: 'u', pr: 4, verdict: 'HUMAN', proven: true, merged: false }),
    event({ id: 'o', pr: 5, verdict: 'HUMAN', proven: false, merged: false }),
    // MERGE and RETRY runs never land in the histogram.
    event({ id: 'm', pr: 6, verdict: 'MERGE', proven: true }),
    event({ id: 'r', pr: 7, verdict: 'RETRY', proven: false, held: true }),
  ]);
  assert.deepEqual(groups[0].humanReasons, { tamper: 2, humanOnly: 1, untrusted: 1, other: 1 });
});

test('summarize: a missing kind normalizes to unknown, its own group', () => {
  const groups = summarize([event({ id: 'n', kind: null })]);
  assert.deepEqual([groups[0].kind, groups[0].skill], ['unknown', 'bugfix@4']);
});

test('summarize: revertRate comes from settled ledger outcomes of the same bucket', () => {
  const outcome = (pr, status) => ({
    pr, kind: 'bugfix', agent: 'claude-code', model: 'glm-5.2', skill: 'bugfix@4',
    attempts: 1, verdict: 'MERGE', provenAt: '2026-09-01T10:00:00Z',
    mergedAt: '2026-09-02T10:00:00Z', mergeCommit: null, status,
  });
  const ledger = {
    schema: 'mergeproof-ledger@1',
    outcomes: [
      outcome(1, 'clean'), outcome(2, 'clean'), outcome(3, 'clean'), outcome(4, 'reverted'),
      // Never counted: pending, open, closed, and other buckets.
      outcome(5, 'pending'), outcome(6, 'open'), outcome(7, 'closed'),
      { ...outcome(8, 'reverted'), skill: 'bugfix@3' },
      { ...outcome(9, 'reverted'), kind: 'docs', skill: null },
    ],
  };
  const events = Array.from({ length: 5 }, (_, i) => event({ id: `e${i}`, pr: i + 1 }));
  const g = summarize(events, ledger, { minN: 1 })[0];
  assert.equal(g.revertRate, 1 / 4); // 1 reverted of 4 settled in this bucket
  // No settled outcomes for the bucket → null, not zero.
  const none = summarize(events, { schema: 'mergeproof-ledger@1', outcomes: [outcome(5, 'pending')] }, { minN: 1 })[0];
  assert.equal(none.revertRate, null);
});

// ---- formatRetro -----------------------------------------------------------

test('formatRetro: a group below minN shows "insufficient data", a full group shows its rates', () => {
  const small = summarize([event(), event({ id: 'b' })]);
  const text = formatRetro(small);
  assert.match(text, /insufficient data \(n=2 < 5\)/);
  assert.doesNotMatch(text, /first-try proven/);
  const enoughEvents = [
    event({ id: 'a', pr: 1 }),
    event({ id: 'b', pr: 2 }),
    event({ id: 'c', pr: 3 }),
    event({ id: 'd', pr: 4 }),
    event({ id: 'e', pr: 5, verdict: 'HUMAN', proven: false, merged: false }),
  ];
  const rich = formatRetro(summarize(enoughEvents, null, { minN: 5 }), { minN: 5 });
  assert.doesNotMatch(rich, /insufficient data/);
  assert.match(rich, /first-try proven 80%/);
  assert.match(rich, /merged 80%/);
  assert.match(rich, /HUMAN reasons: 0 tamper · 0 human-only · 0 untrusted · 1 other/);
  // The bar is summarize()'s to move: the same five runs re-summarized at a
  // higher minN are insufficient.
  assert.match(formatRetro(summarize(enoughEvents, null, { minN: 6 }), { minN: 6 }), /insufficient data \(n=5 < 6\)/);
});

test('formatRetro: an empty events log says so instead of an empty table', () => {
  assert.match(formatRetro([]), /no events/);
});

// ---- runRetro (the command) -------------------------------------------------

function writeLog(dir, { events = [event()], ledger = null } = {}) {
  writeFileSync(join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  if (ledger) writeFileSync(join(dir, 'ledger.json'), `${JSON.stringify(ledger, null, 2)}\n`);
}

async function run(argv) {
  const out = [];
  const code = await runRetro(argv, { ...defaultDeps, print: (s) => out.push(s) });
  return { code, out };
}

test('runRetro reads .mergeproof/ledger.json + events.jsonl from --ledger <dir>', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-retro-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, '.mergeproof');
  mkdirSync(home);
  writeLog(home, { events: Array.from({ length: 6 }, (_, i) => event({ id: `e${i}`, pr: i + 1 })) });
  const { code, out } = await run(['--ledger', home]);
  assert.equal(code, 0);
  assert.match(out.join('\n'), /bugfix  claude-code\/glm-5\.2  skill=bugfix@4  runs=6/);
  assert.doesNotMatch(out.join('\n'), /insufficient data/);
});

test('runRetro --json prints the summarize() groups; --min-n moves the insufficient bar', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-retro-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, '.mergeproof');
  mkdirSync(home);
  writeLog(home, { events: [event(), event({ id: 'b' })] });
  const json = await run(['--ledger', home, '--json']);
  const groups = JSON.parse(json.out.join('\n'));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].runs, 2);
  assert.equal(groups[0].insufficient, true);
  assert.deepEqual(groups[0].humanReasons, { tamper: 0, humanOnly: 0, untrusted: 0, other: 0 });
  // The same two runs are enough at --min-n 2.
  const relaxed = await run(['--ledger', home, '--min-n', '2', '--json']);
  assert.equal(JSON.parse(relaxed.out.join('\n'))[0].insufficient, false);
});

test('runRetro --ledger <ledger.json> finds events.jsonl next to it', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-retro-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeLog(dir, { events: [event()] });
  const { code, out } = await run(['--ledger', join(dir, 'ledger.json')]);
  assert.equal(code, 0);
  assert.match(out.join('\n'), /runs=1/);
  // An explicit --events overrides the neighbor default.
  const custom = join(dir, 'other-events.jsonl');
  writeFileSync(custom, `${JSON.stringify(event({ id: 'z', kind: 'docs', skill: null }))}\n`);
  const alt = await run(['--ledger', join(dir, 'ledger.json'), '--events', custom]);
  assert.match(alt.out.join('\n'), /docs  claude-code\/glm-5\.2  skill=none  runs=1/);
});

test('runRetro: a repo with no events yet is an empty report, not an error', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-retro-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { code, out } = await run(['--ledger', dir]);
  assert.equal(code, 0);
  assert.match(out.join('\n'), /no events/);
});

test('runRetro validates its flags', async () => {
  await assert.rejects(run(['positional']), UsageError);
  await assert.rejects(run(['--min-n', '0']), UsageError);
  await assert.rejects(run(['--ledger', 'not-a-json']), UsageError);
});
