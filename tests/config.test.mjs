import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_FILE, defaultConfig, loadConfig, parseConfig } from '../src/config.mjs';
import { matchesAny } from '../src/glob.mjs';
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
    ['{ "paths": { "testSupport": [""] } }', /"paths.testSupport" must contain only non-empty strings/],
    ['{ "paths": { "humanOnly": [""] } }', /"paths.humanOnly" must contain only non-empty strings/],
    ['{ "paths": { "humanOnly": "not-an-array" } }', /"paths.humanOnly" must be an array/],
    ['{ "limits": { "ciWaitSec": -1 } }', /"limits.ciWaitSec" must be an integer from 0 to 3600/],
    ['{ "paths": null }', /"paths" must be an object/],
    ['{ "testCommand": "  " }', /must not be empty/],
    ['{ "agents": { "identities": [] } }', /"agents.identities" must be an object, got array/],
    ['{ "agents": { "identities": { "agy-bot": "agy" } } }', /"agents.identities.agy-bot" must be an object with exactly "agent" and "model"/],
    ['{ "agents": { "logins": ["agy-bot"], "identities": { "agy-bot": { "agent": "agy" } } } }', /exactly "agent" and "model", got agent/],
    ['{ "agents": { "logins": ["agy-bot"], "identities": { "agy-bot": { "agent": "agy", "model": "gemini 4" } } } }', /"agents.identities.agy-bot.model" must be 1-100 characters/],
    ['{ "agents": { "logins": ["agy-bot"], "identities": { "agy-bot": { "agent": "agy", "model": "m", "extra": 1 } } } }', /exactly "agent" and "model", got agent, extra, model/],
    ['{ "agents": { "logins": ["claude-bot"], "identities": { "agy-bot": { "agent": "agy", "model": "m" } } } }', /"agents.identities.agy-bot" is not listed in "agents.logins"/],
    ['{ "agents": { "identities": { "__proto__": { "agent": "agy", "model": "m" } } } }', /"agents.identities.__proto__" is not a GitHub login/],
  ];
  for (const [text, msg] of cases) {
    assert.throws(() => parseConfig(text), (err) => err instanceof FileFormatError && msg.test(err.message), text);
  }
});

test('agents.identities maps a login to its own trust bucket', () => {
  const identities = { 'agy-bot': { agent: 'agy', model: 'gemini-4-argon-high' } };
  const cfg = parseConfig(JSON.stringify({ agents: { logins: ['claude-bot', 'agy-bot'], identities } }));
  assert.deepEqual(cfg.agents.identities, identities);
  assert.deepEqual(defaultConfig().agents.identities, {}, 'the default is an empty map');
});

test('multi-ecosystem manifest defaults match expected lockfiles and exclude source', () => {
  const manifests = defaultConfig().paths.manifests;
  const match = (p) => matchesAny(p, manifests);
  assert.ok(match('pyproject.toml'));
  assert.ok(match('go.sum'));
  assert.ok(match('Cargo.lock'));
  assert.ok(match('crates/x/Cargo.toml'));
  assert.ok(match('requirements-dev.txt'));
  assert.ok(match('sub/requirements-dev.txt'));
  assert.ok(match('svc/pyproject.toml'), 'svc/pyproject.toml');
  assert.ok(match('svc/go.sum'), 'svc/go.sum');
  assert.ok(match('crates/x/Cargo.lock'), 'crates/x/Cargo.lock');
  assert.ok(match('.pnpmfile.cjs'), '.pnpmfile.cjs');
  assert.ok(match('.yarn/plugins/x.cjs'), '.yarn/plugins/x.cjs');
  assert.ok(match('pnpm-workspace.yaml'), 'pnpm-workspace.yaml');
  assert.ok(match('requirements/base.txt'), 'requirements/base.txt');
  assert.ok(match('requirements.in'), 'requirements.in');
  assert.ok(match('constraints.txt'), 'constraints.txt');
  assert.ok(match('x/vendor/a.go'), 'x/vendor/a.go');
  assert.ok(match('.cargo/config.toml'), '.cargo/config.toml');
  assert.ok(match('.python-version'), '.python-version');
  assert.ok(!match('src/vendor.mjs'));
  assert.ok(!match('docs/requirements.md'));
  assert.ok(!match('src/cargo.mjs'));
  assert.ok(!match('src/cargo.lock.mjs'));
});
