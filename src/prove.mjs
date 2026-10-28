import { bucketPaths } from './classify.mjs';
import { matchesAny } from './glob.mjs';

// Proof required per kind (PROTOTYPE.md flow 2):
//   feature, bugfix  new test files fail on base (baseFailRuns/baseFailRuns, new tests only)
//                    and pass on head (headPassRuns/headPassRuns), and the counted
//                    test cases must not drop (testCountDropped)
//   refactor         zero test-file changes; full suite green on base and head,
//                    and the counted test cases must not drop (testCountDropped)
//   docs             only docs paths changed
//   deps             only manifests and lockfiles changed (never auto-merged, so no tests run)
// Every kind also needs CI green. Without a CI result (local preflight, or a repo
// with no checks) the full suite runs on head instead, with proof.headReruns
// reruns before a failure counts. CI still pending (after the caller's wait) is
// blocked, not weak: the agent cannot fix a slow workflow, so it is HUMAN.
// Every kind that runs tests also runs the full suite on base and head, even
// with CI, to compare case counts: a PR can make cases disappear without
// touching a test file, e.g. by deleting entries of a list in src/ the tests
// generate cases from. For a refactor, flow 2 also needs green on base and head.
//
// ctx: {
//   files: [{ path, status }], config,
//   ci: 'green' | 'red' | 'pending' | 'none' | null,
//   runBase(files | null) => { passed: string[], failed: string[], count?: number|null },  null = full suite
//   runHead(files | null) => { passed: string[], failed: string[], count?: number|null },
// }                                                                          count: full-suite runs only,
//                                                                           null/absent when the output doesn't parse
// Result: ok (proof holds), weak (the agent can fix it: RETRY), or neither
// (the gate can't prove anything, e.g. the suite is already red on base: HUMAN).
// tamperNotes is what the proof found out about the PR's honesty (a dropped
// test count); evaluate() turns it into HUMAN with no retry.

const pass = (text) => ({ ok: true, text });
const fail = (text) => ({ ok: false, text });

// The base tree has the PR's new test files checked out (they fail there), so
// an honest PR counts the same cases on both sides, whatever its kind.
// Unknown counts give no note, so any runner works.
function countDropped(base, head) {
  if (base.count == null || head.count == null || head.count >= base.count) return [];
  return [{ ok: false, rule: 'testCountDropped', text: `test count dropped from ${base.count} on base to ${head.count} on head` }];
}

function result(notes, { blocked = false, tamperNotes = [] } = {}) {
  // Tampering is never weak: a retry would only teach better cheating.
  const failed = notes.some((n) => !n.ok) || tamperNotes.length > 0;
  return { ok: !failed, weak: failed && !blocked && tamperNotes.length === 0, notes, tamperNotes };
}

// Runs the full suite on head up to 1 + headReruns times; the first green run
// (or the last one) decides, and its case count is kept for the drop check.
function headSuite(ctx) {
  let run = null;
  for (let i = 0; i <= ctx.config.proof.headReruns; i++) {
    run = ctx.runHead(null);
    if (run.failed.length === 0) return { green: true, run };
  }
  return { green: false, run };
}

// `head` reuses an already-run head suite instead of running it again.
function ciNote(ctx, head = null) {
  if (ctx.ci === 'green') return pass('CI green');
  if (ctx.ci === 'red') return fail('CI is red');
  if (ctx.ci === 'pending') return fail('CI has not finished');
  const suite = head ?? headSuite(ctx);
  return suite.green ? pass('full suite green on head') : fail('full suite fails on head');
}

// A new helper, fixture or snapshot under a test glob is not a test of its
// own: run alone it "passes" on base, which would make the proof weak.
// paths.testSupport names them; they still count as test paths for the kind.
// A file named like a test is always one, even in a support directory
// (tests/helpers/date.test.js tests src/helpers/date.js).
const TEST_NAMES = ['**/*.test.*', '**/*.spec.*'];
const isSupport = (p, config) => !matchesAny(p, TEST_NAMES) && matchesAny(p, config.paths.testSupport);

function proveNewTests(ctx) {
  const { baseFailRuns, headPassRuns } = ctx.config.proof;
  const newTests = ctx.files
    .filter((f) => f.status === 'A' && matchesAny(f.path, ctx.config.paths.tests))
    .map((f) => f.path)
    .filter((p) => !matchesAny(p, ctx.config.quarantine) && !isSupport(p, ctx.config));
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

/** @returns {{ ok: boolean, weak: boolean, notes: Array<{ ok: boolean, text: string }>,
 *              tamperNotes: Array<{ ok: false, rule: string, text: string }> }} */
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
      return result([pass('only docs changed'), ciNote(ctx)], { blocked: ctx.ci === 'pending' });
    case 'refactor': {
      if (b.tests.length > 0) return result([fail('a refactor must not change test files')]);
      const base = ctx.runBase(null);
      if (base.failed.length > 0) {
        return result([fail('full suite already fails on base, so a refactor cannot be proven')], { blocked: true });
      }
      const head = headSuite(ctx);
      const notes = [pass('no test changes; full suite green on base')];
      notes.push(head.green ? ciNote(ctx, head) : fail('full suite fails on head'));
      return result(notes, { blocked: head.green && ctx.ci === 'pending', tamperNotes: countDropped(base, head.run) });
    }
    case 'feature':
    case 'bugfix': {
      const proof = proveNewTests(ctx);
      if (proof.some((n) => !n.ok)) return result(proof);
      // The base suite is red here (the new tests fail on it); only its count matters.
      const base = ctx.runBase(null);
      const head = headSuite(ctx);
      return result([...proof, ciNote(ctx, head)], { blocked: ctx.ci === 'pending', tamperNotes: countDropped(base, head.run) });
    }
    default:
      return result([fail('changes fit no single kind (tests only, or nothing)')], { blocked: true });
  }
}
