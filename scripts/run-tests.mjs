// `npm test`: runs every top-level tests/*.test.mjs with `node --test`.
// A new suite is picked up by existing; nothing lists them by hand. Only the
// top level counts: tests/fixtures/ holds files that look like tests but are
// inputs for them (running `node --test tests/` would pick them up).
// Extra arguments go to `node --test` before the files, for example
// `npm test -- --test-name-pattern=apply`.
//
// `npm run test:fast` (run-tests.mjs --fast) is the dev-loop tier: the same
// suites minus SLOW_SUITES, the ones that build fixture repos end to end and
// take minutes. `--fast` is consumed here, never forwarded — `node --test`
// would reject it as a bad option.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Suites too slow for the inner dev loop (real git fixture repos, workflow
// renders, installer exercises). Everything else must stay fast enough to run
// after every edit, so keep this list short and justified.
export const SLOW_SUITES = Object.freeze([
  'apply.test.mjs',
  'benchmarks.test.mjs',
  'commands.test.mjs',
  'demo.test.mjs',
  'dispatch.test.mjs',
  'init.test.mjs',
  'workflows.test.mjs',
]);

/** Sorted paths of the *.test.mjs files directly inside `dir` (`fast` drops SLOW_SUITES). */
export function listTestFiles(dir, { fast = false } = {}) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.test.mjs') && !(fast && SLOW_SUITES.includes(e.name)))
    .map((e) => e.name)
    .sort()
    .map((name) => join(dir, name));
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const extra = process.argv.slice(2);
  const fast = extra.includes('--fast');
  const forward = extra.filter((a) => a !== '--fast');
  const files = listTestFiles(join(root, 'tests'), { fast }).map((f) => f.slice(root.length + 1));
  // spawnSync directly instead of runProcess: that adapter captures output,
  // and a three-minute suite has to stream. Allowed here because the command is
  // process.execPath with an argv array and shell: false, so no shell parses
  // anything, and this script is not part of the gate or shipped in the package.
  const res = spawnSync(process.execPath, ['--test', ...forward, ...files], { cwd: root, stdio: 'inherit', shell: false });
  if (res.error) {
    console.error(`run-tests: ${res.error.message}`);
    process.exit(1);
  }
  process.exit(res.status ?? 1);
}
