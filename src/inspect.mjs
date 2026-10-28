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

/**
 * { [lowercasePath]: importer } for every file the base branch's agent
 * instructions pull in, followed hop by hop: `@path` imports, and the target
 * of a symlinked file (CLAUDE.md -> docs/rules.md; a directory target covers
 * every file under it). Read from the base, never the head, so a PR cannot
 * change what counts; a PR that adds an import edits an instruction file,
 * which is already tamper. Each hop greps the exact files it reached,
 * whatever their extension.
 */
function importedInstructions(root, baseSha, config, deps) {
  const globs = config.paths.agentInstructions.map((g) => g.toLowerCase());
  const isInstruction = (p) => matchesAny(p.toLowerCase(), globs);
  const tree = deps.git.listFiles(root, baseSha);
  const real = new Map(tree.map((f) => [f.path.toLowerCase(), f]));
  const imports = {};
  const add = (p, from, next) => {
    const key = p.toLowerCase();
    if (Object.hasOwn(imports, key) || isInstruction(key)) return;
    imports[key] = from;
    if (real.has(key)) next.push(real.get(key));
  };
  let frontier = tree.filter((f) => isInstruction(f.path));
  for (let hop = 0; hop < IMPORT_HOPS && frontier.length > 0; hop++) {
    const next = [];
    for (const link of frontier.filter((f) => f.symlink)) {
      const target = deps.git.showFile(root, baseSha, link.path)?.trim() ?? '';
      const p = posix.normalize(posix.join(posix.dirname(link.path), target)).replace(/\/$/, '');
      if (!target || target.startsWith('/') || p === '.' || p === '..' || p.startsWith('../')) continue;
      add(p, link.path, next);
      for (const f of tree) if (f.path.toLowerCase().startsWith(`${p.toLowerCase()}/`)) add(f.path, link.path, next);
    }
    const files = frontier.filter((f) => !f.symlink).map((f) => f.path);
    for (const { path, line } of deps.git.grep(root, baseSha, IMPORT_LINE, files)) {
      for (const p of instructionImports(line, path)) add(p, path, next);
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
 * @returns {{ kind: string|null, files: object[], testFiles: string[], addedLines: object, tamperNotes: object[] }}
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
  return { kind, files, testFiles, addedLines, tamperNotes };
}
