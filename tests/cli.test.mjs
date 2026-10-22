import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const CLI = resolve('bin/mergeproof.mjs');
const PKG = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

test('--version prints the package version', () => {
  const res = run(['--version']);
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), PKG.version);
});

test('no arguments and --help print usage', () => {
  for (const args of [[], ['--help']]) {
    const res = run(args);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /Usage:/);
  }
});

test('unknown command exits with the usage code', () => {
  const res = run(['explode']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /unknown command "explode"/);
});

test('check validates its arguments before running', () => {
  assert.equal(run(['check']).status, 2);
  assert.equal(run(['check', 'https://github.com/o/r/pull/1', '--local']).status, 2);
  assert.equal(run(['check', '--bogus']).status, 2);
});

test('a bad PR URL is a usage error', () => {
  const res = run(['check', 'https://github.com/o/r/issues/1']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /not a pull request URL/);
});

test('runtime failures exit 1 with a one-line reason, not a stack trace', () => {
  const res = spawnSync(process.execPath, [CLI, 'check', '--local'], { encoding: 'utf8', cwd: tmpdir() });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /^mergeproof check: git rev-parse failed/);
  assert.doesNotMatch(res.stderr, /\n\s+at /);
});
