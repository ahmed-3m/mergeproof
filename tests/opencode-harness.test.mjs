// The opencode harness in `mergeproof loop`: a first-class HARNESSES entry
// with its own argv shape, immediate stdin EOF (opencode run otherwise reads
// piped stdin until EOF and never starts the round), infra classification, and
// one full runLoop round against a real repo with the real check --local.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRepo, testFile, FIXED_MATH } from './fixtures/repo.mjs';
import { runProcess } from '../src/adapters/process.mjs';
import { runLoop, HARNESSES, harnessArgv, INFRA_REASONS, infraFailure, defaultDeps } from '../src/commands/loop.mjs';

const BIN = resolve('bin/mergeproof.mjs');

test('HARNESSES ships opencode, and harnessArgv builds its run invocation', () => {
  assert.deepEqual(HARNESSES.opencode, { bin: 'opencode' });
  assert.deepEqual(harnessArgv('opencode', { model: 'glm-4.7', prompt: 'fix the bug' }), {
    cmd: 'opencode',
    args: ['run', '--standalone', '--auto', '-m', 'glm-4.7', 'fix the bug'],
  });
  // addDirs are accepted (the loop always passes them) but opencode takes no
  // directory flags; the issue and handoff paths are already inside the prompt.
  assert.deepEqual(harnessArgv('opencode', { model: 'm', prompt: 'p', addDirs: ['/mergeproof'] }).args, [
    'run', '--standalone', '--auto', '-m', 'm', 'p',
  ]);
});

test('INFRA_REASONS covers the opencode start failure; infraFailure classifies its service errors', () => {
  assert.ok(INFRA_REASONS.includes('the opencode harness could not be started'));
  // code !== 0 is what makes a run failed; the labels are the generic ones.
  assert.equal(infraFailure('opencode', { code: 1, stdout: '', stderr: 'Error: unauthorized (401)' }), 'authentication failed (401/403)');
  assert.equal(infraFailure('opencode', { code: 1, stdout: '', stderr: '403 forbidden' }), 'authentication failed (401/403)');
  assert.equal(infraFailure('opencode', { code: 1, stdout: '', stderr: 'rate limit exceeded, retry later (429)' }), 'usage or rate limit reached (429)');
  assert.equal(infraFailure('opencode', { code: 1, stdout: '', stderr: 'provider is overloaded (529)' }), 'model overloaded (529)');
  assert.equal(infraFailure('opencode', { code: 1, stdout: '', stderr: 'model "nope" not found (404)' }), 'model not found (404)');
  // A clean run that merely mentions these things, and a timeout, are not infra.
  assert.equal(infraFailure('opencode', { code: 0, stdout: 'fixed the 429 retry handling', stderr: '' }), null);
  assert.equal(infraFailure('opencode', { code: null, timedOut: true, stdout: '', stderr: '401 unauthorized' }), null);
  assert.equal(infraFailure('opencode', { code: 1, stdout: '', stderr: 'the agent crashed' }), null);
});

test('runLoop with --harness opencode closes stdin immediately and a proof ends the loop proven', async (t) => {
  const repo = createRepo();
  repo.branch('agent/bugfix-1-multiply');
  const dir = mkdtempSync(join(tmpdir(), 'mp-opencode-'));
  t.after(() => {
    repo.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });
  const handoff = join(dir, 'handoff');
  writeFileSync(join(dir, 'issue.md'), '# issue\nmul(3, 3) is 10.\n');
  writeFileSync(join(dir, 'skill.md'), '# playbook\n');

  const calls = [];
  const deps = {
    ...defaultDeps,
    cwd: () => repo.dir,
    print: () => {},
    mergeproofBin: BIN,
    run(cmd, args, opts) {
      if (cmd !== 'opencode') return runProcess(cmd, args, opts); // the real check --local preflight
      calls.push({ cmd, args, opts });
      // The "opencode agent": fix the bug, prove it, write the handoff files.
      repo.write({ 'src/math.mjs': FIXED_MATH, 'tests/mul.test.mjs': testFile('mul by three', ['assert.equal(mul(3, 3), 9);']) });
      repo.commit('fix: multiply by three');
      writeFileSync(join(handoff, 'pr-title.txt'), 'fix: multiply by three\n');
      writeFileSync(join(handoff, 'pr-body.md'), '## Report\n');
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    },
  };

  const code = await runLoop(
    ['--harness', 'opencode', '--model', 'test-model', '--issue-file', join(dir, 'issue.md'), '--skill-file', join(dir, 'skill.md'), '--handoff', handoff, '--base', 'main'],
    deps,
  );
  assert.equal(code, 0);
  assert.equal(calls.length, 1, 'a held proof stops the loop after one round');
  const [call] = calls;
  assert.equal(call.cmd, 'opencode');
  assert.deepEqual(call.args, ['run', '--standalone', '--auto', '-m', 'test-model', call.args.at(-1)]);
  assert.equal(call.args.at(-1).startsWith('You are the mergeproof coding agent'), true, 'the prompt is the positional argument');
  assert.equal(call.opts.input, '', 'opencode run gets immediate stdin EOF');
  assert.equal(call.opts.cwd, repo.dir);
  assert.equal(call.opts.timeoutMs, 40 * 60 * 1000);

  const log = JSON.parse(readFileSync(join(handoff, 'loop.json'), 'utf8'));
  assert.equal(log.harness, 'opencode');
  assert.equal(log.proven, true);
  assert.equal(log.rounds.length, 1);
  assert.equal(log.rounds[0].proven, true);
  assert.ok(existsSync(join(handoff, 'pr-title.txt')), 'a proven round keeps its title');
  assert.equal(existsSync(join(handoff, 'stop-comment.md')), false);
  assert.equal(existsSync(join(handoff, 'infra-error.txt')), false);
});
