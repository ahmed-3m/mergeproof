// `npm test`: runs every top-level tests/*.test.mjs with `node --test`.
// A new suite is picked up by existing; nothing lists them by hand. Only the
// top level counts: tests/fixtures/ holds files that look like tests but are
// inputs for them (running `node --test tests/` would pick them up).
// Extra arguments go to `node --test` before the files, for example
// `npm test -- --test-name-pattern=apply`.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Sorted paths of the *.test.mjs files directly inside `dir`. */
export function listTestFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.test.mjs'))
    .map((e) => e.name)
    .sort()
    .map((name) => join(dir, name));
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = listTestFiles(join(root, 'tests')).map((f) => f.slice(root.length + 1));
  // spawnSync directly instead of runProcess: that adapter captures output,
  // and a three-minute suite has to stream. Allowed here because the command is
  // process.execPath with an argv array and shell: false, so no shell parses
  // anything, and this script is not part of the gate or shipped in the package.
  const res = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { cwd: root, stdio: 'inherit', shell: false });
  if (res.error) {
    console.error(`run-tests: ${res.error.message}`);
    process.exit(1);
  }
  process.exit(res.status ?? 1);
}
