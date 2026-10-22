import { runProcess } from './process.mjs';
import { SAFE_PATH } from '../tamper.mjs';

// Test runner adapter. Results are per test file and come from exit codes, so
// any runner works: `testFileCommand` runs one file (node --test, npx jest,
// npx vitest run, pytest), `testCommand` runs the whole suite.
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
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !DROP_ENV.test(k)));
}

function run(cwd, command, extra, timeoutSec) {
  const [bin, ...args] = command.trim().split(/\s+/);
  const res = runProcess(bin, [...args, ...extra], {
    cwd,
    shell: process.platform === 'win32',
    env: cleanEnv(),
    timeoutMs: timeoutSec * 1000,
  });
  return res.code === 0 && !res.timedOut;
}

/** @returns {{ passed: string[], failed: string[] }} */
export function runTests(repoRoot, { testCommand, testFileCommand, only = null, timeoutSec = 600 }) {
  const passed = [];
  const failed = [];
  if (only === null) {
    (run(repoRoot, testCommand, [], timeoutSec) ? passed : failed).push(SUITE);
    return { passed, failed };
  }
  for (const file of only) {
    if (!SAFE_PATH.test(file)) throw new Error(`refusing to run unsafe test path ${JSON.stringify(file)}`);
    (run(repoRoot, testFileCommand, [file], timeoutSec) ? passed : failed).push(file);
  }
  return { passed, failed };
}
