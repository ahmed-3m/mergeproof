// Repo-wide invariants: version consistency, zero dependencies, and the
// module contract every pipeline stage must keep while it is being built.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { VERSION } from '../src/version.mjs';

const PKG = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));

test('engine VERSION matches package.json', () => {
  assert.equal(VERSION, PKG.version);
});

test('zero dependencies, including dev dependencies', () => {
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    assert.equal(PKG[key], undefined, `package.json must not declare ${key}`);
  }
});

test('every published path exists', () => {
  for (const p of PKG.files) assert.ok(existsSync(resolve(p)), `missing ${p}`);
  assert.ok(existsSync(resolve(PKG.bin.mergeproof)));
});

const CONTRACT = {
  'src/config.mjs': ['CONFIG_FILE', 'MODES', 'defaultConfig', 'loadConfig', 'parseConfig'],
  'src/glob.mjs': ['matchesGlob', 'matchesAny'],
  'src/classify.mjs': ['KINDS', 'classifyKind', 'bucketPaths'],
  'src/tamper.mjs': ['TAMPER_RULES', 'SAFE_PATH', 'detectTampering'],
  'src/prove.mjs': ['proveChange'],
  'src/decide.mjs': ['decide'],
  'src/ledger.mjs': ['LEDGER_SCHEMA', 'DEFAULT_LEDGER', 'readLedger', 'writeLedger', 'appendOutcome', 'trustFor'],
  'src/trailer.mjs': ['TRAILER_KEY', 'formatTrailer', 'parseTrailer'],
  'src/commands/check.mjs': ['runCheck', 'evaluate'],
  'src/commands/sync.mjs': ['runSync', 'settle'],
  'src/adapters/process.mjs': ['runProcess'],
  'src/adapters/git.mjs': ['changedFiles', 'changedPaths', 'diff', 'addedLines', 'addWorktree', 'removeWorktree', 'commonDir', 'log'],
  'src/adapters/gh.mjs': ['getPullRequest', 'getChecksStatus', 'issueLabels', 'squashMerge', 'comment', 'createIssue'],
  'src/adapters/runner.mjs': ['runTests', 'parseTestCount'],
};

for (const [file, names] of Object.entries(CONTRACT)) {
  test(`${file} exports its contract`, async () => {
    const mod = await import(new URL(`../${file}`, import.meta.url));
    for (const name of names) assert.ok(name in mod, `${file} must export ${name}`);
  });
}

test('default config uses a valid mode and covers every kind proof needs', async () => {
  const { defaultConfig, MODES } = await import('../src/config.mjs');
  const cfg = defaultConfig();
  assert.ok(MODES.includes(cfg.mode));
  assert.equal(cfg.mode, 'shadow', 'new installs must start in shadow mode');
  for (const key of ['tests', 'docs', 'manifests']) assert.ok(cfg.paths[key].length > 0);
  assert.notEqual(defaultConfig(), defaultConfig(), 'each call returns a fresh copy');
});
