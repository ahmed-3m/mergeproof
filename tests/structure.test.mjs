// Repo-wide invariants: version consistency, zero dependencies, and the
// module contract every pipeline stage must keep while it is being built.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
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

test('every skills/*/SKILL.md has name, integer version and description frontmatter', () => {
  const skills = readdirSync(resolve('skills'), { withFileTypes: true }).filter((e) => e.isDirectory());
  assert.ok(skills.length > 0, 'skills/ must ship at least one skill');
  for (const dir of skills) {
    const file = resolve('skills', dir.name, 'SKILL.md');
    const text = readFileSync(file, 'utf8');
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    assert.ok(fm, `${dir.name}/SKILL.md must start with YAML frontmatter`);
    const field = (key) => {
      const line = fm[1].split(/\r?\n/).find((l) => l.startsWith(`${key}:`));
      return line == null ? null : line.slice(key.length + 1).trim();
    };
    assert.ok(field('name'), `${dir.name}/SKILL.md frontmatter needs a name`);
    assert.match(field('version') ?? '', /^\d+$/, `${dir.name}/SKILL.md frontmatter needs an integer version`);
    assert.ok(field('description'), `${dir.name}/SKILL.md frontmatter needs a description`);
  }
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
  'src/agents.mjs': ['notAnAgentPr', 'identityFor'],
  'src/inspect.mjs': ['inspect'],
  'src/land.mjs': ['land'],
  'src/verdictfile.mjs': ['VERDICT_FILE_SCHEMA', 'writeVerdictFile', 'readVerdictFile'],
  'src/commands/check.mjs': ['runCheck', 'evaluate'],
  'src/commands/apply.mjs': ['runApply'],
  'src/commands/sync.mjs': ['runSync', 'settle'],
  'src/commands/init.mjs': ['runInit', 'detect'],
  'src/commands/dispatch.mjs': ['runDispatch', 'buildIssueFile', 'agentPrompt', 'agentEnv', 'HARNESS_BIN', 'TOKEN_ENV'],
  'src/adapters/process.mjs': ['runProcess'],
  'src/adapters/git.mjs': ['changedFiles', 'changedPaths', 'diff', 'addedLines', 'addWorktree', 'removeWorktree', 'addBranchWorktree', 'refExists', 'commonDir', 'log'],
  'src/adapters/gh.mjs': ['getPullRequest', 'getChecksStatus', 'waitForChecks', 'issueLabels', 'squashMerge', 'comment', 'createIssue', 'addLabel', 'repoView', 'createLabel', 'setVariable', 'setSecret', 'apiJson', 'branchExists', 'redactSecret', 'getIssue', 'issueComments', 'collaboratorPermission'],
  'src/adapters/runner.mjs': ['runTests', 'parseTestCount'],
  'src/adapters/sandbox.mjs': ['TEST_USER', 'check', 'shareModules', 'makeHome', 'claim', 'wrap', 'killAll', 'release'],
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
