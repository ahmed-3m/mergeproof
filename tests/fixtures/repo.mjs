// Builds throwaway git repos for end-to-end tests: a `main` branch with a small
// Node project, and an agent branch carrying one scenario's change.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

export const BASE_FILES = {
  '.mergeproof.json': JSON.stringify({ testCommand: 'node --test', testFileCommand: 'node --test' }, null, 2),
  'package.json': '{ "name": "fixture", "type": "module", "private": true }\n',
  'src/math.mjs': [
    'export function add(a, b) {',
    '  return a + b;',
    '}',
    '',
    '// Bug: multiplying by 3 is off by one.',
    'export function mul(a, b) {',
    '  return a * b + (a === 3 ? 1 : 0);',
    '}',
    '',
  ].join('\n'),
  'tests/add.test.mjs': [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from '../src/math.mjs';",
    '',
    "test('add', () => {",
    '  assert.equal(add(2, 2), 4);',
    '});',
    '',
  ].join('\n'),
};

function sh(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

export function createRepo(baseFiles = BASE_FILES) {
  const dir = mkdtempSync(join(tmpdir(), 'mp-fixture-'));
  sh(dir, ['init', '--quiet', '--initial-branch=main']);
  for (const [k, v] of [['user.email', 'fixture@example.com'], ['user.name', 'Fixture'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) {
    sh(dir, ['config', k, v]);
  }
  const repo = {
    dir,
    write(files) {
      for (const [path, content] of Object.entries(files)) {
        const full = join(dir, path);
        if (content === null) {
          rmSync(full, { force: true });
          continue;
        }
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content);
      }
      return repo;
    },
    commit(message) {
      sh(dir, ['add', '-A']);
      sh(dir, ['commit', '--quiet', '-m', message]);
      return sh(dir, ['rev-parse', 'HEAD']);
    },
    branch(name) {
      sh(dir, ['checkout', '--quiet', '-b', name]);
      return repo;
    },
    git: (args) => sh(dir, args),
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
  repo.write(baseFiles).commit('chore: initial');
  return repo;
}

export const testFile = (name, body) =>
  [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { readFileSync, writeFileSync, existsSync } from 'node:fs';",
    "import { add, mul } from '../src/math.mjs';",
    '',
    `test('${name}', () => {`,
    ...body.map((l) => `  ${l}`),
    '});',
    '',
  ].join('\n');

export const FIXED_MATH = BASE_FILES['src/math.mjs'].replace('// Bug: multiplying by 3 is off by one.\n', '').replace(' + (a === 3 ? 1 : 0)', '');
