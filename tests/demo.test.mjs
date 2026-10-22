// The demo (`npm run demo`) end to end against real git repos and real test
// runs: the four PRs documented in demo/README.md, with the seeded ledger and
// from a cold start. The child `node --test` runs the gate spawns inside
// `npm test` must still fail on base — src/adapters/runner.mjs strips
// NODE_TEST_CONTEXT, and a MERGE verdict for PR 1 proves the base runs failed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { runDemo } from '../demo/build.mjs';
import { emptyLedger, readLedger } from '../src/ledger.mjs';

const SEEDED = readLedger(resolve('demo/ledger.json'));

test('demo with the seeded ledger: MERGE, MERGE, HUMAN, RETRY', () => {
  const rows = runDemo({ ledger: SEEDED });
  assert.deepEqual(
    rows.map((r) => r.verdict),
    ['MERGE', 'MERGE', 'HUMAN', 'RETRY'],
    JSON.stringify(rows.map((r) => r.notes)),
  );
  assert.deepEqual(rows.map((r) => r.expected), ['MERGE', 'MERGE', 'HUMAN', 'RETRY']);
  assert.deepEqual(
    rows.map((r) => r.kind),
    ['bugfix', 'refactor', 'bugfix', 'feature'],
  );
});

test('demo from a cold start (empty ledger): HUMAN, HUMAN, HUMAN, RETRY', () => {
  const rows = runDemo({ ledger: emptyLedger(), run: 'cold' });
  assert.deepEqual(
    rows.map((r) => r.verdict),
    ['HUMAN', 'HUMAN', 'HUMAN', 'RETRY'],
    JSON.stringify(rows.map((r) => r.notes)),
  );
  // PRs 1 and 2 flip to HUMAN on trust alone; 3 and 4 never depended on it.
  assert.match(rows[0].notes.join(' '), /not trusted yet/);
  assert.match(rows[1].notes.join(' '), /not trusted yet/);
  assert.match(rows[2].notes.join(' '), /edits existing test/);
  assert.match(rows[3].notes.join(' '), /passes on base/);
});
