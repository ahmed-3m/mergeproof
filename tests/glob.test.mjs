import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesGlob } from '../src/glob.mjs';

test('** spans directories, including none', () => {
  assert.ok(matchesGlob('tests/a.test.mjs', 'tests/**'));
  assert.ok(matchesGlob('tests/deep/a.mjs', 'tests/**'));
  assert.ok(matchesGlob('a.test.js', '**/*.test.*'));
  assert.ok(matchesGlob('src/x/a.test.js', '**/*.test.*'));
  assert.ok(!matchesGlob('src/tests.js', 'tests/**'));
});

test('* and ? stay inside one segment', () => {
  assert.ok(matchesGlob('docs/a.md', 'docs/*.md'));
  assert.ok(!matchesGlob('docs/x/a.md', 'docs/*.md'));
  assert.ok(matchesGlob('v1.txt', 'v?.txt'));
  assert.ok(!matchesGlob('a.mdx', '**/*.md'));
});

test('patterns without a slash match the file name at any depth', () => {
  assert.ok(matchesGlob('package.json', 'package.json'));
  assert.ok(matchesGlob('packages/a/package.json', 'package.json'));
  assert.ok(!matchesGlob('package.json.bak', 'package.json'));
});
