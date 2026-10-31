// Weak-proof reason codes (MP-101): the structured twin of the free-text
// notes src/prove.mjs emits. Rendering is pure — no I/O, no imports — so the
// same table serves the gate (prove builds its notes from it), the verdict
// file (`mergeproof-verdict@2` carries the codes, never the text) and apply
// (which re-derives what it can and renders the text itself, so a forged
// file can never put its own words on a pull request).

export const REASON_CODES = Object.freeze([
  'NO_NEW_TEST',
  'NEW_TEST_PASSES_ON_BASE',
  'FLAKY_ON_BASE',
  'FAILS_ON_HEAD',
  'FLAKY_ON_HEAD',
  'SUITE_RED_ON_HEAD',
  'SUITE_RED_ON_BASE',
  'CI_RED',
  'REFACTOR_CHANGES_TESTS',
  'DIFF_UNCOVERED',
]);

// The parameters each code carries beyond `code` itself. `path` names a test
// file, `n`/`m` are run counts (failed/passed out of m runs), `pct`/`minPct`
// are percentages. A code only ever accepts the parameters listed here.
export const REASON_PARAMS = Object.freeze(
  Object.fromEntries(
    Object.entries({
      NO_NEW_TEST: [],
      NEW_TEST_PASSES_ON_BASE: ['path'],
      FLAKY_ON_BASE: ['path', 'n', 'm'],
      FAILS_ON_HEAD: ['path'],
      FLAKY_ON_HEAD: ['path', 'n', 'm'],
      SUITE_RED_ON_HEAD: [],
      SUITE_RED_ON_BASE: [],
      CI_RED: [],
      REFACTOR_CHANGES_TESTS: [],
      DIFF_UNCOVERED: ['pct', 'minPct'],
    }).map(([code, params]) => [code, Object.freeze(params)]),
  ),
);

const isPath = (v) => typeof v === 'string' && v.length > 0;
const isCount = (v) => Number.isInteger(v);
const isPct = (v) => Number.isFinite(v);

const CHECKS = Object.freeze({ path: isPath, n: isCount, m: isCount, pct: isPct, minPct: isPct });

// The exact note text src/prove.mjs prints for each code (MP-102 keeps the
// gate's wording frozen; this table is now its only source).
const TEXTS = Object.freeze({
  NO_NEW_TEST: () => 'no new test file to prove the change',
  NEW_TEST_PASSES_ON_BASE: ({ path }) => `new test ${path} passes on base, so it proves nothing`,
  FLAKY_ON_BASE: ({ path, n, m }) => `new test ${path} is flaky on base (failed ${n}/${m})`,
  FAILS_ON_HEAD: ({ path }) => `new test ${path} fails on head`,
  FLAKY_ON_HEAD: ({ path, n, m }) => `new test ${path} is flaky on head (passed ${n}/${m})`,
  SUITE_RED_ON_HEAD: () => 'full suite fails on head',
  SUITE_RED_ON_BASE: () => 'full suite already fails on base, so a refactor cannot be proven',
  CI_RED: () => 'CI is red',
  REFACTOR_CHANGES_TESTS: () => 'a refactor must not change test files',
  DIFF_UNCOVERED: ({ pct, minPct }) => `diff line coverage is ${pct}% (needs ${minPct}%)`,
});

/**
 * Render a reason to the note text the gate prints for it.
 * @param {{ code: string, path?: string, n?: number, m?: number, pct?: number, minPct?: number } | string} reason
 *   the structured reason, or a plain code string when it takes no parameters.
 * @returns {string} the note text.
 * @throws {TypeError} on an unknown code, or a missing or wrongly-typed parameter.
 */
export function renderReason(reason) {
  const r = typeof reason === 'string' ? { code: reason } : reason;
  const code = r !== null && typeof r === 'object' ? r.code : undefined;
  if (typeof code !== 'string' || !Object.hasOwn(REASON_PARAMS, code)) {
    throw new TypeError(`unknown reason code: ${JSON.stringify(code ?? reason)}`);
  }
  for (const param of REASON_PARAMS[code]) {
    if (!CHECKS[param](r[param])) throw new TypeError(`reason ${code} needs a valid ${param} parameter`);
  }
  return TEXTS[code](r);
}
