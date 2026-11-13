// MP-123: retro shows maintainer rejections of proven PRs (measurement only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, formatRetro } from '../src/retro.mjs';
import { trustFor } from '../src/ledger.mjs';

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

const outcome = (pr, status, extra = {}) => ({
  pr,
  kind: 'bugfix',
  agent: 'claude-code',
  model: 'glm-5.2',
  skill: 'bugfix@4',
  attempts: 1,
  verdict: 'MERGE',
  provenAt: '2026-09-01T10:00:00Z',
  mergedAt: status === 'open' || status === 'closed' ? null : `2026-09-0${pr}T10:00:00Z`,
  mergeCommit: status === 'open' || status === 'closed' ? null : `deadbeef${pr}`,
  status,
  ...extra,
});

function fixtureLedger() {
  return {
    schema: 'mergeproof-ledger@1',
    outcomes: [
      outcome(1, 'clean'),
      outcome(2, 'clean'),
      outcome(3, 'clean'),
      outcome(4, 'reverted'),
      outcome(5, 'pending'),
      outcome(6, 'closed', { closedBy: 'alice', closedByAuthor: false }),
      outcome(7, 'closed', { closedBy: 'alice', closedByAuthor: false }),
      // Other buckets do not spill into bugfix.
      outcome(8, 'closed', { kind: 'docs', skill: null, closedBy: 'alice', closedByAuthor: false }),
    ],
  };
}

test('summarize computes rejected, decided and cleanRateWithRejections for a bucket', () => {
  const events = Array.from({ length: 5 }, (_, i) => event({ id: `e${i}`, pr: i + 1 }));
  const [g] = summarize(events, fixtureLedger(), { minN: 5 });
  assert.equal(g.rejected, 2);
  assert.equal(g.decided, 7); // 3 clean + 1 reverted + 1 pending + 2 rejected
  assert.equal(g.cleanRateWithRejections, 3 / 6); // 3 / (3 + 1 + 2)
});

test('summarize ignores closed outcomes with closedByAuthor true, null or missing', () => {
  const events = Array.from({ length: 5 }, (_, i) => event({ id: `e${i}`, pr: i + 1 }));
  const base = fixtureLedger();
  const withNonRejections = {
    ...base,
    outcomes: [
      ...base.outcomes,
      outcome(9, 'closed', { closedBy: 'claude-code', closedByAuthor: true }),
      outcome(10, 'closed', { closedBy: null, closedByAuthor: null }),
      outcome(11, 'closed'),
      outcome(12, 'open'),
    ],
  };
  const [a] = summarize(events, base, { minN: 5 });
  const [b] = summarize(events, withNonRejections, { minN: 5 });
  assert.equal(b.rejected, a.rejected);
  assert.equal(b.decided, a.decided);
  assert.equal(b.cleanRateWithRejections, a.cleanRateWithRejections);
});

test('summarize sets cleanRateWithRejections to null when clean + reverted + rejected is 0', () => {
  const events = [event({ id: 'e1', pr: 1 })];
  const ledger = {
    schema: 'mergeproof-ledger@1',
    outcomes: [
      outcome(1, 'pending'),
      outcome(2, 'open'),
      outcome(3, 'closed', { closedBy: 'claude-code', closedByAuthor: true }),
      outcome(4, 'closed', { closedBy: null, closedByAuthor: null }),
      outcome(5, 'closed'),
    ],
  };
  const [g] = summarize(events, ledger, { minN: 1 });
  assert.equal(g.rejected, 0);
  assert.equal(g.decided, 1); // only pending
  assert.equal(g.cleanRateWithRejections, null);
  assert.equal(summarize(events, null, { minN: 1 })[0].cleanRateWithRejections, null);
});

test('formatRetro prints the rejection line at or above minN and omits it below minN', () => {
  const events = [
    ...Array.from({ length: 5 }, (_, i) => event({ id: `b${i}`, pr: i + 1 })),
    event({ id: 'd1', pr: 20, kind: 'docs', skill: null }),
    event({ id: 'd2', pr: 21, kind: 'docs', skill: null }),
  ];
  const groups = summarize(events, fixtureLedger(), { minN: 5 });
  const text = formatRetro(groups, { minN: 5 });
  const lines = text.split('\n');

  const bugfixIdx = lines.findIndex((l) => l.startsWith('bugfix  '));
  const docsIdx = lines.findIndex((l) => l.startsWith('docs  '));
  assert.ok(bugfixIdx !== -1 && docsIdx > bugfixIdx);

  const bugfixBlock = lines.slice(bugfixIdx, docsIdx).join('\n');
  assert.match(bugfixBlock, /2 rejected · 7 decided · clean with rejections 50%/);

  const docsBlock = lines.slice(docsIdx).join('\n');
  assert.match(docsBlock, /insufficient data \(n=2 < 5\)/);
  assert.doesNotMatch(docsBlock, /rejected/);
});

test('formatRetro keeps every existing line unchanged when the ledger has no closed outcomes', () => {
  const events = [
    event({ id: 'a', pr: 1, proven: true, merged: true }),
    event({ id: 'b', pr: 2, proven: true, merged: true }),
    event({ id: 'c', pr: 3, proven: true, merged: true }),
    event({ id: 'd', pr: 4, proven: true, merged: true }),
    event({ id: 'e', pr: 5, verdict: 'HUMAN', proven: false, merged: false }),
  ];
  const ledger = {
    schema: 'mergeproof-ledger@1',
    outcomes: [outcome(1, 'clean'), outcome(2, 'reverted'), outcome(3, 'pending')],
  };
  const text = formatRetro(summarize(events, ledger, { minN: 5 }), { minN: 5 });
  const lines = text.split('\n');
  assert.equal(lines[0], 'Mergeproof retro');
  assert.equal(lines[1], 'bugfix  claude-code/glm-5.2  skill=bugfix@4  runs=5');
  assert.equal(lines[2], '  first-try proven 80% · retry→proven - · mean attempts 1.0 · merged 80% · reverted 50%');
  assert.equal(lines[3], '  HUMAN reasons: 0 tamper · 0 human-only · 0 untrusted · 1 other');
  assert.equal(lines[4], '  rejections: 0 rejected · 3 decided · clean with rejections 50%');
  assert.equal(lines.length, 5);
});

test('trustFor returns the same result with and without closedBy fields', () => {
  const withFields = fixtureLedger();
  const withoutFields = {
    ...withFields,
    outcomes: withFields.outcomes.map(({ closedBy: _c, closedByAuthor: _a, ...rest }) => rest),
  };
  const bucket = { kind: 'bugfix', agent: 'claude-code', model: 'glm-5.2' };
  const cfg = { minOutcomes: 3, minCleanRate: 0.7 };
  assert.deepEqual(trustFor(withFields, bucket, cfg), trustFor(withoutFields, bucket, cfg));
});
