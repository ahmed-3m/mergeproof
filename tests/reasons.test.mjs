// src/reasons.mjs (MP-101): every weak-proof reason code renders to the exact
// note text src/prove.mjs prints, parameterized where the note names a file
// or counts. Pure unit tests, no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REASON_CODES, REASON_PARAMS, renderReason } from '../src/reasons.mjs';

const SAMPLE_PARAMS = {
  NO_NEW_TEST: {},
  NEW_TEST_PASSES_ON_BASE: { path: 'tests/mul.test.mjs' },
  FLAKY_ON_BASE: { path: 'tests/mul.test.mjs', n: 1, m: 2 },
  FAILS_ON_HEAD: { path: 'tests/mul.test.mjs' },
  FLAKY_ON_HEAD: { path: 'tests/mul.test.mjs', n: 2, m: 3 },
  SUITE_RED_ON_HEAD: {},
  SUITE_RED_ON_BASE: {},
  CI_RED: {},
  REFACTOR_CHANGES_TESTS: {},
  DIFF_UNCOVERED: { pct: 42, minPct: 80 },
};

test('REASON_CODES is the frozen list of weak-proof codes', () => {
  assert.ok(Object.isFrozen(REASON_CODES));
  assert.deepEqual([...REASON_CODES], [
    'NO_NEW_TEST',
    'NEW_TEST_PASSES_ON_BASE',
    'FLAKY_ON_BASE',
    'FAILS_ON_HEAD',
    'FLAKY_ON_HEAD',
    'SUITE_RED_ON_HEAD',
    'SUITE_RED_ON_BASE',
    'CI_RED',
    'REFACTOR_CHANGES_TESTS',
    'DIFF_UNCOVERED',
  ]);
});

test('every code declares exactly the parameters it takes', () => {
  assert.deepEqual(REASON_PARAMS, {
    NO_NEW_TEST: [],
    NEW_TEST_PASSES_ON_BASE: ['path'],
    FLAKY_ON_BASE: ['path', 'n', 'm'],
    FAILS_ON_HEAD: ['path'],
    FLAKY_ON_HEAD: ['path', 'n', 'm'],
    SUITE_RED_ON_HEAD: [],
    SUITE_RED_ON_BASE: [],
    CI_RED: [],
    REFACTOR_CHANGES_TESTS: [],
    DIFF_UNCOVERED: ['pct', 'minPct'],
  });
  for (const params of Object.values(REASON_PARAMS)) assert.ok(Object.isFrozen(params));
});

test('renderReason renders each code to the exact note text prove prints', () => {
  assert.equal(renderReason({ code: 'NO_NEW_TEST' }), 'no new test file to prove the change');
  assert.equal(renderReason({ code: 'NEW_TEST_PASSES_ON_BASE', path: 'tests/mul.test.mjs' }), 'new test tests/mul.test.mjs passes on base, so it proves nothing');
  assert.equal(renderReason({ code: 'FLAKY_ON_BASE', path: 'tests/mul.test.mjs', n: 1, m: 2 }), 'new test tests/mul.test.mjs is flaky on base (failed 1/2)');
  assert.equal(renderReason({ code: 'FAILS_ON_HEAD', path: 'tests/add.test.mjs' }), 'new test tests/add.test.mjs fails on head');
  assert.equal(renderReason({ code: 'FLAKY_ON_HEAD', path: 'tests/add.test.mjs', n: 2, m: 3 }), 'new test tests/add.test.mjs is flaky on head (passed 2/3)');
  assert.equal(renderReason({ code: 'SUITE_RED_ON_HEAD' }), 'full suite fails on head');
  assert.equal(renderReason({ code: 'SUITE_RED_ON_BASE' }), 'full suite already fails on base, so a refactor cannot be proven');
  assert.equal(renderReason({ code: 'CI_RED' }), 'CI is red');
  assert.equal(renderReason({ code: 'REFACTOR_CHANGES_TESTS' }), 'a refactor must not change test files');
  assert.equal(renderReason({ code: 'DIFF_UNCOVERED', pct: 42, minPct: 80 }), 'diff line coverage is 42% (needs 80%)');
});

test('every code in REASON_CODES renders', () => {
  for (const code of REASON_CODES) {
    const text = renderReason({ code, ...SAMPLE_PARAMS[code] });
    assert.equal(typeof text, 'string', code);
    assert.ok(text.length > 0, code);
  }
});

test('a plain string works for parameterless codes', () => {
  for (const code of ['NO_NEW_TEST', 'SUITE_RED_ON_HEAD', 'SUITE_RED_ON_BASE', 'CI_RED', 'REFACTOR_CHANGES_TESTS']) {
    assert.equal(renderReason(code), renderReason({ code }));
  }
});

test('an unknown code or non-reason input is a TypeError', () => {
  for (const bad of [null, undefined, 42, 'NOT_A_CODE', '', 'no_new_test', 'ci red', {}, { code: 'NO_SUCH_CODE' }, { code: 7 }, { code: null }, []]) {
    assert.throws(() => renderReason(bad), TypeError, JSON.stringify(bad));
  }
});

test('a missing or wrongly-typed parameter is a TypeError', () => {
  for (const bad of [
    { code: 'NEW_TEST_PASSES_ON_BASE' },
    { code: 'NEW_TEST_PASSES_ON_BASE', path: '' },
    { code: 'NEW_TEST_PASSES_ON_BASE', path: 7 },
    { code: 'FLAKY_ON_BASE', path: 'tests/a.test.mjs' },
    { code: 'FLAKY_ON_BASE', path: 'tests/a.test.mjs', n: 1 },
    { code: 'FLAKY_ON_BASE', path: 'tests/a.test.mjs', m: 2 },
    { code: 'FLAKY_ON_BASE', path: 'tests/a.test.mjs', n: 1.5, m: 2 },
    { code: 'FLAKY_ON_HEAD', path: 'tests/a.test.mjs', n: 2, m: '3' },
    { code: 'FAILS_ON_HEAD' },
    { code: 'FAILS_ON_HEAD', path: null },
    { code: 'DIFF_UNCOVERED' },
    { code: 'DIFF_UNCOVERED', pct: 10 },
    { code: 'DIFF_UNCOVERED', minPct: 10 },
    { code: 'DIFF_UNCOVERED', pct: '10', minPct: 20 },
    { code: 'DIFF_UNCOVERED', pct: NaN, minPct: 20 },
  ]) {
    assert.throws(() => renderReason(bad), TypeError, JSON.stringify(bad));
  }
  // A plain string carries no parameters, so it only works for parameterless codes.
  assert.throws(() => renderReason('FLAKY_ON_BASE'), TypeError);
  assert.throws(() => renderReason('DIFF_UNCOVERED'), TypeError);
});
