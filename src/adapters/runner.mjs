import { runProcess } from './process.mjs';
import { SAFE_PATH } from '../tamper.mjs';

// Test runner adapter. Results are per test file and come from exit codes, so
// any runner works: `testFileCommand` runs one file (node --test, npx jest,
// npx vitest run, pytest), `testCommand` runs the whole suite.
//
// Full-suite runs also report `count`, the number of test cases parsed from the
// combined stdout+stderr (parseTestCount below), so the refactor proof can
// catch a dropped test count. Pass/fail still comes from the exit code alone;
// a count that doesn't parse is null and never fails a proof on its own.
//
// Commands come from the base branch's config (trusted) and are split on
// whitespace. On Windows they run through the shell so npm/npx .cmd shims
// resolve (CVE-2024-27980); the only untrusted argument, the test file path, is
// checked against SAFE_PATH first.

const SUITE = '(suite)';

// PR code runs here, so keep credentials out of its environment. NODE_TEST_CONTEXT
// goes too: when mergeproof itself runs under `node --test`, an inherited value
// turns a child `node --test` into a sub-reporter that exits 0 even on failure.
const DROP_ENV = /TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|^NODE_TEST_CONTEXT$/i;

function cleanEnv() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !DROP_ENV.test(k)));
  // Ask runners for plain text: a colored summary would hide the case count
  // from parseTestCount and silently skip the dropped-test-count check.
  // FORCE_COLOR is set too because CI environments often set it, and it
  // overrides NO_COLOR in several runners.
  env.NO_COLOR = '1';
  env.FORCE_COLOR = '0';
  return env;
}

function run(cwd, command, extra, timeoutSec) {
  const [bin, ...args] = command.trim().split(/\s+/);
  const res = runProcess(bin, [...args, ...extra], {
    cwd,
    shell: process.platform === 'win32',
    env: cleanEnv(),
    timeoutMs: timeoutSec * 1000,
  });
  return { ok: res.code === 0 && !res.timedOut, output: `${res.stdout}\n${res.stderr}` };
}

// Case counts per runner summary. Formats are tried in order and the last
// match of the first one that fits wins, so a suite that reports several
// summaries counts its final run. No end-of-line anchor: Windows \r doesn't
// break a count that sits before it.
const COUNT_FORMATS = [
  /^(?:ℹ|i) tests (\d+)/gm, // node:test spec reporter (with or without the glyph)
  /^# tests (\d+)/gm, // TAP (node:test tap reporter, prove, ...)
  /^Tests:.*?(\d+) total/gm, // jest
  /^[ \t]*Tests\s+[^\n]*?\((\d+)\)/gm, // vitest: the total is the number in parentheses
];

// pytest: `... 3 passed, 1 failed, 2 errors in 0.12s ...` — sum the case counts.
const PYTEST_SUMMARY = /^[ \t]*=+ (.*) in \S+ =+[^\S\n]*$/gm;
const PYTEST_COUNTS = /(\d+) (passed|failed|errors?|skipped|xfailed|xpassed)\b/g;

/** Number of test cases in a runner's output, or null when no summary parses. */
export function parseTestCount(output) {
  // Strip ANSI escapes first (SGR colors, cursor moves, OSC): CI often forces
  // color on, and a colored summary line would not match the ^-anchored
  // formats below — the count would read as null and the drop check skip.
  const text = String(output ?? '')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '');
  for (const format of COUNT_FORMATS) {
    format.lastIndex = 0;
    let last = null;
    for (let m = format.exec(text); m !== null; m = format.exec(text)) last = Number(m[1]);
    if (last !== null) return last;
  }
  PYTEST_SUMMARY.lastIndex = 0;
  let total = null;
  for (let m = PYTEST_SUMMARY.exec(text); m !== null; m = PYTEST_SUMMARY.exec(text)) {
    PYTEST_COUNTS.lastIndex = 0;
    let sum = 0;
    let found = false;
    for (let c = PYTEST_COUNTS.exec(m[1]); c !== null; c = PYTEST_COUNTS.exec(m[1])) {
      sum += Number(c[1]);
      found = true;
    }
    if (found) total = sum; // e.g. "no tests ran in 0.01s" is not a count
  }
  return total;
}

/** @returns {{ passed: string[], failed: string[], count?: number|null }} */
export function runTests(repoRoot, { testCommand, testFileCommand, only = null, timeoutSec = 600 }) {
  const passed = [];
  const failed = [];
  if (only === null) {
    const { ok, output } = run(repoRoot, testCommand, [], timeoutSec);
    (ok ? passed : failed).push(SUITE);
    return { passed, failed, count: parseTestCount(output) };
  }
  for (const file of only) {
    if (!SAFE_PATH.test(file)) throw new Error(`refusing to run unsafe test path ${JSON.stringify(file)}`);
    (run(repoRoot, testFileCommand, [file], timeoutSec).ok ? passed : failed).push(file);
  }
  return { passed, failed };
}
