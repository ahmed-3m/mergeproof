import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VERDICTS, EXIT_CODES, MAX_NOTES, makeVerdict, formatVerdict } from '../src/verdict.mjs';

test('every verdict has an exit code', () => {
  for (const v of Object.keys(VERDICTS)) assert.equal(typeof EXIT_CODES[v], 'number');
});

test('unknown verdicts are rejected', () => {
  assert.throws(() => makeVerdict('MAYBE'), TypeError);
});

test('notes are capped and failures are kept first', () => {
  const notes = [
    { ok: true, text: 'CI green' },
    { ok: true, text: 'diff small' },
    { ok: true, text: 'kind matches paths' },
    { ok: false, text: 'existing test edited' },
  ];
  const v = makeVerdict('HUMAN', { kind: 'bugfix', notes });
  assert.equal(v.notes.length, MAX_NOTES);
  assert.equal(v.notes[0].text, 'existing test edited');
});

test('text format is a one-line verdict plus notes', () => {
  const v = makeVerdict('MERGE', { kind: 'refactor', notes: [{ ok: true, text: 'zero test files changed' }] });
  assert.equal(formatVerdict(v), 'Mergeproof — MERGE (kind: refactor)\n  ✓ zero test files changed');
  assert.deepEqual(JSON.parse(formatVerdict(v, { json: true })), v);
});
