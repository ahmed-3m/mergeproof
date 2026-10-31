// The verdict file `mergeproof-verdict@2` (MP-103): carries the structured
// weak-proof `reasons` of src/reasons.mjs, round-trips through
// writeVerdictFile/readVerdictFile, and still accepts a `@1` file (which
// predates reasons) so a gate job and an apply job on different versions
// work together. Anything else — unknown schema, malformed reasons — is a
// FileFormatError before apply ever looks at the file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileFormatError } from '../src/errors.mjs';
import { VERDICT_FILE_SCHEMA, readVerdictFile, writeVerdictFile } from '../src/verdictfile.mjs';

const RETRY = {
  schema: 'mergeproof-verdict@2',
  url: 'https://github.com/acme/app/pull/7',
  pr: 7,
  headSha: 'a'.repeat(40),
  kind: 'bugfix',
  verdict: 'RETRY',
  notes: [{ ok: false, text: 'new test tests/mul.test.mjs passes on base, so it proves nothing' }],
  reasons: [{ code: 'NEW_TEST_PASSES_ON_BASE', path: 'tests/mul.test.mjs' }],
  proven: false,
  agent: 'claude-code',
  model: 'glm-5.2',
  skill: 'bugfix@1',
  attempts: 2,
  issue: 3,
};

test('writeVerdictFile writes @2 and readVerdictFile round-trips the structured reasons', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-verdict2-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'verdict.json');
  writeVerdictFile(file, { ...RETRY });
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.schema, 'mergeproof-verdict@2');
  assert.deepEqual(raw.reasons, [{ code: 'NEW_TEST_PASSES_ON_BASE', path: 'tests/mul.test.mjs' }]);
  const v = readVerdictFile(file);
  assert.equal(v.schema, VERDICT_FILE_SCHEMA);
  assert.deepEqual(v.reasons, [{ code: 'NEW_TEST_PASSES_ON_BASE', path: 'tests/mul.test.mjs' }]);

  // Every parameter kind the codes carry survives the round trip.
  const reasons = [
    { code: 'FLAKY_ON_BASE', path: 'tests/a.test.mjs', n: 1, m: 2 },
    { code: 'FLAKY_ON_HEAD', path: 'tests/b.test.mjs', n: 2, m: 3 },
    { code: 'CI_RED' },
    { code: 'DIFF_UNCOVERED', pct: 12, minPct: 80 },
    { code: 'SUITE_RED_ON_HEAD' },
  ];
  writeVerdictFile(file, { ...RETRY, reasons });
  assert.deepEqual(readVerdictFile(file).reasons, reasons);
});

test('a @1 file (no reasons key) reads and is normalized to reasons: []', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-verdict1-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'verdict.json');
  const v1 = { ...RETRY };
  delete v1.reasons;
  v1.schema = 'mergeproof-verdict@1';
  writeFileSync(file, `${JSON.stringify(v1, null, 2)}\n`);
  const v = readVerdictFile(file);
  assert.equal(v.schema, 'mergeproof-verdict@1');
  assert.deepEqual(v.reasons, []);
  assert.equal(v.verdict, 'RETRY');
  // A @1 file may not carry reasons: the schema predates them.
  const withReasons = { ...v1, reasons: [] };
  writeFileSync(file, `${JSON.stringify(withReasons)}\n`);
  assert.throws(() => readVerdictFile(file), (err) => err.name === 'FileFormatError' && /unknown key "reasons"/.test(err.message));
});

test('an unknown schema is rejected with both accepted names in the message', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-verdict99-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'verdict.json');
  for (const schema of ['mergeproof-verdict@99', 'mergeproof-verdict@0', 'mergeproof-verdict', '']) {
    writeFileSync(file, `${JSON.stringify({ ...RETRY, schema })}\n`);
    assert.throws(
      () => readVerdictFile(file),
      (err) => err.name === 'FileFormatError' && err.message.includes('schema must be "mergeproof-verdict@2" or "mergeproof-verdict@1"'),
      schema,
    );
  }
});

test('malformed reasons are rejected before apply sees the file', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-verdictr-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'verdict.json');
  const cases = [
    [(d) => { delete d.reasons; }, /missing key "reasons"/],
    [(d) => { d.reasons = 'no'; }, /reasons must be an array/],
    [(d) => { d.reasons = {}; }, /reasons must be an array/],
    [(d) => { d.reasons = Array.from({ length: 21 }, () => ({ code: 'CI_RED' })); }, /reasons must have at most 20 entries/],
    [(d) => { d.reasons = [{ code: 'CI_RED' }, null]; }, /reasons\[1\] must be an object/],
    [(d) => { d.reasons = ['CI_RED']; }, /reasons\[0\] must be an object/],
    [(d) => { d.reasons = [{ code: 'CI_RED', evil: 1 }]; }, /reasons\[0\] must not carry "evil"/],
    [(d) => { d.reasons = [{ code: 'ci_red' }]; }, /reasons\[0\]\.code must be/],
    [(d) => { d.reasons = [{ code: '' }]; }, /reasons\[0\]\.code must be/],
    [(d) => { d.reasons = [{ code: 'X'.repeat(51) }]; }, /reasons\[0\]\.code must be/],
    [(d) => { d.reasons = [{ code: 'FOO BAR' }]; }, /reasons\[0\]\.code must be/],
    [(d) => { d.reasons = [{ code: 42 }]; }, /reasons\[0\]\.code must be/],
    [(d) => { d.reasons = [{ code: 'NEW_TEST_PASSES_ON_BASE', path: 'a`b' }]; }, /reasons\[0\]\.path must be/],
    [(d) => { d.reasons = [{ code: 'NEW_TEST_PASSES_ON_BASE', path: 'x'.repeat(301) }]; }, /reasons\[0\]\.path must be/],
    [(d) => { d.reasons = [{ code: 'NEW_TEST_PASSES_ON_BASE', path: 'line\nbreak' }]; }, /reasons\[0\]\.path must be/],
    [(d) => { d.reasons = [{ code: 'CI_RED', n: 1.5 }]; }, /reasons\[0\]\.n must be an integer/],
    [(d) => { d.reasons = [{ code: 'CI_RED', m: '2' }]; }, /reasons\[0\]\.m must be an integer/],
    [(d) => { d.reasons = [{ code: 'DIFF_UNCOVERED', pct: 12, minPct: 80, extra: 3 }]; }, /reasons\[0\] must not carry "extra"/],
  ];
  for (const [mutate, msg] of cases) {
    const data = { ...RETRY };
    mutate(data);
    writeFileSync(file, `${JSON.stringify(data)}\n`);
    assert.throws(() => readVerdictFile(file), (err) => err.name === 'FileFormatError' && msg.test(err.message), String(msg));
  }
});

test('a well-shaped but semantically forged reason still reads: apply judges it (MP-104)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-verdictf-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'verdict.json');
  // Unknown code, a path, counts with n ≥ m: all shape-valid, so the file
  // reads — apply renders each of these as "suspect" instead.
  writeVerdictFile(file, {
    ...RETRY,
    reasons: [{ code: 'FOO_BAR' }, { code: 'NEW_TEST_PASSES_ON_BASE', path: 'tests/not-in-diff.test.mjs' }, { code: 'FLAKY_ON_BASE', path: 'tests/a.test.mjs', n: 2, m: 2 }],
  });
  const v = readVerdictFile(file);
  assert.equal(v.reasons.length, 3);
});
