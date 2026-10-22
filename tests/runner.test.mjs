// parseTestCount: the runner adapter's per-format case-count parser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTestCount } from '../src/adapters/runner.mjs';

test('parseTestCount reads node:test spec reporter output', () => {
  const spec = ['✔ add (0.4ms)', '✔ mul (0.1ms)', 'ℹ tests 2', 'ℹ suites 0', 'ℹ pass 2', 'ℹ fail 0'].join('\n');
  assert.equal(parseTestCount(spec), 2);
  assert.equal(parseTestCount('i tests 7\ni pass 7\ni fail 0'), 7, 'the ascii i without the glyph');
  assert.equal(parseTestCount(spec.replace('\nℹ', '\r\nℹ')), 2, 'CRLF line endings');
});

test('parseTestCount reads TAP output', () => {
  const tap = ['TAP version 13', '# Subtest: tests/add.test.mjs', 'ok 1 - tests/add.test.mjs', '# tests 3', '# pass 3', '# fail 0'].join('\n');
  assert.equal(parseTestCount(tap), 3);
});

test('parseTestCount reads jest output', () => {
  const jest = ['Test Suites: 1 failed, 1 total', 'Tests:       4 passed, 1 failed, 5 total', 'Snapshots:   0 total', 'Time:        1.2s'].join('\n');
  assert.equal(parseTestCount(jest), 5);
  assert.equal(parseTestCount('Tests:       2 skipped, 2 total'), 2);
});

test('parseTestCount reads vitest output, using the total in parentheses', () => {
  const vitest = [' ✓ tests/a.test.ts (3 tests) 5ms', ' Test Files  2 passed (2)', '      Tests  4 passed | 1 failed (5)'].join('\n');
  assert.equal(parseTestCount(vitest), 5);
  assert.equal(parseTestCount('      Tests  26 passed (26)'), 26);
});

test('parseTestCount sums the pytest summary line', () => {
  assert.equal(parseTestCount('================= 3 passed, 1 failed in 0.10s =================='), 4);
  assert.equal(parseTestCount('==== 1 passed, 1 skipped, 1 xfailed, 1 xpassed, 2 warnings in 0.05s ===='), 4);
  assert.equal(parseTestCount('=========================== 2 errors in 0.12s ==========================='), 2);
  assert.equal(parseTestCount('==================== no tests ran in 0.01s ===================='), null);
});

test('parseTestCount uses the last summary when a run reports several', () => {
  assert.equal(parseTestCount('ℹ tests 2\nℹ tests 5'), 5);
  assert.equal(parseTestCount('# tests 1\n# tests 9'), 9);
  assert.equal(parseTestCount('==== 2 passed in 0.1s ====\n==== 1 passed in 0.2s ===='), 1);
});

test('parseTestCount returns null for output it cannot parse', () => {
  assert.equal(parseTestCount('all good\n'), null);
  assert.equal(parseTestCount(''), null);
  assert.equal(parseTestCount(null), null);
  assert.equal(parseTestCount('testing 123 tests ran fine'), null);
});

test('parseTestCount reads ANSI-colored summaries (CI often forces color)', () => {
  const csi = (s) => `\x1b[32m${s}\x1b[39m`;
  assert.equal(parseTestCount(csi('ℹ tests 2')), 2, 'colored node:test spec line');
  assert.equal(parseTestCount(`\x1b[1mTests:\x1b[0m       4 passed, 1 failed, \x1b[31m5 total\x1b[0m`), 5, 'colored jest line');
  assert.equal(parseTestCount(`\x1b[2K\x1b[1G\x1b[90m Tests \x1b[39m \x1b[32m4 passed\x1b[39m \x1b[90m(6)\x1b[39m`), 6, 'colored vitest line with cursor controls');
  assert.equal(parseTestCount('\x1b]0;title\x07ℹ tests 3'), 3, 'an OSC title sequence before the summary');
});
