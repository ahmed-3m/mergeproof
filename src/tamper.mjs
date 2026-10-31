import { posix } from 'node:path';
import { CONFIG_FILE } from './config.mjs';
import { matchesAny } from './glob.mjs';

// ctx: {
//   kind,                                     from classifyKind
//   files: [{ path, status: 'A'|'M'|'D'|'R', oldPath?, added, deleted }],
//   addedLines: { [testPath]: string[] },     lines added to test files
//   claims: { title?, labels?: string[], subjects?: string[] },  agent-written, never trusted
//   config,
//   instructionImports?: { [lowercasePath]: importer },  files the base's agent instructions pull in
// }
// Each rule is a function (ctx) => text | null so rules stay pluggable
// (brief RISK: agents adapt to known rules). A dropped test-case count is not
// a path rule: prove.mjs finds it by counting cases in the suite output.

// Paths mergeproof hands to child processes; anything else could smuggle shell syntax
// through the Windows .cmd shim path (CVE-2024-27980). No leading dash, so a
// path can never be read as an option.
export const SAFE_PATH = /^[A-Za-z0-9_@+.][A-Za-z0-9_@+./-]*$/;

// Files that control the gate itself. A PR may not change its own judge.
const GATE_FILES = [CONFIG_FILE, '.mergeproof/**', '.github/**'];

const SKIP_MARKER =
  /\b(?:describe|it|test|context|suite)\.(?:skip|only|todo)\b|\b(?:xit|xdescribe|xtest|fit|fdescribe)\s*\(|@pytest\.mark\.(?:skip|skipif|xfail)\b|\bt\.(?:skip|todo|Skip|SkipNow|Skipf)\s*\(|\b(?:skip|todo)\s*:\s*true\b|#\[\s*ignore\b[^\]]*\]|@unittest\.skip|\bpytest\.skip\s*\(|\bself\.skipTest\s*\(/;

// Claimed kind from a Conventional Commit prefix or a label. feature and bugfix
// count as one family because paths can't tell them apart.
const PREFIX_KIND = { feat: 'change', fix: 'change', refactor: 'refactor', docs: 'docs', deps: 'deps' };
const LABEL_KIND = {
  feature: 'change', enhancement: 'change', bug: 'change', bugfix: 'change',
  refactor: 'refactor', docs: 'docs', documentation: 'docs', deps: 'deps', dependencies: 'deps',
};

function family(kind) {
  return kind === 'feature' || kind === 'bugfix' ? 'change' : kind;
}

function claimedKinds({ title, labels = [], subjects = [] }) {
  const claims = [];
  for (const line of [title, ...subjects]) {
    const m = /^(\w+)(?:\(([^)]*)\))?!?:/.exec(line ?? '');
    if (!m) continue;
    const type = m[1].toLowerCase();
    if ((type === 'chore' || type === 'build') && m[2] === 'deps') claims.push(['deps', line]);
    else if (PREFIX_KIND[type]) claims.push([PREFIX_KIND[type], line]);
  }
  for (const label of labels) {
    const k = LABEL_KIND[label.toLowerCase()];
    if (k) claims.push([k, `label "${label}"`]);
  }
  return claims;
}

function first(items, describe) {
  if (items.length === 0) return null;
  return items.length === 1 ? describe(items[0]) : `${describe(items[0])} (+${items.length - 1} more)`;
}

const isTest = (ctx, p) => p != null && matchesAny(p, ctx.config.paths.tests);

// Paths an instruction file imports with `@path` (CLAUDE.md, GEMINI.md), resolved
// against its directory. The token is read the way Claude Code reads it: any
// run of non-space characters, with `\ ` for a space. Loose on purpose: an npm
// scope or a decorator that is not really an import only protects one more
// path, so a token ending in punctuation protects both readings. `@~/...`,
// absolute paths and paths that leave the repo are skipped.
const IMPORT = /(?:^|\s)@((?:[^\s\\]|\\.)+)/g;

export function instructionImports(text, fromPath) {
  const dir = posix.dirname(fromPath);
  const paths = [];
  for (const m of text.matchAll(IMPORT)) {
    const token = m[1].replace(/\\(.)/g, '$1');
    if (token.startsWith('~') || token.startsWith('/')) continue;
    for (const raw of new Set([token, token.replace(/[.,;:!?)\]'"`]+$/, '')])) {
      if (!raw) continue;
      const p = posix.normalize(posix.join(dir, raw)).replace(/\/$/, '');
      if (p !== '.' && p !== '..' && !p.startsWith('../') && !paths.includes(p)) paths.push(p);
    }
  }
  return paths;
}

export const TAMPER_RULES = [
  function unsafePath(ctx) {
    const bad = ctx.files.flatMap((f) => [f.path, f.oldPath]).filter((p) => p != null && !SAFE_PATH.test(p));
    return first(bad, (p) => `unsafe file name ${JSON.stringify(p)}`);
  },
  function gateFilesEdited(ctx) {
    const hit = ctx.files.filter((f) => matchesAny(f.path, GATE_FILES) || (f.oldPath && matchesAny(f.oldPath, GATE_FILES)));
    return first(hit, (f) => `edits gate file ${f.path}`);
  },
  function agentInstructionsEdited(ctx) {
    // AGENTS.md, CLAUDE.md, .cursor/rules and friends are prompts for every
    // later agent run, so an agent PR may not rewrite them (they would
    // otherwise classify as docs and could auto-merge). Case is ignored:
    // macOS and Windows load claude.md as CLAUDE.md. A file they @import is
    // loaded as instructions too, so it is protected the same way.
    const globs = ctx.config.paths.agentInstructions.map((g) => g.toLowerCase());
    const imports = ctx.instructionImports ?? {};
    const importer = (p) => (Object.hasOwn(imports, p.toLowerCase()) ? imports[p.toLowerCase()] : null);
    const hit = ctx.files.filter((f) => [f.path, f.oldPath].some((p) => p && (matchesAny(p.toLowerCase(), globs) || importer(p))));
    return first(hit, (f) => {
      const via = [f.path, f.oldPath].map((p) => p && !matchesAny(p.toLowerCase(), globs) && importer(p)).find(Boolean);
      return via ? `edits ${f.path}, which ${via} imports as agent instructions` : `edits agent instructions ${f.path}`;
    });
  },
  function existingTestEdited(ctx) {
    const hit = ctx.files.filter((f) => (f.status === 'M' || f.status === 'R') && (isTest(ctx, f.path) || isTest(ctx, f.oldPath)));
    return first(hit, (f) => `edits existing test ${f.oldPath ?? f.path}`);
  },
  function existingTestDeleted(ctx) {
    const hit = ctx.files.filter((f) => f.status === 'D' && isTest(ctx, f.path));
    return first(hit, (f) => `deletes existing test ${f.path}`);
  },
  function skipMarkerAdded(ctx) {
    const hit = Object.entries(ctx.addedLines ?? {}).filter(([, lines]) => lines.some((l) => SKIP_MARKER.test(l)));
    return first(hit, ([p]) => `adds a skip/only marker in ${p}`);
  },
  function kindLabelMismatch(ctx) {
    if (!ctx.kind) return null;
    const actual = family(ctx.kind);
    const wrong = claimedKinds(ctx.claims ?? {}).filter(([k]) => k !== actual);
    return first(wrong, ([k, src]) => `claims ${k === 'change' ? 'feature/fix' : k} (${src}) but paths say ${ctx.kind}`);
  },
  function diffTooLarge(ctx) {
    const counted = ctx.files.filter((f) => !matchesAny(f.path, ctx.config.paths.manifests));
    const lines = counted.reduce((n, f) => n + (f.added || 0) + (f.deleted || 0), 0);
    const max = ctx.config.limits.maxDiffLines;
    return lines > max ? `diff is ${lines} lines (limit ${max})` : null;
  },
];

/** @returns {Array<{ ok: false, rule: string, text: string }>} one note per violated rule */
export function detectTampering(ctx) {
  const notes = [];
  for (const rule of TAMPER_RULES) {
    const text = rule(ctx);
    if (text) notes.push({ ok: false, rule: rule.name, text });
  }
  return notes;
}
