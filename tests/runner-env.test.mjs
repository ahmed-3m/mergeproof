// The runner adapter's environment scrub: GitHub Actions step-control files
// (GITHUB_ENV & co.) must never reach PR test code — a test appending to one
// rewrites every later step of the gate's own workflow — and neither may the
// runner's runtime tokens. cleanEnv is unit-tested on a plain object; runTests
// is proven against a real `node --test` child process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanEnv, runTests } from '../src/adapters/runner.mjs';

test('cleanEnv drops GitHub Actions control files, runtime values and credentials, keeps the rest', () => {
  const env = cleanEnv({
    PATH: '/usr/bin:/bin',
    HOME: '/home/runner',
    GITHUB_ENV: '/home/runner/work/_temp/environment.txt',
    GITHUB_PATH: '/home/runner/work/_temp/path.txt',
    GITHUB_OUTPUT: '/home/runner/work/_temp/output.txt',
    GITHUB_STEP_SUMMARY: '/home/runner/work/_temp/summary.md',
    GITHUB_STATE: 'state-9f1c',
    ACTIONS_RUNTIME_TOKEN: 'runtime-token-value',
    ACTIONS_RESULTS_URL: 'https://actions-results.githubusercontent.com/',
    GH_TOKEN: 'ghp_definitely-a-token',
    AWS_SECRET_KEY: 'aws-secret-value',
    NODE_TEST_CONTEXT: '7',
    GITHUB_REPOSITORY: 'owner/repo', // harmless context, must survive
  });
  for (const key of [
    'GITHUB_ENV',
    'GITHUB_PATH',
    'GITHUB_OUTPUT',
    'GITHUB_STEP_SUMMARY',
    'GITHUB_STATE',
    'ACTIONS_RUNTIME_TOKEN',
    'ACTIONS_RESULTS_URL',
    'GH_TOKEN',
    'AWS_SECRET_KEY',
    'NODE_TEST_CONTEXT',
  ]) {
    assert.equal(env[key], undefined, `${key} must be stripped from the child environment`);
  }
  assert.equal(env.PATH, '/usr/bin:/bin', 'PATH is not a step-control file and survives');
  assert.equal(env.HOME, '/home/runner');
  assert.equal(env.GITHUB_REPOSITORY, 'owner/repo');
  // Plain text either way: a colored summary would hide the case count.
  assert.equal(env.NO_COLOR, '1');
  assert.equal(env.FORCE_COLOR, '0');
});

test('cleanEnv defaults to process.env', () => {
  // Spot-check the default against a value every `node --test` child sees, so
  // the default parameter cannot silently drift to something else.
  const env = cleanEnv();
  assert.equal(env.NO_COLOR, '1');
  assert.equal(env.FORCE_COLOR, '0');
});

test('runTests: a child test run does not inherit GITHUB_ENV or GITHUB_PATH set in the parent', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-runner-env-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'tests'), { recursive: true });
  // The probe fails unless both variables are undefined in the child.
  writeFileSync(
    join(dir, 'tests', 'probe.test.mjs'),
    [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "test('no step-control files in the child environment', () => {",
      '  assert.equal(process.env.GITHUB_ENV, undefined);',
      '  assert.equal(process.env.GITHUB_PATH, undefined);',
      '});',
      '',
    ].join('\n'),
  );

  const saved = { GITHUB_ENV: process.env.GITHUB_ENV, GITHUB_PATH: process.env.GITHUB_PATH };
  process.env.GITHUB_ENV = join(dir, 'environment.txt');
  process.env.GITHUB_PATH = join(dir, 'path.txt');
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const res = runTests(dir, { testCommand: 'node --test', testFileCommand: 'node --test', only: ['tests/probe.test.mjs'] });
  assert.deepEqual(res.failed, [], 'the probe passes: the child saw neither variable');
  assert.deepEqual(res.passed, ['tests/probe.test.mjs']);
});
