// Per-file test command placeholders (MP-111): tokenization with outer quote
// stripping, per-argv substitution for {file}, {dir}, {stem}, {goTests},
// fallback append when no placeholder is present, and SAFE_PATH / Go test name
// refusals. Driven against real `node` child processes via runTests().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTests } from '../src/adapters/runner.mjs';

function makeWorkspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mp-runner-ph-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, 'record.mjs'),
    "import { writeFileSync } from 'node:fs';\nwriteFileSync('argv.json', JSON.stringify(process.argv.slice(2)));\n",
  );
  const readArgv = () => JSON.parse(readFileSync(join(dir, 'argv.json'), 'utf8'));
  return { dir, readArgv };
}

test('runTests appends file as the last argument when testFileCommand has no placeholders', (t) => {
  const { dir, readArgv } = makeWorkspace(t);
  const res = runTests(dir, {
    testCommand: 'node -e ""',
    testFileCommand: 'node record.mjs --flag',
    only: ['tests/unit.test.mjs'],
  });
  assert.deepEqual(res, { passed: ['tests/unit.test.mjs'], failed: [] });
  assert.deepEqual(readArgv(), ['--flag', 'tests/unit.test.mjs']);
});

test('runTests substitutes {file} with the normalized POSIX relative path', (t) => {
  const { dir, readArgv } = makeWorkspace(t);
  const res = runTests(dir, {
    testCommand: 'node -e ""',
    testFileCommand: 'node record.mjs -q {file} --after',
    only: ['./tests/sub/../unit.test.mjs'],
  });
  assert.deepEqual(res, { passed: ['./tests/sub/../unit.test.mjs'], failed: [] });
  assert.deepEqual(readArgv(), ['-q', 'tests/unit.test.mjs', '--after']);
});

test('runTests substitutes {dir} for nested files and root-level files (".")', (t) => {
  const { dir, readArgv } = makeWorkspace(t);

  const nested = runTests(dir, {
    testCommand: 'node -e ""',
    testFileCommand: 'node record.mjs ./{dir}',
    only: ['pkg/math/add_test.go'],
  });
  assert.deepEqual(nested, { passed: ['pkg/math/add_test.go'], failed: [] });
  assert.deepEqual(readArgv(), ['./pkg/math']);

  const root = runTests(dir, {
    testCommand: 'node -e ""',
    testFileCommand: 'node record.mjs ./{dir}',
    only: ['root_test.go'],
  });
  assert.deepEqual(root, { passed: ['root_test.go'], failed: [] });
  assert.deepEqual(readArgv(), ['./.']);
});

test('runTests substitutes {stem} with basename without final extension', (t) => {
  const { dir, readArgv } = makeWorkspace(t);

  runTests(dir, {
    testCommand: 'node -e ""',
    testFileCommand: 'node record.mjs --test {stem}',
    only: ['tests/integration.rs'],
  });
  assert.deepEqual(readArgv(), ['--test', 'integration']);

  runTests(dir, {
    testCommand: 'node -e ""',
    testFileCommand: 'node record.mjs --test {stem}',
    only: ['tests/multi.part.test.mjs'],
  });
  assert.deepEqual(readArgv(), ['--test', 'multi.part.test']);

  runTests(dir, {
    testCommand: 'node -e ""',
    testFileCommand: 'node record.mjs --test {stem}',
    only: ['tests/noext'],
  });
  assert.deepEqual(readArgv(), ['--test', 'noext']);
});

test('runTests substitutes {goTests} for single and multiple tests and strips outer quotes', (t) => {
  const { dir, readArgv } = makeWorkspace(t);
  mkdirSync(join(dir, 'pkg', 'calc'), { recursive: true });

  writeFileSync(
    join(dir, 'pkg', 'calc', 'single_test.go'),
    [
      'package calc',
      'import "testing"',
      '',
      'func TestOnly(t *testing.T) {}',
      '',
    ].join('\n'),
  );
  const single = runTests(dir, {
    testCommand: 'node -e ""',
    testFileCommand: "node record.mjs test -count=1 -run '^({goTests})$' ./{dir}",
    only: ['pkg/calc/single_test.go'],
  });
  assert.deepEqual(single, { passed: ['pkg/calc/single_test.go'], failed: [] });
  assert.deepEqual(readArgv(), ['test', '-count=1', '-run', '^(TestOnly)$', './pkg/calc']);

  writeFileSync(
    join(dir, 'pkg', 'calc', 'multi_test.go'),
    [
      'package calc',
      'import "testing"',
      '',
      'func helper() {}',
      '// func TestCommented(t *testing.T) {}',
      'func (s *Suite) TestMethod(t *testing.T) {}',
      '  func TestIndented(t *testing.T) {}',
      'func BenchmarkAdd(b *testing.B) {}',
      'func ExampleAdd() {}',
      'func FuzzAdd(f *testing.F) {}',
      'func TestAdd(t *testing.T) {}',
      'func TestSub_1 (t *testing.T) {}',
      'func Test(t *testing.T) {}',
      '',
    ].join('\n'),
  );
  const multi = runTests(dir, {
    testCommand: 'node -e ""',
    testFileCommand: 'node record.mjs test -count=1 -run "^({goTests})$" ./{dir}',
    only: ['pkg/calc/multi_test.go'],
  });
  assert.deepEqual(multi, { passed: ['pkg/calc/multi_test.go'], failed: [] });
  assert.deepEqual(readArgv(), ['test', '-count=1', '-run', '^(TestAdd|TestSub_1|Test)$', './pkg/calc']);
});

test('runTests refuses unsafe file paths and unsafe {dir} / {stem} substitutions', (t) => {
  const { dir } = makeWorkspace(t);

  for (const bad of ['-rf', 'tests/a;rm.test.mjs', 'tests/has space.test.mjs', '../escape.test.mjs']) {
    assert.throws(
      () => runTests(dir, { testCommand: 'node -e ""', testFileCommand: 'node record.mjs', only: [bad] }),
      /unsafe test path/,
      `append mode must reject ${bad}`,
    );
    assert.throws(
      () => runTests(dir, { testCommand: 'node -e ""', testFileCommand: 'node record.mjs {file}', only: [bad] }),
      /unsafe test path/,
      `{file} must reject ${bad}`,
    );
  }

  assert.throws(
    () => runTests(dir, { testCommand: 'node -e ""', testFileCommand: 'node record.mjs ./{dir}', only: ['./-dir/add_test.go'] }),
    /unsafe test path/,
    'normalized leading-dash dir must be rejected',
  );

  // `tests/-evil.rs` passes SAFE_PATH as a whole path, but its {stem} `-evil` starts with `-`
  assert.throws(
    () => runTests(dir, { testCommand: 'node -e ""', testFileCommand: 'node record.mjs --test {stem}', only: ['tests/-evil.rs'] }),
    /unsafe \{stem\} placeholder/,
    '{stem} starting with "-" must be rejected by SAFE_PATH',
  );
});

test('runTests refuses invalid Go Test* names and files with zero Test* functions', (t) => {
  const { dir } = makeWorkspace(t);
  mkdirSync(join(dir, 'pkg'), { recursive: true });

  for (const [name, decl] of [
    ['dash_test.go', 'func TestBad-Name(t *testing.T) {}'],
    ['semi_test.go', 'func TestBad;rm(t *testing.T) {}'],
    ['space_test.go', 'func TestBad Name(t *testing.T) {}'],
    ['unicode_test.go', 'func TestCafé(t *testing.T) {}'],
  ]) {
    writeFileSync(join(dir, 'pkg', name), `package pkg\n${decl}\n`);
    assert.throws(
      () => runTests(dir, {
        testCommand: 'node -e ""',
        testFileCommand: "node record.mjs -run '^({goTests})$' ./{dir}",
        only: [`pkg/${name}`],
      }),
      /unsafe Go test name/,
      `must reject ${decl}`,
    );
  }

  writeFileSync(
    join(dir, 'pkg', 'empty_test.go'),
    [
      'package pkg',
      'import "testing"',
      'func BenchmarkOnly(b *testing.B) {}',
      'func ExampleOnly() {}',
      'func (s *Suite) TestMethod(t *testing.T) {}',
      '  func TestIndented(t *testing.T) {}',
      '',
    ].join('\n'),
  );
  assert.throws(
    () => runTests(dir, {
      testCommand: 'node -e ""',
      testFileCommand: "node record.mjs -run '^({goTests})$' ./{dir}",
      only: ['pkg/empty_test.go'],
    }),
    /no Go Test\* functions found/,
  );
});

test('runTests strips quotes around tokens with spaces and rejects unclosed quotes', (t) => {
  const { dir, readArgv } = makeWorkspace(t);
  runTests(dir, {
    testCommand: 'node -e ""',
    testFileCommand: 'node record.mjs "--tag=a b" \'single quoted\' {file}',
    only: ['tests/a.test.mjs'],
  });
  assert.deepEqual(readArgv(), ['--tag=a b', 'single quoted', 'tests/a.test.mjs']);

  assert.throws(
    () => runTests(dir, {
      testCommand: 'node -e ""',
      testFileCommand: "node record.mjs 'unclosed {file}",
      only: ['tests/a.test.mjs'],
    }),
    /unclosed quote/,
  );
});
