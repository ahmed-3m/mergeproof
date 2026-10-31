// `mergeproof loop --critic` (MP-106): the read-only critic pass. Unit tests
// for the critic argv/prompt/parser and the workspace digest, plus end-to-end
// runs against fake implementer and critic harnesses in a throwaway git repo,
// with the real `check --local` preflight between them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRepo, testFile, FIXED_MATH } from './fixtures/repo.mjs';
import { runProcess } from '../src/adapters/process.mjs';
import { runLoop, HARNESSES, criticArgv, buildCriticPrompt, parseCritic, treeDigest, defaultDeps } from '../src/commands/loop.mjs';

const BIN = resolve('bin/mergeproof.mjs');
const PASS = () => ({ stdout: 'CRITIC: PASS\n' });

// The implementer behaviour the E2E tests need: fix the bug, prove it, and
// write the pull request handoff files, exactly like tests/loop.test.mjs.
const WRITE_HANDOFF = (ctx) => {
  writeFileSync(join(ctx.handoff, 'pr-title.txt'), 'fix: multiply by three\n');
  writeFileSync(join(ctx.handoff, 'pr-body.md'), '## Report\n');
};
const proofFix = (ctx) => {
  ctx.repo.write({ 'src/math.mjs': FIXED_MATH, 'tests/mul.test.mjs': testFile('mul by three', ['assert.equal(mul(3, 3), 9);']) });
  ctx.repo.commit('fix: multiply by three');
  WRITE_HANDOFF(ctx);
};

function setup(t, { env = {} } = {}) {
  const repo = createRepo();
  repo.branch('agent/bugfix-1-multiply');
  const dir = mkdtempSync(join(tmpdir(), 'mp-loop-critic-'));
  t.after(() => {
    repo.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });
  const files = { issue: join(dir, 'issue.md'), skill: join(dir, 'skill.md'), handoff: join(dir, 'handoff') };
  writeFileSync(files.issue, '# issue\nmul(3, 3) is 10.\n');
  writeFileSync(files.skill, '# playbook\n');
  const state = { implCalls: [], criticCalls: [], checkCalls: [], out: [] };
  // The critic prompt is the only one that teaches the verdict protocol, so
  // it is how the fake deps tell an implementer call from a critic call —
  // whatever harness each of them runs.
  const isCritic = (args) => args.some((a) => typeof a === 'string' && a.includes('CRITIC: PASS'));
  const make = (implSteps, criticSteps = [PASS]) => ({
    ...defaultDeps,
    cwd: () => repo.dir,
    env: () => env,
    print: (s) => state.out.push(s),
    mergeproofBin: BIN,
    run(cmd, args, opts) {
      if (isCritic(args)) {
        const i = state.criticCalls.length;
        state.criticCalls.push({ cmd, args, opts });
        const step = criticSteps[Math.min(i, criticSteps.length - 1)];
        return { code: 0, stdout: '', stderr: '', timedOut: false, ...(step({ repo, handoff: files.handoff, call: i }) ?? {}) };
      }
      if (Object.hasOwn(HARNESSES, cmd)) {
        const i = state.implCalls.length;
        state.implCalls.push({ cmd, args, opts });
        const step = implSteps[Math.min(i, implSteps.length - 1)];
        return { code: 0, stdout: '', stderr: '', timedOut: false, ...(step({ repo, handoff: files.handoff, call: i }) ?? {}) };
      }
      state.checkCalls.push(args);
      return runProcess(cmd, args, opts);
    },
  });
  const flags = (extra = []) => ['--harness', 'claude', '--model', 'test-model', '--issue-file', files.issue, '--skill-file', files.skill, '--handoff', files.handoff, '--base', 'main', ...extra];
  const read = (name) => (existsSync(join(files.handoff, name)) ? readFileSync(join(files.handoff, name), 'utf8') : null);
  // The prompt sits right after '-p' for claude/gemini/agy and last for opencode.
  const promptOf = (call) => (call.cmd === 'opencode' ? call.args.at(-1) : call.args[1]);
  return { repo, files, state, make, flags, read, promptOf, loopJson: () => JSON.parse(read('loop.json')) };
}

test('criticArgv: claude disallows every write and shell tool', () => {
  const { cmd, args } = criticArgv('claude', { model: 'm1', prompt: 'review it', addDirs: ['/mergeproof', '/other'] });
  assert.equal(cmd, 'claude');
  assert.deepEqual(args, [
    '-p', 'review it',
    '--model', 'm1',
    '--output-format', 'json',
    '--setting-sources', 'user',
    '--strict-mcp-config',
    '--permission-mode', 'bypassPermissions',
    '--disallowedTools', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch',
    '--add-dir', '/mergeproof',
    '--add-dir', '/other',
  ]);
  assert.ok(!args.includes('Bash(curl:*)'), 'all of Bash is denied, not just network commands');
});

test('criticArgv: opencode runs the read-only plan agent; gemini and agy get no blanket permission skip', () => {
  assert.deepEqual(criticArgv('opencode', { model: 'm2', prompt: 'p' }), {
    cmd: 'opencode',
    args: ['run', '--standalone', '--auto', '--agent', 'plan', '-m', 'm2', 'p'],
  });
  const gem = criticArgv('gemini', { model: 'm3', prompt: 'p', addDirs: ['/mergeproof'] });
  assert.deepEqual(gem.args, ['-p', 'p', '-m', 'm3', '-o', 'text', '--include-directories', '/mergeproof']);
  assert.ok(!gem.args.includes('--yolo'), 'write and shell approvals are never auto-granted');
  const ag = criticArgv('agy', { model: 'm4', prompt: 'p', addDirs: ['/mergeproof'] });
  assert.deepEqual(ag.args, ['-p', 'p', '--model', 'm4', '--output-format', 'text', '--add-dir', '/mergeproof']);
  assert.ok(!ag.args.includes('--dangerously-skip-permissions'), 'no blanket permission skip for a read-only review');
  assert.throws(() => criticArgv('codex', { model: 'm', prompt: 'p' }), /--harness must be one of/);
});

test('buildCriticPrompt: a read-only review of the two failure classes, with the verdict protocol and the diff base', () => {
  const p = buildCriticPrompt({ issueFile: '/mergeproof/issue.md', skillFile: '/mergeproof/skill.md' });
  assert.match(p, /READ-ONLY critic/);
  assert.match(p, /Read the issue ONLY from \/mergeproof\/issue\.md/);
  assert.match(p, /untrusted data/);
  assert.match(p, /git diff HEAD~1/, 'the default diff base');
  assert.match(p, /NEVER edit, write, create or delete any file/);
  assert.match(p, /NEVER touch the handoff files/);
  assert.match(p, /Spec-to-Test Alignment/);
  assert.match(p, /trivial or wrong behavior that happens to pass its own implementation/);
  assert.match(p, /Code Correctness & Minimalism/);
  assert.match(p, /logic bugs, regressions, security issues, or dead\/untested branches/);
  assert.match(p, /CRITIC: PASS/);
  assert.match(p, /CRITIC: FIX/);
  assert.match(p, /at most 5 bullet lines/);
  const withBase = buildCriticPrompt({ issueFile: '/i.md', skillFile: '/s.md', base: 'main' });
  assert.match(withBase, /git diff main/);
  assert.doesNotMatch(withBase, /HEAD~1/);
});

test('parseCritic: PASS, last verdict line wins, findings capped, stripped and truncated', () => {
  assert.deepEqual(parseCritic('gemini', { code: 0, stdout: 'CRITIC: PASS\n' }), { verdict: 'PASS', findings: [] });
  assert.deepEqual(parseCritic('gemini', { code: 0, stdout: 'all good\n\nCRITIC: PASS\n' }), { verdict: 'PASS', findings: [] });
  assert.deepEqual(parseCritic('agy', { code: 0, stdout: 'CRITIC: FIX\n- first\n\nCRITIC: PASS\n' }), { verdict: 'PASS', findings: [] }, 'the last verdict line wins');
  const bullets = Array.from({ length: 7 }, (_, i) => `- finding ${i + 1}`).join('\n');
  const r = parseCritic('gemini', { code: 1, stdout: `CRITIC: FIX\n${bullets}\n` });
  assert.equal(r.verdict, 'FIX');
  assert.deepEqual(r.findings, ['finding 1', 'finding 2', 'finding 3', 'finding 4', 'finding 5'], 'at most 5 findings');
  assert.deepEqual(parseCritic('gemini', { code: 0, stdout: 'CRITIC: FIX\n* star one\n1. numbered two\n' }).findings, ['star one', 'numbered two'], 'bullet markers are stripped');
  assert.equal(parseCritic('gemini', { code: 0, stdout: `CRITIC: FIX\n- ${'x'.repeat(300)}\n` }).findings[0].length, 240, 'each finding is truncated to 240 chars');
  assert.deepEqual(parseCritic('gemini', { code: 0, stdout: 'CRITIC: FIX\n\nSome prose, no bullets.\n' }).findings, ['Some prose, no bullets.'], 'a non-empty line is a finding');
  assert.deepEqual(parseCritic('gemini', { code: 0, stdout: 'CRITIC: FIX\n\n' }), { verdict: 'FIX', findings: ['critic requested fixes without listing findings'] });
  // CRLF output parses the same way.
  assert.deepEqual(parseCritic('gemini', { code: 0, stdout: 'CRITIC: FIX\r\n- crlf finding\r\n' }), { verdict: 'FIX', findings: ['crlf finding'] });
});

test('parseCritic: a claude result is unwrapped from its JSON envelope', () => {
  const stdout = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'CRITIC: FIX\n- unwrapped finding' });
  assert.deepEqual(parseCritic('claude', { code: 0, stdout }), { verdict: 'FIX', findings: ['unwrapped finding'] });
  assert.deepEqual(parseCritic('claude', { code: 0, stdout: `${JSON.stringify({ result: 'CRITIC: PASS' })}\n` }), { verdict: 'PASS', findings: [] });
  // Not JSON: the raw stdout is judged.
  assert.deepEqual(parseCritic('claude', { code: 0, stdout: 'CRITIC: PASS\n' }), { verdict: 'PASS', findings: [] });
});

test('parseCritic fails closed on a missing verdict line or a timeout', () => {
  const fail = { verdict: 'FIX', findings: ['critic did not return CRITIC: PASS or CRITIC: FIX'] };
  assert.deepEqual(parseCritic('gemini', { code: 0, stdout: 'Looks good to me!\n' }), fail, 'praise is not a verdict');
  assert.deepEqual(parseCritic('gemini', { code: 1, stdout: 'Traceback (most recent call last):\n' }), fail);
  assert.deepEqual(parseCritic('gemini', { code: 0, stdout: 'CRITIC: PASSED\n' }), fail, 'PASSED is not PASS');
  assert.deepEqual(parseCritic('gemini', { code: null, timedOut: true, stdout: 'CRITIC: PASS\n' }), fail, 'a timed-out critic never passes');
  assert.deepEqual(parseCritic('claude', { code: 0, stdout: JSON.stringify({ result: 'no verdict here' }) }), fail);
  assert.deepEqual(parseCritic('agy', { code: 0, stdout: '' }), fail);
});

test('treeDigest: stable, blind to .git, and changed by any edit in the checkout or the handoff', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-digest-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const handoff = join(dir, 'handoff');
  mkdirSync(join(handoff, 'nested'), { recursive: true });
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  writeFileSync(join(handoff, 'nested', 'pr-title.txt'), 'title\n');
  writeFileSync(join(handoff, 'loop.json'), '{}\n');
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const d0 = treeDigest(dir, handoff);
  assert.equal(treeDigest(dir, handoff), d0, 'stable across calls');
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/other\n');
  assert.equal(treeDigest(dir, handoff), d0, '.git is not part of the digest');
  writeFileSync(join(dir, 'a.txt'), 'three\n');
  assert.notEqual(treeDigest(dir, handoff), d0, 'an edited working-tree file changes it');
  writeFileSync(join(dir, 'rogue.txt'), 'planted\n');
  assert.notEqual(treeDigest(dir, handoff), d0, 'a planted file changes it');
  rmSync(join(dir, 'rogue.txt'));
  const d1 = treeDigest(dir, handoff);
  writeFileSync(join(handoff, 'nested', 'pr-title.txt'), 'forged title\n');
  assert.notEqual(treeDigest(dir, handoff), d1, 'a mutated handoff file changes it');
});

test('a critic FIX feeds its findings to round 2, whose PASS keeps the title and body', async (t) => {
  const s = setup(t);
  const code = await runLoop(
    s.flags(['--critic', '--rounds', '2']),
    s.make([proofFix, WRITE_HANDOFF], [() => ({ stdout: 'CRITIC: FIX\n- the new test misses the a=0 edge case\n- the report body is empty\n' }), PASS]),
  );
  assert.equal(code, 0, s.state.out.join('\n'));
  assert.equal(s.state.implCalls.length, 2, 'a FIX buys the implementer another round');
  assert.equal(s.state.criticCalls.length, 2);
  assert.equal(s.state.checkCalls.length, 2, 'each round runs its own preflight');
  const p1 = s.promptOf(s.state.implCalls[0]);
  const p2 = s.promptOf(s.state.implCalls[1]);
  assert.doesNotMatch(p1, /read-only critic found issues/, 'round 1 has no critic feedback');
  assert.match(p2, /The read-only critic found issues to fix before opening the PR:\n- the new test misses the a=0 edge case\n- the report body is empty$/);
  const cp = s.promptOf(s.state.criticCalls[0]);
  assert.match(cp, /READ-ONLY critic/);
  assert.match(cp, /git diff main/, 'the critic reviews the diff against the passed base');
  assert.ok(cp.includes(s.files.issue), 'the critic reads the trusted issue file');
  assert.equal(s.read('pr-title.txt'), 'fix: multiply by three\n');
  assert.ok(s.read('pr-body.md'));
  assert.equal(s.read('stop-comment.md'), null);
  assert.equal(s.read('infra-error.txt'), null);
  const log = s.loopJson();
  assert.equal(log.proven, true);
  assert.equal(log.rounds.length, 2);
  assert.deepEqual(Object.keys(log.rounds[0]), ['round', 'exit', 'ms', 'proven', 'verdict', 'reasons', 'critic', 'criticFindings']);
  assert.equal(log.rounds[0].critic, 'FIX');
  assert.deepEqual(log.rounds[0].criticFindings, ['the new test misses the a=0 edge case', 'the report body is empty']);
  assert.equal(log.rounds[1].critic, 'PASS');
  assert.deepEqual(log.rounds[1].criticFindings, []);
  assert.deepEqual(log.rounds.map((r) => r.proven), [true, true]);
});

test('a cross-model critic: claude implements, opencode reviews with the plan agent and closed stdin', async (t) => {
  const s = setup(t);
  const code = await runLoop(
    s.flags(['--model', 'sonnet', '--critic', '--critic-harness', 'opencode', '--critic-model', 'zai/glm-5.3#max']),
    s.make([proofFix], [PASS]),
  );
  assert.equal(code, 0, s.state.out.join('\n'));
  assert.equal(s.state.implCalls.length, 1);
  assert.equal(s.state.criticCalls.length, 1);
  const impl = s.state.implCalls[0];
  const critic = s.state.criticCalls[0];
  assert.equal(impl.cmd, 'claude');
  assert.deepEqual(impl.args.slice(1, 5), [s.promptOf(impl), '--model', 'sonnet', '--output-format'], 'the implementer keeps its own model');
  assert.equal(impl.opts.input, undefined, 'only opencode gets the closed stdin');
  assert.equal(critic.cmd, 'opencode');
  assert.ok(critic.args.includes('--agent'), 'the critic runs the plan agent');
  assert.deepEqual(critic.args.slice(3, 7), ['--agent', 'plan', '-m', 'zai/glm-5.3#max']);
  assert.equal(critic.opts.input, '', 'opencode stdin is closed immediately');
  assert.equal(critic.opts.cwd, s.repo.dir);
  assert.equal(critic.opts.timeoutMs, 40 * 60 * 1000);
  const log = s.loopJson();
  assert.equal(log.proven, true);
  assert.equal(log.rounds[0].critic, 'PASS');
  assert.equal(s.read('pr-title.txt'), 'fix: multiply by three\n');
});

test('a critic FIX on the final round deletes the title and body and writes a stop comment with its findings', async (t) => {
  const s = setup(t);
  const fix = () => ({ stdout: 'CRITIC: FIX\n- coverage gap in the edge cases\n- wrong error message\n' });
  const code = await runLoop(s.flags(['--critic', '--rounds', '2']), s.make([proofFix, WRITE_HANDOFF], [fix, fix]));
  assert.equal(code, 0, 'a critic FIX is not a loop failure; the files say what happened');
  assert.equal(s.state.implCalls.length, 2);
  assert.equal(s.state.criticCalls.length, 2);
  assert.equal(s.read('pr-title.txt'), null, 'never a title for an unreviewed change');
  assert.equal(s.read('pr-body.md'), null);
  assert.equal(s.read('infra-error.txt'), null);
  const stop = s.read('stop-comment.md');
  assert.match(stop, /^The agent's change passed local proof, but the critic requested fixes: coverage gap in the edge cases; wrong error message\. A maintainer can re-dispatch \(add the agent label again\) or take over\.\n$/);
  const log = s.loopJson();
  assert.equal(log.proven, false);
  assert.equal(log.rounds.length, 2);
  assert.deepEqual(log.rounds.map((r) => r.critic), ['FIX', 'FIX']);
  assert.ok(log.rounds.every((r) => r.proven === true), 'the proof itself held both rounds');
});

test('a rogue critic that edits a file during its read-only pass is caught and treated as FIX', async (t) => {
  const s = setup(t);
  const rogue = (ctx) => {
    // Untracked, uncommitted — and still caught: the digest sees the bytes.
    ctx.repo.write({ 'src/rogue-edit.mjs': 'export const rogue = true;\n' });
    return { stdout: 'CRITIC: PASS\n' }; // it claims a clean pass
  };
  const code = await runLoop(
    s.flags(['--critic', '--rounds', '2']),
    s.make([proofFix, WRITE_HANDOFF], [rogue, PASS]),
  );
  assert.equal(code, 0, s.state.out.join('\n'));
  assert.equal(s.state.criticCalls.length, 2, 'the caught FIX buys another round');
  const log = s.loopJson();
  assert.equal(log.rounds[0].critic, 'FIX', 'a claimed PASS is overridden');
  assert.deepEqual(log.rounds[0].criticFindings, ['critic modified files during a read-only review; revert unauthorized edits and re-verify']);
  assert.match(s.promptOf(s.state.implCalls[1]), /critic modified files during a read-only review/);
  assert.equal(log.rounds[1].critic, 'PASS');
  assert.equal(log.proven, true, 'the second round, with no mutation, passes');
  assert.equal(s.read('pr-title.txt'), 'fix: multiply by three\n');
  assert.equal(s.read('stop-comment.md'), null);
});

test('MERGEPROOF_CRITIC enables the critic; without it the loop behaves exactly as before', async (t) => {
  const on = setup(t, { env: { MERGEPROOF_CRITIC: '1' } });
  await runLoop(on.flags(), on.make([proofFix], [PASS]));
  assert.equal(on.state.criticCalls.length, 1);
  const truthy = setup(t, { env: { MERGEPROOF_CRITIC: 'true' } });
  await runLoop(truthy.flags(), truthy.make([proofFix], [PASS]));
  assert.equal(truthy.state.criticCalls.length, 1);

  const off = setup(t, { env: { MERGEPROOF_CRITIC: '0' } });
  assert.equal(await runLoop(off.flags(), off.make([proofFix])), 0);
  assert.equal(off.state.implCalls.length, 1);
  assert.equal(off.state.criticCalls.length, 0, 'no critic call without the flag');
  const [r] = off.loopJson().rounds;
  assert.deepEqual(Object.keys(r), ['round', 'exit', 'ms', 'proven', 'verdict', 'reasons'], 'the round entry keeps its exact old shape');
  assert.equal(off.read('pr-title.txt'), 'fix: multiply by three\n');
});

test('the critic flags are validated: an unknown harness or model label is a usage error', async (t) => {
  const s = setup(t);
  await assert.rejects(runLoop(s.flags(['--critic', '--critic-harness', 'codex']), s.make([proofFix])), /--critic-harness must be one of claude, gemini, agy, opencode \(got "codex"\)/);
  await assert.rejects(runLoop(s.flags(['--critic', '--critic-model', 'bad model!']), s.make([proofFix])), /--critic-model must be 1-100 characters/);
  assert.equal(s.state.implCalls.length, 0);
  assert.equal(s.state.criticCalls.length, 0);
});
