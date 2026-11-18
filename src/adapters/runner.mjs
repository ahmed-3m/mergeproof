import { chmodSync, closeSync, constants, fstatSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, posix } from 'node:path';
import { runProcess } from './process.mjs';
import { wrap } from './sandbox.mjs';
import { SAFE_PATH } from '../tamper.mjs';

// Test runner adapter. Results are per test file and come from exit codes, so
// any runner works: `testFileCommand` runs one file (node --test, npx jest,
// npx vitest run, pytest, go test, cargo test), `testCommand` runs the whole suite.
//
// Full-suite runs also report `count`, the number of test cases parsed from the
// combined stdout+stderr (parseTestCount below), so the refactor proof can
// catch a dropped test count. Pass/fail still comes from the exit code alone;
// a count that doesn't parse is null and never fails a proof on its own.
//
// Commands come from the base branch's config (trusted) and are tokenized with
// outer `'...'` / `"..."` quotes stripped. On Windows only `.cmd`/`.bat` shims
// (npm, npx, yarn, pnpm, *.cmd, *.bat) run through the shell (CVE-2024-27980);
// direct binaries keep `shell: false` so regex metacharacters like `|` and `^`
// are never mangled by cmd.exe. Any substituted path or test name is checked
// against SAFE_PATH (or `/^Test\w*$/` for `{goTests}`) first.

const SUITE = '(suite)';

// PR code runs here, so keep credentials out of its environment. NODE_TEST_CONTEXT
// goes too: when mergeproof itself runs under `node --test`, an inherited value
// turns a child `node --test` into a sub-reporter that exits 0 even on failure.
// On GitHub Actions the step-control files (GITHUB_ENV, GITHUB_PATH, ...) are
// worse than variables: a test that appends to one changes every later step of
// the gate's own workflow, and the ACTIONS_* runtime values carry the runner's
// tokens — so they all go as well.
const DROP_ENV = /TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|^NODE_TEST_CONTEXT$|^GITHUB_(?:ENV|PATH|OUTPUT|STEP_SUMMARY|STATE)$|^ACTIONS_/i;

export function cleanEnv(sourceEnv = process.env) {
  const env = Object.fromEntries(Object.entries(sourceEnv).filter(([k]) => !DROP_ENV.test(k)));
  // Ask runners for plain text: a colored summary would hide the case count
  // from parseTestCount and silently skip the dropped-test-count check.
  // FORCE_COLOR is set too because CI environments often set it, and it
  // overrides NO_COLOR in several runners.
  env.NO_COLOR = '1';
  env.FORCE_COLOR = '0';
  return env;
}

const WIN_SHIMS = new Set(['npm', 'npx', 'yarn', 'pnpm']);
const HAS_PLACEHOLDER = /\{(file|dir|stem|goTests)\}/;
const PLACEHOLDER_RE = /\{(file|dir|stem|goTests)\}/g;
const GO_TEST_RE = /^func[ \t]+(Test[^\n(]*?)[ \t]*\(/gm;
const SAFE_GO_TEST = /^Test\w*$/;

function needsShell(bin) {
  if (process.platform !== 'win32') return false;
  const base = basename(bin).toLowerCase();
  return WIN_SHIMS.has(base) || base.endsWith('.cmd') || base.endsWith('.bat');
}

// Tokenize a trusted command string on whitespace while stripping matching outer
// `'...'` or `"..."` quotes so quoted regexes (e.g. `'^({goTests})$'`) reach
// execFile without literal quote characters.
function tokenizeCommand(command) {
  const tokens = [];
  let current = '';
  let inToken = false;
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      inToken = true;
    } else if (/\s/.test(ch)) {
      if (inToken) {
        tokens.push(current);
        current = '';
        inToken = false;
      }
    } else {
      current += ch;
      inToken = true;
    }
  }
  if (quote) throw new Error(`unclosed quote in command ${JSON.stringify(command)}`);
  if (inToken) tokens.push(current);
  if (tokens.length === 0) throw new Error('test command must not be empty');
  return tokens;
}

function assertSafePath(value, label = 'test path') {
  if (typeof value !== 'string' || !SAFE_PATH.test(value)) {
    throw new Error(`refusing to run unsafe ${label} ${JSON.stringify(value)}`);
  }
}

function normalizeSafeFile(file) {
  assertSafePath(file, 'test path');
  const norm = posix.normalize(file);
  assertSafePath(norm, 'test path');
  if (norm === '.' || norm === '..' || norm.startsWith('../')) {
    throw new Error(`refusing to run unsafe test path ${JSON.stringify(file)}`);
  }
  return norm;
}

function extractGoTests(repoRoot, file) {
  const source = readFileSync(join(repoRoot, file), 'utf8').replace(/^\uFEFF/, '');
  const names = [];
  for (const m of source.matchAll(GO_TEST_RE)) {
    const name = m[1];
    if (!SAFE_GO_TEST.test(name)) {
      throw new Error(`refusing unsafe Go test name ${JSON.stringify(name)} in ${file}`);
    }
    names.push(name);
  }
  if (names.length === 0) {
    throw new Error(`no Go Test* functions found in ${file}`);
  }
  return names.join('|');
}

function resolveTestFileArgs(repoRoot, templateArgs, file) {
  const normFile = normalizeSafeFile(file);
  if (!templateArgs.some((arg) => HAS_PLACEHOLDER.test(arg))) {
    return [...templateArgs, file];
  }
  const values = { file: normFile };
  for (const arg of templateArgs) {
    for (const m of arg.matchAll(PLACEHOLDER_RE)) {
      const name = m[1];
      if (Object.hasOwn(values, name)) continue;
      if (name === 'dir') {
        const dir = posix.dirname(normFile);
        assertSafePath(dir, '{dir} placeholder');
        values.dir = dir;
      } else if (name === 'stem') {
        const stem = posix.basename(normFile, posix.extname(normFile));
        assertSafePath(stem, '{stem} placeholder');
        values.stem = stem;
      } else if (name === 'goTests') {
        values.goTests = extractGoTests(repoRoot, normFile);
      }
    }
  }
  return templateArgs.map((arg) => arg.replace(PLACEHOLDER_RE, (_, name) => values[name]));
}

// `testUser` ({ user, home }, from check --test-user) runs the command as that
// unprivileged OS user through sudo; see sandbox.mjs. `covDir`, when set, is
// handed to the child as NODE_V8_COVERAGE so a full-suite run leaves V8
// coverage JSON behind for the diff-coverage proof (proof.minDiffCoverage).
function run(cwd, bin, args, timeoutSec, testUser, covDir = null) {
  const env = cleanEnv();
  if (covDir) env.NODE_V8_COVERAGE = covDir;
  const argv = testUser ? wrap(testUser.user, testUser.home, bin, args, env) : { bin, args };
  const res = runProcess(argv.bin, argv.args, {
    cwd,
    shell: needsShell(argv.bin),
    env,
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

/** @returns {{ passed: string[], failed: string[], count?: number|null, v8Coverage?: object[] }} */
export function runTests(repoRoot, { testCommand, testFileCommand, only = null, timeoutSec = 600, testUser = null, collectCoverage = false }) {
  const passed = [];
  const failed = [];
  if (only === null) {
    // Full-suite runs can collect V8 coverage (NODE_V8_COVERAGE) for the
    // diff-coverage proof. The dir is world-writable under --test-user so the
    // test user's processes (node --test spawns one per file) can write to it,
    // and it is removed once the JSON blobs are read back.
    let covDir = null;
    try {
      if (collectCoverage) {
        covDir = mkdtempSync(join(tmpdir(), 'mp-v8cov-'));
        if (testUser) chmodSync(covDir, 0o1777);
      }
      const [bin, ...args] = tokenizeCommand(testCommand);
      const { ok, output } = run(repoRoot, bin, args, timeoutSec, testUser, covDir);
      (ok ? passed : failed).push(SUITE);
      const result = { passed, failed, count: parseTestCount(output) };
      if (covDir) result.v8Coverage = readV8Coverage(covDir);
      return result;
    } finally {
      if (covDir) rmSync(covDir, { recursive: true, force: true });
    }
  }
  if (only.length === 0) return { passed, failed };
  const [bin, ...templateArgs] = tokenizeCommand(testFileCommand);
  for (const file of only) {
    const args = resolveTestFileArgs(repoRoot, templateArgs, file);
    (run(repoRoot, bin, args, timeoutSec, testUser).ok ? passed : failed).push(file);
  }
  return { passed, failed };
}

const MAX_COV_FILE_BYTES = 32 * 1024 * 1024;
const MAX_COV_TOTAL_BYTES = 128 * 1024 * 1024;
const OPEN_COV_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

// One parsed JSON blob per regular file the run left behind. Under --test-user
// the directory is world-writable, so entries are opened with O_NOFOLLOW |
// O_NONBLOCK, verified with fstatSync().isFile(), and capped in size so a
// hostile test cannot plant a symlink, a blocking FIFO, or an OOM-sized blob.
function readV8Coverage(dir) {
  const blobs = [];
  let totalBytes = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    let fd = null;
    try {
      fd = openSync(join(dir, name), OPEN_COV_FLAGS);
      const st = fstatSync(fd);
      if (!st.isFile() || st.size <= 0 || st.size > MAX_COV_FILE_BYTES || totalBytes + st.size > MAX_COV_TOTAL_BYTES) continue;
      const buf = Buffer.allocUnsafe(st.size);
      const bytesRead = readSync(fd, buf, 0, st.size, 0);
      totalBytes += bytesRead;
      blobs.push(JSON.parse(buf.subarray(0, bytesRead).toString('utf8')));
    } catch {
      // a torn write, symlink, FIFO, or unreadable entry is not a coverage result
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // ignore close errors
        }
      }
    }
  }
  return blobs;
}
