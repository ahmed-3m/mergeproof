import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_FILE, defaultConfig, loadConfig, parseConfig } from '../src/config.mjs';
import { FileFormatError } from '../src/errors.mjs';

test('no config file means all defaults', () => {
  assert.deepEqual(parseConfig(null), defaultConfig());
  const dir = mkdtempSync(join(tmpdir(), 'mp-config-'));
  try {
    assert.deepEqual(loadConfig(dir), defaultConfig());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('user keys deep-merge over defaults', () => {
  const cfg = parseConfig(JSON.stringify({ mode: 'enforce', proof: { headPassRuns: 5 }, paths: { docs: ['guide/**'] } }));
  assert.equal(cfg.mode, 'enforce');
  assert.equal(cfg.proof.headPassRuns, 5);
  assert.equal(cfg.proof.baseFailRuns, 2, 'sibling defaults survive');
  assert.deepEqual(cfg.paths.docs, ['guide/**'], 'arrays replace, not concatenate');
  assert.deepEqual(cfg.paths.tests, defaultConfig().paths.tests);
});

test('loadConfig reads the file from the repo root', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-config-'));
  try {
    writeFileSync(join(dir, CONFIG_FILE), '{ "testCommand": "npm run test:ci" }');
    assert.equal(loadConfig(dir).testCommand, 'npm run test:ci');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid config fails loudly with the offending key', () => {
  const cases = [
    ['{ nope', /not valid JSON/],
    ['[]', /config must be an object/],
    ['{ "mod": "enforce" }', /unknown key "mod"/],
    ['{ "proof": { "baseFailRun": 1 } }', /unknown key "proof.baseFailRun"/],
    ['{ "mode": "yolo" }', /"mode" must be one of/],
    ['{ "proof": { "headPassRuns": "3" } }', /"proof.headPassRuns" must be a number/],
    ['{ "proof": { "headPassRuns": 0 } }', /from 1 to 10/],
    ['{ "proof": { "headPassRuns": 2.5 } }', /an integer/],
    ['{ "trust": { "minCleanRate": 1.5 } }', /"trust.minCleanRate"/],
    ['{ "paths": { "tests": "tests/**" } }', /must be an array/],
    ['{ "paths": { "tests": [""] } }', /non-empty strings/],
    ['{ "paths": null }', /"paths" must be an object/],
    ['{ "testCommand": "  " }', /must not be empty/],
  ];
  for (const [text, msg] of cases) {
    assert.throws(() => parseConfig(text), (err) => err instanceof FileFormatError && msg.test(err.message), text);
  }
});
