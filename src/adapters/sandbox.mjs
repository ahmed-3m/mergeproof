import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/**
 * Fail fast, before any PR code runs, when the user or passwordless sudo is
 * missing, or when the test user cannot read `readable` (the checkout's
 * node_modules, which every proof worktree links to).
 */
export function check(user, readable = []) {
  if (process.platform === 'win32') throw new Error('--test-user needs Linux or macOS (sudo); Windows is not supported');
  if (!TEST_USER.test(user)) throw new Error(`--test-user ${JSON.stringify(user)} is not a plain user name`);
  sudo(['-u', user, '--', 'true']);
  for (const path of readable) {
    if (sudo(['-u', user, '--', 'test', '-r', path, '-a', '-x', path], { allowFail: true }).code !== 0) {
      throw new Error(`test user ${user} cannot read ${path}; make its parent directories traversable (chmod o+x)`);
    }
  }
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
  return { bin: 'sudo', args: ['-n', '-E', '-u', user, '--', 'env', `HOME=${home}`, `PATH=${env.PATH ?? ''}`, bin, ...args] };
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
