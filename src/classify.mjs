import { matchesAny } from './glob.mjs';

export const KINDS = Object.freeze(['feature', 'bugfix', 'refactor', 'docs', 'deps']);

/** Sort changed paths into the buckets classification and proof work on. */
export function bucketPaths(changedPaths, config) {
  const b = { tests: [], docs: [], manifests: [], source: [] };
  for (const p of changedPaths) {
    if (matchesAny(p, config.paths.manifests)) b.manifests.push(p);
    else if (matchesAny(p, config.paths.tests)) b.tests.push(p);
    else if (matchesAny(p, config.paths.docs)) b.docs.push(p);
    else b.source.push(p);
  }
  return b;
}

/**
 * Derive the task kind from changed paths only — never from agent-written
 * labels or commit prefixes. Those are compared afterwards, and a mismatch is
 * reported by detectTampering.
 *
 *   any manifest or lockfile      → deps (never auto-merged, so bundling code with it can't sneak through)
 *   only docs                     → docs
 *   source, no tests              → refactor
 *   source and tests              → feature, or bugfix when a maintainer labeled the linked issue as a bug
 *   tests only, or nothing        → null (no kind fits; the gate asks a human)
 *
 * Feature and bugfix share the same proof, so the issue label only picks the
 * trust bucket. It comes from the linked issue, which the agent doesn't write.
 * @param {string[]} changedPaths
 * @param {ReturnType<import('./config.mjs').defaultConfig>} config
 * @param {{ issueLabels?: string[] }} [signals]
 * @returns {typeof KINDS[number] | null}
 */
export function classifyKind(changedPaths, config, { issueLabels = [] } = {}) {
  const b = bucketPaths(changedPaths, config);
  if (b.manifests.length > 0) return 'deps';
  if (b.source.length === 0 && b.tests.length === 0) return b.docs.length > 0 ? 'docs' : null;
  if (b.source.length === 0) return null;
  if (b.tests.length === 0) return 'refactor';
  const bugLabels = new Set(config.issueLabels.bugfix.map((l) => l.toLowerCase()));
  return issueLabels.some((l) => bugLabels.has(l.toLowerCase())) ? 'bugfix' : 'feature';
}
