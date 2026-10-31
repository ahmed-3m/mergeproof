// The helper scripts that are not part of the shipped package.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { listTestFiles } from '../scripts/run-tests.mjs';

test('listTestFiles returns only the top-level *.test.mjs files, sorted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-scripts-'));
  try {
    mkdirSync(join(dir, 'fixtures'));
    mkdirSync(join(dir, 'nested.test.mjs')); // a directory with a test-like name is not a suite
    for (const name of ['b.test.mjs', 'a.test.mjs', 'fixtures/c.test.mjs', 'helper.mjs', 'notes.test.md']) writeFileSync(join(dir, name), '');
    assert.deepEqual(listTestFiles(dir), [join(dir, 'a.test.mjs'), join(dir, 'b.test.mjs')]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listTestFiles finds every suite in this repo and none under fixtures', () => {
  const files = listTestFiles('tests').map((f) => f.split(sep).join('/'));
  assert.ok(files.includes('tests/structure.test.mjs'));
  assert.ok(files.includes('tests/scripts.test.mjs'));
  assert.ok(files.every((f) => /^tests\/[^/]+\.test\.mjs$/.test(f)), files.join(', '));
});
