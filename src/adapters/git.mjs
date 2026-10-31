import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runProcess } from './process.mjs';

// Local git operations: changed files between base and head, throwaway
// worktrees for proof runs, and history for `sync`. Every call is an argv
// array with shell: false, so paths from a PR are never parsed by a shell.

// Hooks and fsmonitor are switched off on every call, so nothing planted in the
// repo's git config can run when the gate touches git. Diff prefixes are
// pinned too: a user's diff.noprefix/mnemonicPrefix would emit headers the
// added-line parser misreads.
const SAFE_CONFIG = [
  '-c', 'core.quotePath=false',
  '-c', 'diff.noprefix=false',
  '-c', 'diff.mnemonicPrefix=false',
  '-c', 'diff.srcPrefix=a/',
  '-c', 'diff.dstPrefix=b/',
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

/**
 * Is `commit` an ancestor of (or equal to) `ancestorOf`? Used to anchor
 * ledger outcomes in real git history (trust.verifyCommits). Unknown or
 * malformed SHAs are simply false, never an error, so a forged ledger entry
 * cannot break the gate.
 */
export function isAncestor(repoRoot, commit, ancestorOf) {
  if (typeof commit !== 'string' || !/^[0-9a-f]{7,40}$/.test(commit)) return false;
  return git(repoRoot, ['merge-base', '--is-ancestor', commit, ancestorOf], { allowFail: true }).code === 0;
}

/**
 * origin's default branch if known, else the first of origin/main, origin/master,
 * main, master that exists. Remote refs come first because they track the
 * fetched tip; a clone without origin/HEAD (a shallow or single-branch fetch,
 * the agent container) has them but no symbolic default.
 */
export function defaultBranch(repoRoot) {
  const head = git(repoRoot, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { allowFail: true });
  if (head.code === 0 && head.stdout.trim()) return head.stdout.trim();
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    if (refExists(repoRoot, ref)) return ref;
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

/** [{ path, symlink }] for every file in the tree at `sha`. */
export function listFiles(repoRoot, sha) {
  return git(repoRoot, ['ls-tree', '-r', '-z', sha]).stdout.split('\0').filter(Boolean).map((entry) => {
    const tab = entry.indexOf('\t');
    return { path: entry.slice(tab + 1), symlink: entry.startsWith('120000 ') };
  });
}

/**
 * [{ path, line }] for lines at `sha` matching the extended regex, in the
 * text files at the exact `paths`. The output format is pinned with flags (a
 * repo's grep.lineNumber or grep.column would add fields), and a line that
 * still doesn't parse throws instead of being skipped.
 */
export function grep(repoRoot, sha, pattern, paths) {
  if (paths.length === 0) return [];
  const args = ['grep', '-I', '-z', '--no-line-number', '--no-column', '--no-color', '--full-name', '-E', '-e', pattern, sha, '--'];
  const res = git(repoRoot, [...args, ...paths.map((p) => `:(literal)${p}`)], { allowFail: true });
  if (res.code === 1 && !res.stderr.trim()) return []; // no match
  if (res.code !== 0) throw new Error(`git grep failed: ${(res.stderr || res.stdout).trim().split('\n')[0]}`);
  const prefix = `${sha}:`;
  return res.stdout.split('\n').filter(Boolean).map((l) => {
    const at = l.indexOf('\0');
    if (!l.startsWith(prefix) || at < 0) throw new Error(`git grep: unexpected output ${JSON.stringify(l.slice(0, 80))}`);
    return { path: l.slice(prefix.length, at), line: l.slice(at + 1) };
  });
}

// Stable patch id of a commit's change against its first parent, or of its
// undo with `reverse`; null for a commit with no change (or no parent). A
// manual revert has the same id as its merge's undo, whatever its message
// says. Both sides are plain `git diff`s: `diff-tree -R` swaps the a/ b/
// prefixes, which changes the id.
export function patchId(repoRoot, sha, { reverse = false } = {}) {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return null;
  const range = reverse ? [sha, `${sha}^`] : [`${sha}^`, sha];
  const diff = git(repoRoot, ['diff', '--no-color', '--no-ext-diff', ...range, '--'], { allowFail: true }).stdout;
  if (!diff.includes('\n@@') && !diff.includes('\nBinary files')) return null;
  const res = runProcess('git', [...SAFE_CONFIG, 'patch-id', '--stable'], { cwd: repoRoot, input: diff });
  return res.code === 0 ? res.stdout.trim().split(/\s+/)[0] || null : null;
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

/** Does the ref resolve to a commit? (a local branch, a remote ref, a tag) */
export function refExists(repoRoot, ref) {
  return git(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true }).code === 0;
}

/**
 * Worktree at `dir` (caller-chosen, e.g. inside a dispatch temp dir) on a NEW
 * branch created from `startPoint`. Unlike addWorktree this is a branch, not a
 * detached checkout, so work done there can be pushed as that branch.
 */
export function addBranchWorktree(repoRoot, dir, branch, startPoint) {
  git(repoRoot, ['worktree', 'add', '-b', branch, dir, startPoint]);
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
