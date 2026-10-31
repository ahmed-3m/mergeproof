import { chmodSync, copyFileSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { runProcess } from './process.mjs';

// `check --test-user <name>`: PR test code runs as a separate, unprivileged OS
// user instead of the gate's own (Linux and macOS, through passwordless sudo,
// as on GitHub-hosted runners). The gate's user owns the verdict file, the
// checkout and its .git directory, the ledger and the runner's action files,
// so the test user can write none of them; and every process it leaves behind
// is killed before the gate reads its results or writes anything. Without
// this, a test that forks a background process can outlive the proof and
// rewrite the verdict file (or a later step's code) after the gate is done.
//
// Each proof worktree, and a scratch HOME, is handed to the test user for the
// run and taken back afterwards so the gate can remove it.

// A POSIX user name; it reaches sudo/pkill/chown as an argument, so keep it plain.
export const TEST_USER = /^[a-z_][a-z0-9_-]{0,31}$/;

function sudo(args, { allowFail = false } = {}) {
  const res = runProcess('sudo', ['-n', ...args]);
  if (res.code !== 0 && !allowFail) {
    throw new Error(`sudo ${args[0]} failed: ${(res.stderr || res.stdout).trim().split('\n')[0]}`);
  }
  return res;
}

/** Fail fast, before any PR code runs, when the user or passwordless sudo is missing. */
export function check(user) {
  if (process.platform === 'win32') throw new Error('--test-user needs Linux or macOS (sudo); Windows is not supported');
  if (!TEST_USER.test(user)) throw new Error(`--test-user ${JSON.stringify(user)} is not a plain user name`);
  sudo(['-u', user, '--', 'true']);
}

function mirror(src, dst, top) {
  mkdirSync(dst);
  chmodSync(dst, 0o755);
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dst, entry.name);
    if (entry.isSymbolicLink()) {
      // .bin links stay relative; one that leaves node_modules (a workspace
      // package) keeps pointing at the original.
      const target = readlinkSync(from);
      const inside = !isAbsolute(target) && !relative(top, resolve(src, target)).startsWith('..');
      symlinkSync(inside ? target : resolve(src, target), to);
    } else if (entry.isDirectory()) {
      mirror(from, to, top);
    } else {
      try {
        linkSync(from, to);
      } catch (err) {
        if (err.code !== 'EXDEV' && err.code !== 'EPERM') throw err;
        copyFileSync(from, to);
      }
    }
  }
}

/**
 * The checkout usually sits under the gate user's home, which the test user
 * cannot traverse (0750 on GitHub-hosted runners), so worktrees cannot link
 * the checkout's node_modules. Mirror it into a temp dir the test user can
 * read instead: fresh directories, hard links for files (no copy, and still
 * owned by the gate user, so read-only to the tests). Remove it with rmSync.
 * @returns {string} the mirrored node_modules
 */
export function shareModules(modules) {
  const dir = mkdtempSync(join(tmpdir(), 'mergeproof-modules-'));
  chmodSync(dir, 0o755);
  mirror(modules, join(dir, 'node_modules'), modules);
  return join(dir, 'node_modules');
}

/** A scratch HOME owned by the test user (npm and friends write caches there). */
export function makeHome(user) {
  const dir = mkdtempSync(join(tmpdir(), 'mergeproof-home-'));
  claim(dir, user);
  return dir;
}

/** Hand `dir` to the test user. The top stays traversable so the gate can still start commands in it. */
export function claim(dir, user) {
  sudo(['chown', '-R', user, dir]);
  sudo(['chmod', '0755', dir]);
}

/** The argv that runs `bin args` as the test user, with the given (already cleaned) environment kept. */
export function wrap(user, home, bin, args, env) {
  // -E keeps the cleaned environment; sudo's secure_path would still replace
  // PATH, and HOME must be one the test user can write, so `env` sets both.
  // NODE_V8_COVERAGE goes the same way: the coverage dir is chmod 0777 for the
  // test user, but the variable itself would not survive every sudoers filter.
  const kept = [`HOME=${home}`, `PATH=${env.PATH ?? ''}`];
  if (env.NODE_V8_COVERAGE !== undefined) kept.push(`NODE_V8_COVERAGE=${env.NODE_V8_COVERAGE}`);
  return { bin: 'sudo', args: ['-n', '-E', '-u', user, '--', 'env', ...kept, bin, ...args] };
}

/** Kill every process the test user still runs, e.g. a daemon a test forked. */
export function killAll(user) {
  for (let round = 0; round < 5; round++) {
    sudo(['pkill', '-KILL', '-u', user], { allowFail: true });
    if (sudo(['pgrep', '-u', user], { allowFail: true }).code === 1) return;
  }
  throw new Error(`processes of test user ${user} survived 5 rounds of pkill`);
}

/** Take `dir` back from the test user (after killAll, so nothing can race the chown). */
export function release(dir) {
  sudo(['chown', '-R', `${process.getuid()}:${process.getgid()}`, dir]);
}
