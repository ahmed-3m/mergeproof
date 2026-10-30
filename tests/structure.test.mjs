// Repo-wide invariants: version consistency, zero dependencies, and the
// module contract every pipeline stage must keep while it is being built.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
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
  'src/tamper.mjs': ['TAMPER_RULES', 'SAFE_PATH', 'detectTampering', 'instructionImports'],
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
  'src/adapters/git.mjs': ['changedFiles', 'changedPaths', 'diff', 'addedLines', 'addWorktree', 'removeWorktree', 'addBranchWorktree', 'refExists', 'commonDir', 'log', 'patchId', 'listFiles', 'grep'],
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

// The gate decides a pull request's fate, so the code it loads is a security
// boundary: it may not pull in agent-side modules (dispatch runs a coding agent
// and holds a token; loop will run inside the agent container), and it may not
// depend on a package. Imports are followed from the source text, so this
// still holds with the CLI loading commands lazily.
const IMPORT_RE = /(?:\bimport|\bexport)\s[^'";]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

const rel = (f) => relative(process.cwd(), f).split(sep).join('/');

function importClosure(entry) {
  const seen = new Set();
  const bare = [];
  const queue = [resolve(entry)];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const m of source.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (spec.startsWith('node:')) continue;
      if (spec.startsWith('.')) queue.push(resolve(dirname(file), spec));
      else bare.push(`${rel(file)} imports ${spec}`);
    }
  }
  return { files: [...seen].map((f) => rel(f)), bare };
}

for (const entry of ['src/commands/check.mjs', 'src/commands/apply.mjs', 'src/commands/sync.mjs', 'src/land.mjs']) {
  test(`${entry} never reaches agent-side modules or a package`, () => {
    const { files, bare } = importClosure(entry);
    assert.ok(files.length > 1, 'the closure walk found the imports');
    for (const banned of ['src/commands/dispatch.mjs', 'src/commands/loop.mjs']) {
      assert.ok(!files.includes(banned), `${entry} must not import ${banned} (directly or through another module)`);
    }
    assert.deepEqual(bare, [], 'only relative and node: imports');
  });
}
