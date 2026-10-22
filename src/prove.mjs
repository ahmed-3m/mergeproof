import { bucketPaths } from './classify.mjs';
import { matchesAny } from './glob.mjs';

// Proof required per kind (PROTOTYPE.md flow 2):
//   feature, bugfix  new test files fail on base (baseFailRuns/baseFailRuns, new tests only)
//                    and pass on head (headPassRuns/headPassRuns)
//   refactor         zero test-file changes; full suite green on base and head
//   docs             only docs paths changed
//   deps             only manifests and lockfiles changed (never auto-merged, so no tests run)
// Every kind also needs CI green. Without a CI result (local preflight, or a repo
// with no checks) the full suite runs on head instead, with proof.headReruns
// reruns before a failure counts.
//
// ctx: {
//   files: [{ path, status }], config,
//   ci: 'green' | 'red' | 'pending' | 'none' | null,
//   runBase(files | null) => { passed: string[], failed: string[] },  null = full suite
//   runHead(files | null) => { passed: string[], failed: string[] },
// }
// Result: ok (proof holds), weak (the agent can fix it: RETRY), or neither
// (the gate can't prove anything, e.g. the suite is already red on base: HUMAN).

const pass = (text) => ({ ok: true, text });
const fail = (text) => ({ ok: false, text });

function result(notes, { blocked = false } = {}) {
  const failed = notes.some((n) => !n.ok);
  return { ok: !failed, weak: failed && !blocked, notes };
}

// Runs the full suite on head up to 1 + headReruns times; true once it passes.
function headSuiteGreen(ctx) {
  for (let i = 0; i <= ctx.config.proof.headReruns; i++) {
    if (ctx.runHead(null).failed.length === 0) return true;
  }
  return false;
}

function ciNote(ctx) {
  if (ctx.ci === 'green') return pass('CI green');
  if (ctx.ci === 'red') return fail('CI is red');
  if (ctx.ci === 'pending') return fail('CI has not finished');
  return headSuiteGreen(ctx) ? pass('full suite green on head') : fail('full suite fails on head');
}

function proveNewTests(ctx) {
  const { baseFailRuns, headPassRuns } = ctx.config.proof;
  const newTests = ctx.files
    .filter((f) => f.status === 'A' && matchesAny(f.path, ctx.config.paths.tests))
    .map((f) => f.path)
    .filter((p) => !matchesAny(p, ctx.config.quarantine));
  if (newTests.length === 0) return [fail('no new test file to prove the change')];

  const baseFails = Object.fromEntries(newTests.map((t) => [t, 0]));
  for (let i = 0; i < baseFailRuns; i++) {
    for (const t of ctx.runBase(newTests).failed) if (t in baseFails) baseFails[t]++;
  }
  const notes = [];
  for (const t of newTests) {
    if (baseFails[t] === 0) notes.push(fail(`new test ${t} passes on base, so it proves nothing`));
    else if (baseFails[t] < baseFailRuns) notes.push(fail(`new test ${t} is flaky on base (failed ${baseFails[t]}/${baseFailRuns})`));
  }
  if (notes.length > 0) return notes;

  const headPasses = Object.fromEntries(newTests.map((t) => [t, 0]));
  for (let i = 0; i < headPassRuns; i++) {
    for (const t of ctx.runHead(newTests).passed) if (t in headPasses) headPasses[t]++;
  }
  for (const t of newTests) {
    if (headPasses[t] === 0) notes.push(fail(`new test ${t} fails on head`));
    else if (headPasses[t] < headPassRuns) notes.push(fail(`new test ${t} is flaky on head (passed ${headPasses[t]}/${headPassRuns})`));
  }
  if (notes.length > 0) return notes;
  const n = newTests.length === 1 ? 'new test' : `${newTests.length} new tests`;
  return [pass(`${n} fail on base ${baseFailRuns}/${baseFailRuns} and pass on head ${headPassRuns}/${headPassRuns}`)];
}

/** @returns {{ ok: boolean, weak: boolean, notes: Array<{ ok: boolean, text: string }> }} */
export function proveChange(kind, ctx) {
  const b = bucketPaths(ctx.files.map((f) => f.path), ctx.config);
  switch (kind) {
    case 'deps':
      return result([
        b.source.length + b.tests.length > 0
          ? fail('dependency change bundled with code changes')
          : pass('only manifests and lockfiles changed'),
      ]);
    case 'docs':
      return result([pass('only docs changed'), ciNote(ctx)]);
    case 'refactor': {
      if (b.tests.length > 0) return result([fail('a refactor must not change test files')]);
      if (ctx.runBase(null).failed.length > 0) {
        return result([fail('full suite already fails on base, so a refactor cannot be proven')], { blocked: true });
      }
      return result([pass('no test changes; full suite green on base'), ciNote(ctx)]);
    }
    case 'feature':
    case 'bugfix': {
      const proof = proveNewTests(ctx);
      if (proof.some((n) => !n.ok)) return result(proof);
      return result([...proof, ciNote(ctx)]);
    }
    default:
      return result([fail('changes fit no single kind (tests only, or nothing)')], { blocked: true });
  }
}
