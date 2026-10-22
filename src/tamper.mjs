import { CONFIG_FILE } from './config.mjs';
import { matchesAny } from './glob.mjs';

// ctx: {
//   kind,                                     from classifyKind
//   files: [{ path, status: 'A'|'M'|'D'|'R', oldPath?, added, deleted }],
//   addedLines: { [testPath]: string[] },     lines added to test files
//   claims: { title?, labels?: string[], subjects?: string[] },  agent-written, never trusted
//   config,
// }
// Each rule is a function (ctx) => text | null so rules stay pluggable
// (brief RISK: agents adapt to known rules). A dropped test count is covered by
// the edited/deleted rules while proof runs per file; counting individual cases
// needs per-runner output parsing and comes later.

// Paths mergeproof hands to child processes; anything else could smuggle shell syntax
// through the Windows .cmd shim path (CVE-2024-27980). No leading dash, so a
// path can never be read as an option.
export const SAFE_PATH = /^[A-Za-z0-9_@+.][A-Za-z0-9_@+./-]*$/;

// Files that control the gate itself. A PR may not change its own judge.
const GATE_FILES = [CONFIG_FILE, '.mergeproof/**', '.github/**'];

const SKIP_MARKER =
  /\b(?:describe|it|test|context|suite)\.(?:skip|only|todo)\b|\b(?:xit|xdescribe|xtest|fit|fdescribe)\s*\(|@pytest\.mark\.(?:skip|skipif|xfail)\b|\bt\.(?:skip|todo)\s*\(|\b(?:skip|todo)\s*:\s*true\b/;

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

export const TAMPER_RULES = [
  function unsafePath(ctx) {
    const bad = ctx.files.flatMap((f) => [f.path, f.oldPath]).filter((p) => p != null && !SAFE_PATH.test(p));
    return first(bad, (p) => `unsafe file name ${JSON.stringify(p)}`);
  },
  function gateFilesEdited(ctx) {
    const hit = ctx.files.filter((f) => matchesAny(f.path, GATE_FILES) || (f.oldPath && matchesAny(f.oldPath, GATE_FILES)));
    return first(hit, (f) => `edits gate file ${f.path}`);
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
