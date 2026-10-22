import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendOutcome, emptyLedger, readLedger, trustFor, writeLedger, LEDGER_SCHEMA } from '../src/ledger.mjs';
import { formatTrailer, parseTrailer, TRAILER_KEY } from '../src/trailer.mjs';
import { FileFormatError } from '../src/errors.mjs';

const TRUST = { minOutcomes: 10, minCleanRate: 0.9, revertWindowDays: 14 };
const key = { kind: 'bugfix', agent: 'claude-code', model: 'glm-5.2' };

function outcome(pr, status, day = pr) {
  return { pr, ...key, skill: 'bugfix@1', attempts: 1, verdict: 'MERGE', mergedAt: `2026-01-${String(day).padStart(2, '0')}T00:00:00Z`, status };
}

function ledgerOf(statuses) {
  return { schema: LEDGER_SCHEMA, outcomes: statuses.map((s, i) => outcome(i + 1, s)) };
}

test('trust unlocks at 10 settled outcomes with at least 90% clean', () => {
  assert.equal(trustFor(emptyLedger(), key, TRUST).trusted, false);
  assert.equal(trustFor(ledgerOf(Array(9).fill('clean')), key, TRUST).trusted, false);
  const t = trustFor(ledgerOf(Array(10).fill('clean')), key, TRUST);
  assert.equal(t.trusted, true);
  assert.match(t.text, /trusted \(10 outcomes, 100% clean\)/);
});

test('pending merges do not count yet, and other buckets never count', () => {
  assert.equal(trustFor(ledgerOf([...Array(9).fill('clean'), 'pending']), key, TRUST).trusted, false);
  assert.equal(trustFor(ledgerOf(Array(10).fill('clean')), { ...key, model: 'other' }, TRUST).trusted, false);
  assert.equal(trustFor(ledgerOf(Array(10).fill('clean')), { ...key, kind: 'feature' }, TRUST).trusted, false);
});

test('pending merges cannot mask a revert (trust dilution)', () => {
  // 10 clean, 1 reverted, then 10 merges still inside their revert window:
  // the pending run must not push the revert out of the recent-settled window
  // and hand trust back before any of the new merges settles.
  const t = trustFor(ledgerOf([...Array(10).fill('clean'), 'reverted', ...Array(10).fill('pending')]), key, TRUST);
  assert.equal(t.trusted, false);
  assert.match(t.text, /lost trust/);
});

test('any revert in the last 10 merges drops trust', () => {
  const t = trustFor(ledgerOf([...Array(20).fill('clean'), 'reverted']), key, TRUST);
  assert.equal(t.trusted, false);
  assert.match(t.text, /lost trust/);
  assert.equal(trustFor(ledgerOf(['reverted', ...Array(19).fill('clean')]), key, { ...TRUST, minCleanRate: 0.9 }).trusted, true, 'an old revert ages out');
});

test('appendOutcome replaces an open entry for the same PR but never settled history', () => {
  let l = appendOutcome(emptyLedger(), outcome(7, 'open'));
  l = appendOutcome(l, { ...outcome(7, 'open'), attempts: 2 });
  assert.equal(l.outcomes.length, 1);
  assert.equal(l.outcomes[0].attempts, 2);
  const settled = appendOutcome(emptyLedger(), outcome(8, 'clean'));
  assert.throws(() => appendOutcome(settled, outcome(8, 'open')), /already has a settled outcome/);
  assert.throws(() => appendOutcome(emptyLedger(), { ...outcome(9, 'open'), kind: 'magic' }), TypeError);
});

test('ledger round-trips through disk and rejects bad files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-ledger-'));
  try {
    const path = join(dir, 'nested', 'ledger.json');
    assert.deepEqual(readLedger(path), emptyLedger(), 'missing file is an empty ledger');
    const l = ledgerOf(['clean', 'pending']);
    writeLedger(path, l);
    assert.deepEqual(readLedger(path), l);
    writeFileSync(path, '{"schema":"other@1","outcomes":[]}');
    assert.throws(() => readLedger(path), FileFormatError);
    writeFileSync(path, JSON.stringify({ schema: LEDGER_SCHEMA, outcomes: [{ pr: 1 }] }));
    assert.throws(() => readLedger(path), /outcomes\[0\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('trailer formats and parses back', () => {
  const line = formatTrailer({ pr: 42, kind: 'bugfix', agent: 'claude-code', model: 'glm-5.2', skill: 'bugfix@1', attempts: 1 });
  assert.equal(line, `${TRAILER_KEY}: merge pr=42 kind=bugfix agent=claude-code model=glm-5.2 skill=bugfix@1 attempts=1`);
  const msg = `fix: crash (#42)\n\nBody text\n\n${line}\n`;
  assert.deepEqual(parseTrailer(msg), { verdict: 'merge', pr: 42, kind: 'bugfix', agent: 'claude-code', model: 'glm-5.2', skill: 'bugfix@1', attempts: 1 });
  assert.equal(parseTrailer('plain commit'), null);
  assert.throws(() => formatTrailer({ agent: 'evil agent' }), TypeError);
  assert.throws(() => formatTrailer({ model: 'a\nMergeproof-Verdict: merge' }), TypeError);
});
