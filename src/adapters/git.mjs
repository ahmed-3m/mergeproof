import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runProcess } from './process.mjs';

// Local git operations: changed files between base and head, throwaway
// worktrees for proof runs, and history for `sync`. Every call is an argv
// array with shell: false, so paths from a PR are never parsed by a shell.

// Hooks and fsmonitor are switched off on every call, so nothing planted in the
// repo's git config can run when the gate touches git.
const SAFE_CONFIG = [
  '-c', 'core.quotePath=false',
  '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
  '-c', 'core.fsmonitor=false',
];

function git(cwd, args, { allowFail = false } = {}) {
  const res = runProcess('git', [...SAFE_CONFIG, ...args], { cwd });
  if (res.code !== 0 && !allowFail) {
    throw new Error(`git ${args[0]} failed: ${(res.stderr || res.stdout).trim().split('\n')[0]}`);
  }
  return res;
}

const out = (cwd, args) => git(cwd, args).stdout.trim();

export function topLevel(cwd) {
  return out(cwd, ['rev-parse', '--show-toplevel']);
}

/** Absolute path of the .git directory shared by the checkout and its worktrees. */
export function commonDir(repoRoot) {
  return resolve(repoRoot, out(repoRoot, ['rev-parse', '--git-common-dir']));
}

export function revParse(repoRoot, ref) {
  return out(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`]);
}

export function mergeBase(repoRoot, a, b) {
  return out(repoRoot, ['merge-base', a, b]);
}

/** origin's default branch if known, else main or master, whichever exists. */
export function defaultBranch(repoRoot) {
  const head = git(repoRoot, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { allowFail: true });
  if (head.code === 0 && head.stdout.trim()) return head.stdout.trim();
  for (const name of ['main', 'master']) {
    if (git(repoRoot, ['rev-parse', '--verify', '--quiet', `${name}^{commit}`], { allowFail: true }).code === 0) return name;
  }
  throw new Error('cannot find the base branch; pass --base <ref>');
}

export function fetch(repoRoot, refspecs) {
  git(repoRoot, ['fetch', '--no-tags', '--quiet', 'origin', ...refspecs]);
}

/** A file's content at a commit, or null if it doesn't exist there. */
export function showFile(repoRoot, sha, path) {
  const res = git(repoRoot, ['show', `${sha}:${path}`], { allowFail: true });
  return res.code === 0 ? res.stdout : null;
}

/** [{ path, status: 'A'|'M'|'D'|'R', oldPath?, added, deleted }] between two commits. */
export function changedFiles(repoRoot, base, head) {
  const files = new Map();
  const ns = git(repoRoot, ['diff', '--name-status', '-z', '-M', base, head]).stdout.split('\0');
  for (let i = 0; i < ns.length - 1; ) {
    const code = ns[i++];
    const status = code[0] === 'R' ? 'R' : code[0] === 'C' ? 'A' : code[0] === 'T' ? 'M' : code[0];
    if (code[0] === 'R' || code[0] === 'C') {
      const oldPath = ns[i++];
      const path = ns[i++];
      files.set(path, { path, status, ...(status === 'R' ? { oldPath } : {}), added: 0, deleted: 0 });
    } else {
      const path = ns[i++];
      files.set(path, { path, status, added: 0, deleted: 0 });
    }
  }
  // numstat -z: "added\tdeleted\tpath\0", or for renames "added\tdeleted\t\0old\0new\0".
  const num = git(repoRoot, ['diff', '--numstat', '-z', '-M', base, head]).stdout.split('\0');
  for (let i = 0; i < num.length - 1; ) {
    const [added, deleted, inline] = num[i++].split('\t');
    let path = inline;
    if (!inline) {
      i++; // old path
      path = num[i++];
    }
    const f = files.get(path);
    if (f) {
      f.added = added === '-' ? 0 : Number(added);
      f.deleted = deleted === '-' ? 0 : Number(deleted);
    }
  }
  return [...files.values()];
}

export function changedPaths(repoRoot, base, head) {
  return changedFiles(repoRoot, base, head).map((f) => f.path);
}

/** Unified diff with no context, limited to `paths` when given. */
export function diff(repoRoot, base, head, paths = []) {
  return git(repoRoot, ['diff', '-U0', '--no-color', '--no-ext-diff', base, head, '--', ...paths]).stdout;
}

/** { path: addedLines[] } for the given paths. */
export function addedLines(repoRoot, base, head, paths) {
  const result = {};
  if (paths.length === 0) return result;
  let current = null;
  for (const line of diff(repoRoot, base, head, paths).split('\n')) {
    if (line.startsWith('+++ ')) {
      current = line === '+++ /dev/null' ? null : line.slice(6);
      if (current) result[current] = [];
    } else if (current && line.startsWith('+')) {
      result[current].push(line.slice(1));
    }
  }
  return result;
}

export function commitSubjects(repoRoot, base, head) {
  return out(repoRoot, ['log', '--format=%s', `${base}..${head}`]).split('\n').filter(Boolean);
}

/** [{ sha, date, message }] reachable from ref, newest first. */
export function log(repoRoot, ref = 'HEAD') {
  const raw = git(repoRoot, ['log', '--format=%H%x1f%cI%x1f%B%x1e', ref]).stdout;
  return raw
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [sha, date, message] = r.split('\x1f');
      return { sha, date, message };
    });
}

/** Detached worktree at `sha` in a temp dir. Remove it with removeWorktree. */
export function addWorktree(repoRoot, sha) {
  const dir = mkdtempSync(join(tmpdir(), 'mergeproof-'));
  git(repoRoot, ['worktree', 'add', '--detach', '--force', dir, sha]);
  return dir;
}

export function removeWorktree(repoRoot, dir) {
  git(repoRoot, ['worktree', 'remove', '--force', dir], { allowFail: true });
  rmSync(dir, { recursive: true, force: true });
  git(repoRoot, ['worktree', 'prune'], { allowFail: true });
}

/** Copy `paths` as they are at `sha` into a worktree. */
export function checkoutFiles(worktree, sha, paths) {
  if (paths.length > 0) git(worktree, ['checkout', sha, '--', ...paths]);
}
