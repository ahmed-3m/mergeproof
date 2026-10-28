import { classifyKind } from './classify.mjs';
import { detectTampering, instructionImports, SAFE_PATH } from './tamper.mjs';
import { matchesAny } from './glob.mjs';
import * as git from './adapters/git.mjs';

export const defaultDeps = { git };

// Claude Code follows imports up to five hops deep.
const IMPORT_HOPS = 5;

/**
 * { [lowercasePath]: importer } for every file the base branch's agent
 * instructions pull in with `@path`, followed hop by hop. Read from the base,
 * never the head, so a PR cannot change what counts; a PR that adds an import
 * edits an instruction file, which is already tamper. One `git grep` reads
 * every candidate line; imports are followed through text-like files only.
 */
function importedInstructions(root, baseSha, config, deps) {
  const globs = config.paths.agentInstructions.map((g) => g.toLowerCase());
  const isInstruction = (p) => matchesAny(p.toLowerCase(), globs);
  const tree = deps.git.listFiles(root, baseSha);
  const real = new Map(tree.map((p) => [p.toLowerCase(), p]));
  const instructions = tree.filter(isInstruction);
  if (instructions.length === 0) return {};
  const pathspecs = ['*.md', '*.mdc', '*.markdown', '*.txt', ...instructions.map((p) => `:(literal)${p}`)];
  const lines = new Map();
  for (const { path, line } of deps.git.grep(root, baseSha, '(^|[[:space:]])@[A-Za-z0-9_.]', pathspecs)) {
    lines.set(path, [...(lines.get(path) ?? []), line]);
  }
  const imports = {};
  let frontier = instructions;
  for (let hop = 0; hop < IMPORT_HOPS && frontier.length > 0; hop++) {
    const next = [];
    for (const file of frontier) {
      for (const p of (lines.get(file) ?? []).flatMap((l) => instructionImports(l, file))) {
        const key = p.toLowerCase();
        if (Object.hasOwn(imports, key) || isInstruction(key)) continue;
        imports[key] = file;
        if (real.has(key)) next.push(real.get(key));
      }
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
