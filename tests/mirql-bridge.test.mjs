import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GATE_ENTRY,
  computeClosure,
  digest,
  extractGate,
  verifyBundleGraph,
} from '../scripts/mirql-bridge/extract-gate.mjs';

const sha256 = (buf) => `sha256:${createHash('sha256').update(buf).digest('hex')}`;

function writeFixture(dir) {
  // A miniature mirql: entry -> a -> core.b -> core.c, a -> sub/index,
  // core.c -> core.b closes a cycle, a dynamically imports core/dyn, and
  // pkg/ignored.mjs is unreachable.
  mkdirSync(join(dir, 'pkg', 'sub'), { recursive: true });
  mkdirSync(join(dir, 'core'), { recursive: true });
  const files = {
    'pkg/entry.mjs': [
      "import { openSync } from 'node:fs';",
      "import { a } from './a.mjs';",
      "import { b } from '../core/b.mjs';",
      "import 'some-bare-package';",
      "import './init.mjs';",
      'export const entry = () => [a, b, openSync];',
    ].join('\n'),
    'pkg/init.mjs': 'export const booted = true;\n',
    'pkg/a.mjs': [
      "import { b } from '../core/b.mjs';",
      "import { sub } from './sub';",
      'export const loadDyn = () => import("../core/dyn.mjs");',
      'export const a = () => [b, sub, loadDyn];',
    ].join('\n'),
    'pkg/sub/index.mjs': 'export const sub = 1;\n',
    'core/b.mjs': "import { c } from './c.mjs';\nexport const b = () => c;\n",
    'core/c.mjs': "import { b } from './b.mjs';\nexport const c = () => b;\n", // cycle b <-> c
    'core/dyn.mjs': 'export const dyn = 1;\n',
    'pkg/ignored.mjs': 'export const ignored = true;\n',
  };
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(dir, rel), body, 'utf8');
}

function tmpFixture(name) {
  const dir = mkdtempSync(join(tmpdir(), `mp-bridge-${name}-`));
  writeFixture(dir);
  return dir;
}

test('closure walks transitive relative imports and nothing else', () => {
  const dir = tmpFixture('closure');
  try {
    const closure = computeClosure({ root: dir, entry: 'pkg/entry.mjs' });
    assert.deepEqual(closure, [
      'core/b.mjs',
      'core/c.mjs',
      'core/dyn.mjs',
      'pkg/a.mjs',
      'pkg/entry.mjs',
      'pkg/init.mjs',
      'pkg/sub/index.mjs',
    ]);
    assert.ok(!closure.includes('pkg/ignored.mjs'), 'unreachable files must be excluded');
    assert.ok(!closure.some((p) => p.includes('node:')), 'builtins are not files');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('import cycles terminate (each file visited once)', () => {
  const dir = tmpFixture('cycle');
  try {
    // core/b <-> core/c closes a cycle; the walk must still finish with 7 files.
    assert.equal(computeClosure({ root: dir, entry: 'pkg/entry.mjs' }).length, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unresolvable relative import fails closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-bridge-unresolved-'));
  try {
    mkdirSync(join(dir, 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'pkg', 'entry.mjs'), "import { ghost } from './ghost.mjs';\n", 'utf8');
    assert.throws(
      () => computeClosure({ root: dir, entry: 'pkg/entry.mjs' }),
      /unresolvable import "\.\/ghost\.mjs" in pkg\/entry\.mjs/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing gate entry fails closed with the path in the error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-bridge-noentry-'));
  try {
    assert.throws(() => computeClosure({ root: dir }), new RegExp(GATE_ENTRY.replace('/', '\\/')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an import that resolves outside the root fails closed', () => {
  const base = mkdtempSync(join(tmpdir(), 'mp-bridge-escape-'));
  try {
    const dir = join(base, 'root');
    const outside = join(base, 'outside.mjs');
    mkdirSync(join(dir, 'pkg'), { recursive: true });
    writeFileSync(outside, 'export const x = 1;\n', 'utf8');
    writeFileSync(
      join(dir, 'pkg', 'entry.mjs'),
      "import { x } from '../../outside.mjs';\nexport const entry = x;\n",
      'utf8',
    );
    assert.throws(
      () => computeClosure({ root: dir, entry: 'pkg/entry.mjs' }),
      /escapes the root/,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('extraction starts from an empty output directory', () => {
  const dir = tmpFixture('stale');
  const out = mkdtempSync(join(tmpdir(), 'mp-bridge-stale-out-'));
  try {
    mkdirSync(join(out, 'pkg'), { recursive: true });
    writeFileSync(join(out, 'pkg', 'stale-from-a-previous-run.mjs'), 'export const stale = 1;\n', 'utf8');
    extractGate({ root: dir, outDir: out, entry: 'pkg/entry.mjs' });
    assert.throws(() => readFileSync(join(out, 'pkg', 'stale-from-a-previous-run.mjs')), /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('an output directory overlapping the source root is refused, and nothing is deleted', () => {
  const base = mkdtempSync(join(tmpdir(), 'mp-bridge-outguard-'));
  try {
    const root = join(base, 'root'); // the source checkout lives INSIDE base
    mkdirSync(root, { recursive: true });
    writeFixture(root);
    // `--out .` (out IS the root): the most dangerous manual misuse.
    assert.throws(() => extractGate({ root, outDir: root, entry: 'pkg/entry.mjs' }), /refusing --out/);
    // out inside the root (pollutes the source tree).
    assert.throws(() => extractGate({ root, outDir: join(root, 'staging'), entry: 'pkg/entry.mjs' }), /refusing --out/);
    // out containing the root (would delete everything above the source,
    // including the source itself).
    assert.throws(() => extractGate({ root, outDir: base, entry: 'pkg/entry.mjs' }), /refusing --out/);
    // The guard fires before any deletion: the source fixture is intact.
    assert.ok(readFileSync(join(root, 'pkg', 'entry.mjs'), 'utf8').includes('export const entry'));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('extractGate copies the bundle byte-identically and records honest digests', () => {
  const dir = tmpFixture('extract');
  const out = mkdtempSync(join(tmpdir(), 'mp-bridge-out-'));
  try {
    const manifest = extractGate({ root: dir, outDir: out, entry: 'pkg/entry.mjs' });
    assert.equal(manifest.entry, 'pkg/entry.mjs');
    assert.equal(manifest.sourceCommit, null, 'a non-git fixture records null, not a guess');
    assert.equal(manifest.files.length, 7);
    for (const file of manifest.files) {
      const buf = readFileSync(join(out, file.path));
      assert.equal(digest(buf), file.sha256);
      assert.equal(file.bytes, buf.length);
    }
    // The ignored file must not ship.
    assert.throws(() => readFileSync(join(out, 'pkg/ignored.mjs')), /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('verifyBundleGraph passes on a complete bundle and fails when a file is removed', () => {
  const dir = tmpFixture('verify');
  const out = mkdtempSync(join(tmpdir(), 'mp-bridge-verify-out-'));
  try {
    extractGate({ root: dir, outDir: out, entry: 'pkg/entry.mjs' });
    assert.equal(verifyBundleGraph(out).length, 7);

    // Break the graph: pkg/a.mjs imports ./sub, so deleting sub/index.mjs
    // must be caught without executing any bundle code.
    rmSync(join(out, 'pkg', 'sub', 'index.mjs'));
    assert.throws(() => verifyBundleGraph(out), /bundle graph broken: pkg\/a\.mjs imports/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});
