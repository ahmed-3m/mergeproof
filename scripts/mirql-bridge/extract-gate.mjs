// scripts/mirql-bridge/extract-gate.mjs — export mirql's gate as a public bundle.
//
// The upstream mirql repository keeps its trust gate in
// packages/mergeproof/** plus the packages/core/** modules that gate imports
// transitively. This script walks that local-import closure live (never a
// hardcoded file list, so it cannot go stale when upstream grows a new edge),
// copies the files into a staging directory preserving their relative paths,
// and writes a manifest with a SHA-256 per file and the source commit.
//
// Everything is zero-dependency by construction: mirql's constitution forbids
// external packages, so the closure resolves only relative specifiers and
// node: builtins. A specifier that resolves outside the staging root, or an
// import that resolves to nothing, is an error — the bundle fails closed
// rather than shipping a graph that cannot load.
//
// Usage:
//   node scripts/mirql-bridge/extract-gate.mjs --root <mirql-checkout> --out <staging-dir>
//   node scripts/mirql-bridge/extract-gate.mjs --verify <staging-dir>   # re-check a bundle

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GATE_ENTRY = 'packages/mergeproof/index.mjs';
export const MANIFEST_NAME = 'manifest.json';

// Static `from './x'`, side-effect `import './x'` and dynamic
// `import('./x')` specifiers, relative only — bare specifiers and node:
// builtins are never bundle files. The prefix is required (not optional) so
// plain string literals like "./data.txt" are never mistaken for imports.
const RELATIVE_IMPORT_RE = /(?:from\s+|import\s*\(\s*|import\s+)['"](\.[^'"]+)['"]/g;

/** Normalize any path to forward slashes for portable manifests. */
export const toPosix = (p) => p.split(sep).join('/');

/**
 * Resolve one relative specifier the way Node ESM does for files on disk:
 * exact path, then `+ .mjs`, then `/index.mjs`. Returns the absolute path of
 * the first form that exists as a file, or null.
 */
function resolveSpecifier(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [base, `${base}.mjs`, join(base, 'index.mjs')]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* try the next form */
    }
  }
  return null;
}

/**
 * Transitive closure of relative imports starting at `entry` (a repo-relative
 * POSIX path). Returns the sorted list of repo-relative paths, entry included.
 * Cycles are fine — each file is visited once.
 */
export function computeClosure({ root, entry = GATE_ENTRY }) {
  const rootAbs = resolve(root);
  const entryAbs = join(rootAbs, entry);
  try {
    statSync(entryAbs);
  } catch {
    throw new Error(`gate entry not found: ${toPosix(join(root, entry))} (is --root a mirql checkout?)`);
  }
  const seen = new Set([entryAbs]);
  const queue = [entryAbs];
  while (queue.length) {
    const file = queue.pop();
    const src = readFileSync(file, 'utf8');
    for (const match of src.matchAll(RELATIVE_IMPORT_RE)) {
      const resolved = resolveSpecifier(file, match[1]);
      if (!resolved) {
        throw new Error(`unresolvable import "${match[1]}" in ${toPosix(relative(rootAbs, file))}`);
      }
      if (!resolved.startsWith(rootAbs + sep)) {
        throw new Error(
          `import escapes the root: "${match[1]}" in ${toPosix(relative(rootAbs, file))} -> ${toPosix(resolved)}`,
        );
      }
      if (!seen.has(resolved)) {
        seen.add(resolved);
        queue.push(resolved);
      }
    }
  }
  return [...seen].map((f) => toPosix(relative(rootAbs, f))).sort();
}

/** sha256:<hex> of a buffer, matching mirql's digest convention. */
export const digest = (buf) => `sha256:${createHash('sha256').update(buf).digest('hex')}`;

function sourceCommit(rootAbs) {
  try {
    return execFileSync('git', ['-C', rootAbs, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null; // not a git checkout (tests, exotic exports) — recorded honestly
  }
}

/**
 * Extract the gate bundle: copy the closure into `outDir` (relative paths
 * preserved) and write `manifest.json` next to it. Returns the manifest.
 */
export function extractGate({ root, outDir, entry = GATE_ENTRY }) {
  const rootAbs = resolve(root);
  const outAbs = resolve(outDir);
  // computeClosure completes (or throws) before anything is written, and the
  // output directory starts empty so files removed upstream can never linger
  // from a previous run.
  const files = computeClosure({ root: rootAbs, entry });
  rmSync(outAbs, { recursive: true, force: true });
  mkdirSync(outAbs, { recursive: true });
  const recorded = [];
  for (const rel of files) {
    const buf = readFileSync(join(rootAbs, rel));
    const dest = join(outAbs, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, buf);
    recorded.push({ path: rel, sha256: digest(buf), bytes: buf.length });
  }
  const manifest = {
    v: 1,
    sourceRepo: 'ahmed-3m/mirql',
    sourceCommit: sourceCommit(rootAbs),
    extractedAt: new Date().toISOString(),
    entry,
    files: recorded,
  };
  writeFileSync(join(outAbs, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

/** Every .mjs file under `dir` (POSIX paths relative to `dir`). */
export function listBundleFiles(dir) {
  const out = [];
  const walk = (abs) => {
    for (const name of readdirSync(abs)) {
      const full = join(abs, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.mjs')) out.push(toPosix(relative(resolve(dir), full)));
    }
  };
  walk(resolve(dir));
  return out.sort();
}

/**
 * Re-verify an extracted bundle WITHOUT executing any of it: every relative
 * import inside the bundle must resolve to another file inside the bundle.
 * Throws on the first violation; returns the verified file list.
 */
export function verifyBundleGraph(dir) {
  const dirAbs = resolve(dir);
  const files = listBundleFiles(dirAbs);
  if (files.length === 0) throw new Error(`no .mjs files under ${dir} — not a gate bundle?`);
  for (const rel of files) {
    const abs = join(dirAbs, rel);
    const src = readFileSync(abs, 'utf8');
    for (const match of src.matchAll(RELATIVE_IMPORT_RE)) {
      const resolved = resolveSpecifier(abs, match[1]);
      const inside = resolved !== null && resolved.startsWith(dirAbs + sep);
      if (!inside) {
        throw new Error(`bundle graph broken: ${rel} imports "${match[1]}" which is not in the bundle`);
      }
    }
  }
  return files;
}

function fail(message) {
  console.error(`extract-gate: ${message}`);
  process.exitCode = 1;
}

export function main(argv) {
  const args = argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? null : args[i + 1];
  };
  const verifyDir = flag('--verify');
  if (verifyDir) {
    const files = verifyBundleGraph(verifyDir);
    console.log(`verify: ${files.length} .mjs files, all relative imports resolve inside the bundle`);
    return;
  }
  const root = flag('--root') ?? process.env.MIRQL_ROOT ?? '.';
  const outDir = flag('--out') ?? 'mirql-gate-export';
  const manifest = extractGate({ root, outDir });
  console.log(`extracted ${manifest.files.length} files -> ${outDir} (${MANIFEST_NAME} written)`);
  console.log(`sourceCommit: ${manifest.sourceCommit ?? '(not a git checkout)'}`);
  const files = verifyBundleGraph(outDir);
  console.log(`verify: all ${files.length} .mjs files' relative imports resolve inside the bundle`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
