// The fast dev-loop tier: `npm run test:fast` runs every suite except
// SLOW_SUITES. The full `npm test` behavior (all suites, fixtures excluded,
// sorted) is pinned by tests/scripts.test.mjs; this file pins only what the
// fast tier changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { listTestFiles, SLOW_SUITES } from '../scripts/run-tests.mjs';

const names = (files) => files.map((f) => f.split(sep).join('/').split('/').at(-1));

test('SLOW_SUITES is a frozen list of suite filenames', () => {
  assert.deepEqual([...SLOW_SUITES], [
    'apply.test.mjs',
    'benchmarks.test.mjs',
    'commands.test.mjs',
    'demo.test.mjs',
    'dispatch.test.mjs',
    'init.test.mjs',
    'workflows.test.mjs',
  ]);
  assert.ok(Object.isFrozen(SLOW_SUITES), 'the tier boundary must not be editable at runtime');
});

test('listTestFiles: fast drops exactly the slow suites, keeps everything else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-fast-tier-'));
  try {
    mkdirSync(join(dir, 'fixtures'));
    // One suite the fast tier keeps, two it drops, plus non-suite noise.
    for (const rel of ['zz-keep.test.mjs', ...[...SLOW_SUITES].slice(0, 3), 'fixtures/c.test.mjs', 'helper.mjs']) {
      writeFileSync(join(dir, rel), '');
    }
    mkdirSync(join(dir, 'nested.test.mjs')); // a directory with a test-like name
    const all = listTestFiles(dir);
    const fast = listTestFiles(dir, { fast: true });
    assert.deepEqual(names(all), [...[...SLOW_SUITES].slice(0, 3).sort(), 'zz-keep.test.mjs'].sort(), 'default behavior unchanged');
    assert.deepEqual(names(fast), ['zz-keep.test.mjs'], 'only the slow suites are dropped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listTestFiles: the fast tier of this repo is the full suite minus SLOW_SUITES', () => {
  const all = listTestFiles('tests');
  const fast = listTestFiles('tests', { fast: true });
  assert.ok(all.length > fast.length, 'this repo has slow suites to skip');
  const slowPresent = names(all).filter((n) => SLOW_SUITES.includes(n));
  assert.deepEqual(slowPresent, [...SLOW_SUITES], 'every slow suite exists at the top level of tests/');
  // The tiers partition the full run: nothing is dropped twice, nothing extra.
  assert.deepEqual([...names(fast), ...SLOW_SUITES].sort(), names(all).sort());
  assert.ok(names(fast).includes('loop.test.mjs'), 'the loop suite stays in the fast tier');
  assert.ok(!names(fast).includes('apply.test.mjs'));
});

test('package.json wires test:fast to run-tests.mjs --fast, still with zero dependencies', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts.test, 'node scripts/run-tests.mjs');
  assert.equal(pkg.scripts['test:fast'], 'node scripts/run-tests.mjs --fast');
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    assert.equal(pkg[key], undefined, `package.json must not declare ${key}`);
  }
});
