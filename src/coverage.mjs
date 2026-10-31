import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Diff-line coverage for Node repos, with zero dependencies (PROTOTYPE.md
// constraint 1). `proof.minDiffCoverage` turns it on; the pieces:
//
//   addedLineNumbers   a unified diff (git.diff, -U0 or with context) → the
//                      1-based head line numbers each file gained
//   coveredLinesFromV8  NODE_V8_COVERAGE output (the runner collects it) →
//                      which lines of each repo file executed, per the
//                      innermost V8 range covering the line
//   computeDiffCoverage  the two above + the PR's changed source files →
//                      { total, covered, ratio } over the ADDED executable
//                      lines only
//
// Everything here is in the gate's import closure, so it may only use
// relative and node: imports, and it never runs PR code: it reads files the
// caller points it at (the head worktree, while it exists) and pure data.

// `@@ -a,b +c,d @@`: only the new side matters — where the added lines sit.
// Either count may be omitted (then it is 1).
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse a unified diff (git.diff output, with or without context lines) and
 * map each repo-relative POSIX file path (`+++ b/<path>`) to the 1-based line
 * numbers it gained on head. Deleted files (`+++ /dev/null`) are ignored.
 * Hunk body lines are only read while the header's new-side count lasts, so
 * diff metadata (an added line that itself starts with `+++`) is never
 * misread as a header.
 * @param {string} patchText the `git diff` text
 * @returns {Record<string, number[]>} added line numbers per file, in order.
 */
export function addedLineNumbers(patchText) {
  const result = {};
  let current = null; // the file whose hunks we are inside
  let head = 0; // 1-based head line number of the next body line
  let remaining = 0; // new-side lines still expected in the current hunk
  for (const line of String(patchText ?? '').split('\n')) {
    if (remaining > 0) {
      // A hunk body line always starts with ' ', '+', '-' or '\'. An empty
      // string is the split's tail after a trailing newline, never a line.
      if (line.startsWith('+')) {
        if (current) result[current].push(head);
        head++;
        remaining--;
      } else if (line !== '' && (line.startsWith(' ') || line.startsWith('\t'))) {
        head++; // context: present on both sides
        remaining--;
      } else if (line.startsWith('-') || line.startsWith('\\')) {
        // removed, or "\ No newline at end of file": neither side moves.
      } else {
        remaining = 0; // the diff ended mid-hunk; back to headers
      }
      continue;
    }
    if (line.startsWith('+++ ')) {
      current = line === '+++ /dev/null' ? null : line.slice(4).replace(/^b\//, '');
      if (current) result[current] = [];
    } else if (line.startsWith('@@')) {
      const m = HUNK_HEADER.exec(line);
      if (m) {
        head = Number(m[1]);
        remaining = m[2] === undefined ? 1 : Number(m[2]);
      }
    }
  }
  return result;
}

// Lines that carry no executable code, so formatting can never cost coverage:
// blank lines, `//`-comment-only lines and lone closing punctuation (`}`,
// `);`, `});`). Added lines like these are simply not counted.
const CLOSE_ONLY = /^[}\])]+[;,]?$/;

/** @returns {Set<number>} the 1-based numbers of the lines that may execute. */
function executableLineNumbers(text) {
  const lines = new Set();
  String(text ?? '')
    .split('\n')
    .forEach((raw, i) => {
      const t = raw.trim();
      if (t === '' || t.startsWith('//') || CLOSE_ONLY.test(t)) return;
      lines.add(i + 1);
    });
  return lines;
}

// 1-based line number → [start, end) span of the line's content, newline
// excluded. A trailing newline does not create a phantom line worth reading.
function lineSpans(text) {
  const spans = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf('\n', start);
    if (nl === -1) {
      if (start < text.length) spans.push([start, text.length]);
      return spans;
    }
    spans.push([start, nl]);
    start = nl + 1;
  }
}

/**
 * The lines one V8 script entry executed. V8 reports a tree of ranges
 * (outer to inner); the top-level module range [0, source.length] has
 * count 1 for a file that was merely imported, while inner functions and
 * branches carry their own counts, 0 when never run. For every line the
 * INNERMOST range overlapping its content decides: a line whose innermost
 * range has count 0 (an uncalled function, an untaken branch) is uncovered,
 * however many outer ranges contain it. Counted per script entry and unioned
 * by the caller, so a line any test process executed is covered.
 */
function coveredInScript(script, text) {
  const spans = lineSpans(text);
  const ranges = [];
  for (const fn of script?.functions ?? []) {
    for (const r of fn?.ranges ?? []) {
      if (Number.isFinite(r?.startOffset) && Number.isFinite(r?.endOffset) && spans.length > 0) {
        ranges.push([r.startOffset, r.endOffset, r.count]);
      }
    }
  }
  const covered = new Set();
  if (ranges.length === 0) return covered;
  for (let line = 1; line <= spans.length; line++) {
    const [ls, le] = spans[line - 1];
    let inner = null; // the covering range that starts deepest: the innermost
    for (const r of ranges) {
      if (r[0] >= le || r[1] <= ls) continue; // no overlap with the line's content
      if (inner === null || r[0] > inner[0] || (r[0] === inner[0] && r[1] < inner[1])) inner = r;
    }
    if (inner !== null && inner[2] > 0) covered.add(line);
  }
  return covered;
}

// A repo-relative POSIX path for a V8 script URL, or null: `node:` internals,
// node_modules, and anything outside repoRoot never count. Both sides are
// realpathed before comparing: Node's ESM loader resolves a module's real
// path, and the worktree (a temp dir) can sit behind a symlink, e.g. macOS
// /tmp → /private/tmp — without this every file would look outside the tree.
function repoPathOf(url, base, realBase) {
  if (typeof url !== 'string' || url === '' || url.startsWith('node:')) return null;
  let abs;
  try {
    abs = fileURLToPath(url);
  } catch {
    return null; // not a file URL this side of the gate cares about
  }
  let realAbs = abs;
  try {
    realAbs = realpathSync(abs);
  } catch {
    // unreadable or already gone: compare with the URL's path as-is
  }
  for (const root of realAbs === abs ? [base, realBase] : [realBase, base]) {
    const relPath = relative(root, realAbs);
    if (relPath && !relPath.startsWith('..') && !isAbsolute(relPath)) {
      const posixPath = relPath.split(sep).join('/');
      return posixPath.split('/').includes('node_modules') ? null : posixPath;
    }
  }
  return null;
}

function readSource(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/** realpath of the tree root for URL comparison; the path itself when absent. */
function realRoot(repoRoot) {
  try {
    return realpathSync(repoRoot);
  } catch {
    return repoRoot;
  }
}

/**
 * Parse the NODE_V8_COVERAGE blobs a full-suite run produced and map each
 * repo-relative POSIX source path to the lines that executed. `node:` and
 * node_modules entries are ignored; the same file in several blobs (one per
 * test process — `node --test` spawns children) is merged, a line covered by
 * any process counts.
 * @param {Array<object>} v8JsonObjects parsed V8 coverage JSON blobs
 * @param {string} repoRoot the tree the tests ran in (files are read from it)
 * @returns {Record<string, { covered: Set<number>, executable: Set<number> }>}
 */
export function coveredLinesFromV8(v8JsonObjects, repoRoot) {
  const files = new Map();
  const realBase = realRoot(repoRoot);
  for (const blob of v8JsonObjects ?? []) {
    for (const script of blob?.result ?? []) {
      const path = repoPathOf(script?.url, repoRoot, realBase);
      if (!path) continue;
      const text = readSource(join(repoRoot, path));
      if (text === null) continue;
      let entry = files.get(path);
      if (!entry) {
        entry = { covered: new Set(), executable: executableLineNumbers(text) };
        files.set(path, entry);
      }
      // Only executable lines can be "covered": blank, comment and lone-brace
      // lines ride along on whatever outer range contains them.
      for (const line of coveredInScript(script, text)) {
        if (entry.executable.has(line)) entry.covered.add(line);
      }
    }
  }
  return Object.fromEntries(files);
}

/**
 * The share of the PR's added executable source lines the head suite
 * executed. Only the changed `source`-bucket files count (the caller filters
 * them), and only added lines that may execute: blank, comment and lone
 * closing-punctuation lines never penalize coverage. A changed source file
 * the suite never even loaded has no V8 entry, so every added executable
 * line of it is uncovered — a brand-new dead `src/unused.mjs` is caught too.
 * @param {{ addedLinesByFile: Record<string, number[]>, sourceFiles: string[],
 *           v8Coverage: Array<object>, repoRoot: string }} input
 * @returns {{ total: number, covered: number, ratio: number }} ratio is 1
 *   when nothing executable was added.
 */
export function computeDiffCoverage({ addedLinesByFile, sourceFiles, v8Coverage, repoRoot }) {
  const loaded = coveredLinesFromV8(v8Coverage, repoRoot);
  let total = 0;
  let covered = 0;
  for (const file of sourceFiles ?? []) {
    const added = addedLinesByFile?.[file];
    if (!added || added.length === 0) continue;
    const entry = loaded[file];
    // A file no run loaded: read it here (the worktree still exists) so its
    // added executable lines still count — all of them uncovered.
    const executable = entry ? entry.executable : executableLineNumbers(readSource(join(repoRoot, file)) ?? '');
    for (const line of added) {
      if (!executable.has(line)) continue;
      total++;
      if (entry?.covered.has(line)) covered++;
    }
  }
  return { total, covered, ratio: total === 0 ? 1 : covered / total };
}
