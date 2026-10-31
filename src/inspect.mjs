import { posix } from 'node:path';
import { classifyKind } from './classify.mjs';
import { detectTampering, instructionImports, SAFE_PATH } from './tamper.mjs';
import { matchesAny } from './glob.mjs';
import * as git from './adapters/git.mjs';

export const defaultDeps = { git };

// Claude Code follows imports up to five hops deep.
const IMPORT_HOPS = 5;
// Lines that may hold an import; instructionImports does the real parsing.
const IMPORT_LINE = '(^|[[:space:]])@[^[:space:]]';

const inRepo = (p) => Boolean(p) && p !== '.' && p !== '..' && !p.startsWith('../') && !p.startsWith('/');

/**
 * { [lowercasePath]: importer } for every file the base branch's agent
 * instructions pull in, followed hop by hop through `@path` imports. Symlinks
 * are resolved in every component (CLAUDE.md -> docs/rules.md, or an import
 * of shared/rules.md where shared -> docs/ai), so the file git actually holds
 * is protected along with the path that names it; a directory covers every
 * file under it. Read from the base, never the head, so a PR cannot change
 * what counts; a PR that adds an import edits an instruction file, which is
 * already tamper. Each hop greps the exact files it reached, whatever their
 * extension.
 */
function importedInstructions(root, baseSha, config, deps) {
  const globs = config.paths.agentInstructions.map((g) => g.toLowerCase());
  const isInstruction = (p) => matchesAny(p.toLowerCase(), globs);
  const tree = deps.git.listFiles(root, baseSha);
  const real = new Map(tree.map((f) => [f.path.toLowerCase(), f]));
  const targets = new Map();
  const linkTarget = (link) => {
    if (!targets.has(link.path)) {
      const t = deps.git.showFile(root, baseSha, link.path)?.trim() ?? '';
      const p = t && !t.startsWith('/') ? posix.normalize(posix.join(posix.dirname(link.path), t)).replace(/\/$/, '') : null;
      targets.set(link.path, inRepo(p) ? p : null);
    }
    return targets.get(link.path);
  };
  const imports = {};
  // `p` with its first symlinked component (the whole path included) swapped
  // for the link's target; `p` itself when no component is a link, null when
  // the link points outside the repo. The link is recorded too, so retargeting
  // or deleting it is tamper like editing the file it points at.
  const unlink = (p, via) => {
    const parts = p.split('/');
    for (let n = 1; n <= parts.length; n++) {
      const entry = real.get(parts.slice(0, n).join('/').toLowerCase());
      if (entry?.symlink) {
        if (!isInstruction(entry.path)) imports[entry.path.toLowerCase()] = via;
        const t = linkTarget(entry);
        return t ? [t, ...parts.slice(n)].join('/') : null;
      }
    }
    return p;
  };
  const seen = new Set();
  // Record `p` (instruction files are protected by their glob already), then
  // the path its symlinks resolve to, the files under it if it is a
  // directory, and queue it for the next grep if it is a regular file. `seen`
  // ends symlink loops.
  const visit = (p, from, next) => {
    const key = p.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    if (!isInstruction(p)) imports[key] = from;
    const via = isInstruction(p) ? p : from;
    const resolved = unlink(p, via);
    if (resolved !== p) {
      if (resolved) visit(resolved, via, next);
      return;
    }
    const entry = real.get(key);
    if (entry) next.push(entry.path);
    else for (const f of tree) if (f.path.toLowerCase().startsWith(`${key}/`)) visit(f.path, via, next);
  };
  let frontier = [];
  for (const f of tree) if (isInstruction(f.path)) visit(f.path, f.path, frontier);
  for (let hop = 0; hop < IMPORT_HOPS && frontier.length > 0; hop++) {
    const next = [];
    for (const { path, line } of deps.git.grep(root, baseSha, IMPORT_LINE, frontier)) {
      for (const p of instructionImports(line, path)) visit(p, path, next);
    }
    frontier = next;
  }
  return imports;
}

/**
 * Paths → kind + tamper notes, using git only. This is the part of the gate
 * that both `check` and `apply` run, factored out so the two cannot drift:
 * `apply` re-derives it in the write job, where no PR code ever runs, instead
 * of trusting the verdict file's kind.
 * @param {{ root: string, baseSha: string, headSha: string, config: object,
 *           claims: { title?: string, labels?: string[], subjects: string[] }, issueLabels?: string[] }} input
 * @returns {{ kind: string|null, files: object[], testFiles: string[], addedLines: object, tamperNotes: object[], holdNotes: object[] }}
 */
export function inspect({ root, baseSha, headSha, config, claims, issueLabels = [] }, deps = defaultDeps) {
  const files = deps.git.changedFiles(root, baseSha, headSha);
  // Classification sees the old path of a rename too: renaming a manifest
  // away (package-lock.json → backups/…) is still touching a manifest, so it
  // stays `deps` — which never auto-merges — instead of escaping to refactor.
  const touchedPaths = files.flatMap((f) => (f.oldPath ? [f.path, f.oldPath] : [f.path]));
  const kind = classifyKind(touchedPaths, config, { issueLabels });
  const testFiles = files
    .filter((f) => f.status !== 'D' && matchesAny(f.path, config.paths.tests) && SAFE_PATH.test(f.path))
    .map((f) => f.path);
  const addedLines = deps.git.addedLines(root, baseSha, headSha, testFiles);
  const instructionImports = importedInstructions(root, baseSha, config, deps);
  const tamperNotes = detectTampering({ kind, files, addedLines, claims, config, instructionImports });
  const humanOnly = config.paths?.humanOnly ?? [];
  const holdPath = touchedPaths.find((p) => matchesAny(p, humanOnly));
  const holdNotes = holdPath ? [{ ok: false, text: `touches a human-only path: ${holdPath}` }] : [];
  return { kind, files, testFiles, addedLines, tamperNotes, holdNotes };
}
