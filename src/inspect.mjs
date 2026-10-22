import { classifyKind } from './classify.mjs';
import { detectTampering, SAFE_PATH } from './tamper.mjs';
import { matchesAny } from './glob.mjs';
import * as git from './adapters/git.mjs';

export const defaultDeps = { git };

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
  const kind = classifyKind(files.map((f) => f.path), config, { issueLabels });
  const testFiles = files
    .filter((f) => f.status !== 'D' && matchesAny(f.path, config.paths.tests) && SAFE_PATH.test(f.path))
    .map((f) => f.path);
  const addedLines = deps.git.addedLines(root, baseSha, headSha, testFiles);
  const tamperNotes = detectTampering({ kind, files, addedLines, claims, config });
  return { kind, files, testFiles, addedLines, tamperNotes };
}
