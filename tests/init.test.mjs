// `mergeproof init` (M2 flow 1): detection over a real repo working tree,
// local file writes compared byte-for-byte, and remote setup through a fake
// `gh` that records every call. No real GitHub access, no real TTY.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInit, detect, defaultDeps } from '../src/commands/init.mjs';
import { redactSecret } from '../src/adapters/gh.mjs';
import { parseConfig } from '../src/config.mjs';

const PKG = `${JSON.stringify({ name: 'app', scripts: { test: 'node --test' } }, null, 2)}\n`;
const PLACEHOLDER_PKG = `${JSON.stringify({ name: 'app', scripts: { test: 'echo "Error: no test specified" && exit 1' } }, null, 2)}\n`;
const NO_TEST_PKG = `${JSON.stringify({ name: 'app' }, null, 2)}\n`;
const ci = (name, on) => `name: ${name}\n\non: ${on}\n\njobs:\n  test:\n    runs-on: ubuntu-latest\n`;
const BASE = {
  'package.json': PKG,
  'package-lock.json': '{ "name": "app", "lockfileVersion": 3 }\n',
  '.github/workflows/ci.yml': ci('CI', '[push, pull_request]'),
};

const MODEL_KEY = 'sk-live-model-123';
const BOT_TOKEN = 'ghp_bot_token_456';

function makeRepo(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mp-init-'));
  const git = (args) => {
    const res = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
    return res.stdout.trim();
  };
  git(['init', '--quiet', '--initial-branch=main']);
  const repo = {
    dir,
    write(rel, content) {
      const full = join(dir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
      return repo;
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
  for (const [rel, content] of Object.entries(files)) repo.write(rel, content);
  return repo;
}

const PROTECTED = {
  required_pull_request_reviews: { dismiss_stale_reviews: true },
  required_status_checks: { contexts: ['CI / test'] },
  restrictions: { users: [{ login: 'maintainer' }], teams: [], apps: [{ slug: 'github-actions' }] },
};

function fakeGh({
  repo = 'acme/app',
  defaultBranch = 'main',
  permission = 'write',
  protection = PROTECTED,
  rules = [],
  failProtection = false,
  throwSecret = null,
} = {}) {
  const calls = { label: [], variable: [], secret: [], repoView: 0, branch: 0, api: [] };
  return {
    calls,
    repoView() {
      calls.repoView++;
      return { repo, defaultBranch };
    },
    createLabel: (o) => calls.label.push(o),
    setVariable: (o) => calls.variable.push(o),
    setSecret(o) {
      calls.secret.push(o);
      if (throwSecret) throw new Error(throwSecret.replace('%V%', o.value));
    },
    branchExists() {
      calls.branch++;
      return false;
    },
    apiJson(path, { allow404 = false } = {}) {
      calls.api.push(path);
      if (path.endsWith('/protection')) {
        if (failProtection) throw new Error('gh api failed: Must have admin rights to view branch protection (HTTP 403)');
        return protection;
      }
      if (path.includes('/rules/branches/')) return rules;
      if (path.endsWith('/permission')) return { permission };
      if (path.includes('/branches/')) return allow404 ? null : undefined;
      throw new Error(`gh api failed: unexpected ${path} (HTTP 404)`);
    },
  };
}

function viewGh(repo = 'acme/app', defaultBranch = 'main') {
  return { repoView: () => ({ repo, defaultBranch }) };
}

function depsFor(repo, gh, out, { env = {}, isTTY = false, confirm = async () => true, overrides = {} } = {}) {
  return { ...defaultDeps, gh, env: () => env, isTTY: () => isTTY, confirm, print: (s) => out.push(s), cwd: () => repo.dir, overrides };
}

const detectDeps = (repo, overrides = {}) => ({ ...defaultDeps, gh: viewGh(), overrides });

// init defaults: a non-glm model (no base URL variable) and --yes.
const RUN = ['--yes', '--model', 'kimi-k2', '--bot-login', 'some-bot'];

// ---- detection -----------------------------------------------------------

test('detect picks the install command from the lockfile present', async () => {
  const cases = [
    [{ 'package-lock.json': '{}' }, 'npm ci'],
    [{ 'npm-shrinkwrap.json': '{}' }, 'npm ci'],
    [{ 'pnpm-lock.yaml': '' }, 'pnpm install --frozen-lockfile'],
    [{ 'yarn.lock': '' }, 'yarn install --frozen-lockfile'],
    [{}, 'npm install'], // package.json alone
    [{ 'package.json': null }, ':'], // no package.json at all
  ];
  for (const [extra, expected] of cases) {
    const files = { '.github/workflows/ci.yml': ci('CI', 'pull_request'), ...extra };
    if (extra['package.json'] === null) delete files['package.json'];
    else files['package.json'] = PKG;
    const repo = makeRepo(files);
    try {
      const d = detect(repo.dir, detectDeps(repo, { model: 'm', botLogin: 'bot', testCommand: 'npm test' }));
      assert.equal(d.installCommand, expected, JSON.stringify(extra));
    } finally {
      repo.cleanup();
    }
  }
});

test('detect requires --test-command when scripts.test is npm\'s placeholder or missing', async () => {
  for (const pkg of [PLACEHOLDER_PKG, NO_TEST_PKG]) {
    const repo = makeRepo({ 'package.json': pkg, '.github/workflows/ci.yml': ci('CI', 'pull_request') });
    try {
      await assert.rejects(async () => detect(repo.dir, detectDeps(repo, { model: 'm', botLogin: 'bot' })), /--test-command is required/);
      const d = detect(repo.dir, detectDeps(repo, { model: 'm', botLogin: 'bot', testCommand: 'node --test tests/' }));
      assert.equal(d.testCommand, 'node --test tests/');
    } finally {
      repo.cleanup();
    }
  }
});

test('detect finds npm test, and --test-command overrides it', async () => {
  const repo = makeRepo({ 'package.json': PKG, '.github/workflows/ci.yml': ci('CI', 'pull_request') });
  try {
    assert.equal(detect(repo.dir, detectDeps(repo, { model: 'm', botLogin: 'bot' })).testCommand, 'npm test');
    assert.equal(detect(repo.dir, detectDeps(repo, { model: 'm', botLogin: 'bot', testCommand: 'vitest run' })).testCommand, 'vitest run');
  } finally {
    repo.cleanup();
  }
});

test('detect keeps the default test globs and adds __tests__/** or spec/** only when nothing matches', async () => {
  const repo = makeRepo({ 'package.json': PKG, 'tests/x.test.mjs': '', '.github/workflows/ci.yml': ci('CI', 'pull_request') });
  const stray = makeRepo({ 'package.json': PKG, '.github/workflows/ci.yml': ci('CI', 'pull_request') });
  stray.write('__tests__/a.js', '');
  stray.write('spec/a.js', '');
  try {
    const defaults = (await import('../src/config.mjs')).defaultConfig().paths.tests;
    assert.deepEqual(detect(repo.dir, detectDeps(repo, { model: 'm', botLogin: 'bot' })).testPaths, defaults);
    assert.deepEqual(detect(stray.dir, detectDeps(stray, { model: 'm', botLogin: 'bot' })).testPaths, [...defaults, '__tests__/**', 'spec/**']);
  } finally {
    repo.cleanup();
    stray.cleanup();
  }
});

test('detect reads every on: form that includes pull_request', async () => {
  const forms = ['pull_request', '[push, pull_request]', '[pull_request]', '|\n  pull_request:\n    types: [opened]', 'pull_request:\n    branches: [main]'];
  for (const on of forms) {
    const repo = makeRepo({ 'package.json': PKG, '.github/workflows/ci.yml': ci('CI', on) });
    try {
      assert.equal(detect(repo.dir, detectDeps(repo, { model: 'm', botLogin: 'bot' })).ciWorkflow, 'CI', `on: ${on}`);
    } finally {
      repo.cleanup();
    }
  }
});

test('a workflow without pull_request is not a candidate', async () => {
  const repo = makeRepo({ 'package.json': PKG, '.github/workflows/ci.yml': ci('CI', '[push]') });
  try {
    await assert.rejects(async () => detect(repo.dir, detectDeps(repo, { model: 'm', botLogin: 'bot' })), /no pull_request workflow found/);
  } finally {
    repo.cleanup();
  }
});

test('several pull_request workflows are a usage error asking for --ci-workflow', async () => {
  const repo = makeRepo({
    'package.json': PKG,
    '.github/workflows/ci.yml': ci('CI', 'pull_request'),
    '.github/workflows/tests.yaml': ci('Tests', 'pull_request'),
    '.github/workflows/deploy.yml': ci('Deploy', '[push]'), // not a candidate
  });
  try {
    await assert.rejects(async () => detect(repo.dir, detectDeps(repo, { model: 'm', botLogin: 'bot' })), /multiple pull_request workflows found \(CI, Tests\)/);
    assert.equal(detect(repo.dir, detectDeps(repo, { model: 'm', botLogin: 'bot', ciWorkflow: 'Tests' })).ciWorkflow, 'Tests');
    await assert.rejects(async () => detect(repo.dir, detectDeps(repo, { model: 'm', botLogin: 'bot', ciWorkflow: 'Nope' })), /--ci-workflow "Nope" does not name/);
  } finally {
    repo.cleanup();
  }
});

test('workflows named mergeproof-* and a workflow without name: fall back to the path', async () => {
  const repo = makeRepo({
    'package.json': PKG,
    '.github/workflows/mergeproof-pr.yml': ci('mergeproof-pr', 'workflow_run'),
    '.github/workflows/build.yml': `on: pull_request\njobs:\n  test:\n    runs-on: ubuntu-latest\n`,
  });
  try {
    assert.equal(detect(repo.dir, detectDeps(repo, { model: 'm', botLogin: 'bot' })).ciWorkflow, '.github/workflows/build.yml');
  } finally {
    repo.cleanup();
  }
});

test('--model and --bot-login are required; glm- models default the base URL', async () => {
  const repo = makeRepo(BASE);
  try {
    await assert.rejects(async () => detect(repo.dir, detectDeps(repo, { botLogin: 'bot' })), /--model is required/);
    await assert.rejects(async () => detect(repo.dir, detectDeps(repo, { model: 'm' })), /--bot-login is required/);
    const glm = detect(repo.dir, detectDeps(repo, { model: 'glm-4.7', botLogin: 'bot' }));
    assert.equal(glm.baseUrl, 'https://api.z.ai/api/anthropic');
    assert.match(glm.notes.join('\n'), /--base-url defaulted/);
    assert.equal(detect(repo.dir, detectDeps(repo, { model: 'kimi-k2', botLogin: 'bot' })).baseUrl, null);
    assert.equal(detect(repo.dir, detectDeps(repo, { model: 'glm-4.7', botLogin: 'bot', baseUrl: 'https://x' })).baseUrl, 'https://x');
  } finally {
    repo.cleanup();
  }
});

test('CI workflow names and install commands that would break the YAML scalar are refused', async () => {
  for (const [overrides, note] of [
    [{ model: 'm', botLogin: 'bot', ciWorkflow: 'CI\nx' }, /newline/],
    [{ model: 'm', botLogin: 'bot', ciWorkflow: 'CI"X' }, /must not contain " or \\/],
    [{ model: 'm', botLogin: 'bot', installCommand: 'npm \\ci' }, /must not contain " or \\/],
    [{ model: 'm', botLogin: 'bot', installCommand: 'npm {{ci}}' }, /must not contain \{\{/],
  ]) {
    const repo = makeRepo(BASE);
    try {
      await assert.rejects(async () => detect(repo.dir, detectDeps(repo, overrides)), note);
    } finally {
      repo.cleanup();
    }
  }
});

// ---- local files ---------------------------------------------------------

test('init --yes writes the six local files, fills the placeholders and round-trips the config', async () => {
  const repo = makeRepo(BASE);
  try {
    const gh = fakeGh();
    const out = [];
    assert.equal(await runInit(RUN, depsFor(repo, gh, out)), 0, out.join('\n'));
    for (const path of [
      '.mergeproof.json',
      '.github/workflows/mergeproof-pr.yml',
      '.github/workflows/mergeproof-issue.yml',
      '.github/workflows/mergeproof-sync.yml',
      '.mergeproof/skills/bugfix/SKILL.md',
      '.mergeproof/skills/feature/SKILL.md',
    ]) {
      assert.ok(existsSync(join(repo.dir, path)), `${path} written`);
      assert.match(out.join('\n'), new RegExp(`created — ${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    }
    const pr = readFileSync(join(repo.dir, '.github/workflows/mergeproof-pr.yml'), 'utf8');
    assert.ok(pr.includes('workflows: ["CI"]'));
    assert.ok(pr.includes('run: "npm ci"'));
    assert.doesNotMatch(pr, /\{\{[A-Z]/, 'no placeholder left');
    assert.ok(pr.includes('${{'), 'GitHub expressions survive the fill');

    // Only keys that differ from defaultConfig(), plus mode.
    const text = readFileSync(join(repo.dir, '.mergeproof.json'), 'utf8');
    assert.deepEqual(JSON.parse(text), { mode: 'shadow', agents: { logins: ['some-bot'] } });
    const cfg = parseConfig(text); // must round-trip through the strict parser
    assert.equal(cfg.mode, 'shadow');
    assert.equal(cfg.testCommand, 'npm test');
    assert.deepEqual(cfg.agents.logins, ['some-bot']);

    // Skills are byte-for-byte copies from the package.
    for (const kind of ['bugfix', 'feature']) {
      assert.ok(readFileSync(join(repo.dir, `.mergeproof/skills/${kind}/SKILL.md`)).equals(readFileSync(resolve('skills', kind, 'SKILL.md'))));
    }
  } finally {
    repo.cleanup();
  }
});

test('re-running init is idempotent: every file unchanged', async () => {
  const repo = makeRepo(BASE);
  try {
    assert.equal(await runInit(RUN, depsFor(repo, fakeGh(), [])), 0);
    const gh = fakeGh();
    const out = [];
    assert.equal(await runInit(RUN, depsFor(repo, gh, out)), 0, out.join('\n'));
    const unchanged = out.join('\n').split('\n').filter((l) => /^\s+unchanged — /.test(l));
    assert.equal(unchanged.length, 6, 'all six files unchanged');
    assert.ok(out.join('\n').split('\n').every((l) => !/^\s+created — |^\s+overwritten — /.test(l)), 'nothing written on the second run');
  } finally {
    repo.cleanup();
  }
});

test('a file that drifted is skipped with a note, and --force replaces it', async () => {
  const repo = makeRepo(BASE);
  try {
    assert.equal(await runInit(RUN, depsFor(repo, fakeGh(), [])), 0);
    repo.write('.mergeproof.json', '{ "mode": "enforce" }\n');
    let out = [];
    assert.equal(await runInit(RUN, depsFor(repo, fakeGh(), out)), 0);
    assert.match(out.join('\n'), /skipped — \.mergeproof\.json/);
    assert.equal(readFileSync(join(repo.dir, '.mergeproof.json'), 'utf8'), '{ "mode": "enforce" }\n');
    out = [];
    assert.equal(await runInit([...RUN, '--force'], depsFor(repo, fakeGh(), out)), 0);
    assert.match(out.join('\n'), /overwritten — \.mergeproof\.json/);
    assert.deepEqual(JSON.parse(readFileSync(join(repo.dir, '.mergeproof.json'), 'utf8')), { mode: 'shadow', agents: { logins: ['some-bot'] } });
  } finally {
    repo.cleanup();
  }
});

test('template line endings are preserved: identical bytes mean unchanged, a drifted CRLF copy is skipped', async () => {
  const repo = makeRepo(BASE);
  try {
    assert.equal(await runInit(RUN, depsFor(repo, fakeGh(), [])), 0);
    // Re-running on the files init just wrote (LF) compares byte-for-byte:
    // unchanged, never rewritten, so the bytes on disk stay exactly as written.
    const before = readFileSync(join(repo.dir, '.github/workflows/mergeproof-issue.yml'));
    const out = [];
    assert.equal(await runInit(RUN, depsFor(repo, fakeGh(), out)), 0);
    assert.ok(before.equals(readFileSync(join(repo.dir, '.github/workflows/mergeproof-issue.yml'))));
    // A CRLF copy differs from what init writes and is skipped without --force.
    repo.write('.github/workflows/mergeproof-issue.yml', before.toString('utf8').replaceAll('\n', '\r\n'));
    const out2 = [];
    assert.equal(await runInit(RUN, depsFor(repo, fakeGh(), out2)), 0);
    assert.match(out2.join('\n'), /skipped — \.github\/workflows\/mergeproof-issue\.yml/);
    assert.ok(readFileSync(join(repo.dir, '.github/workflows/mergeproof-issue.yml')).includes('\r\n'), 'the drifted file was not touched');
  } finally {
    repo.cleanup();
  }
});

// ---- remote setup --------------------------------------------------------

test('remote setup sets labels, variables and secrets, and only those', async () => {
  const repo = makeRepo(BASE);
  try {
    const gh = fakeGh();
    const out = [];
    assert.equal(await runInit(['--yes', '--model', 'glm-4.7', '--bot-login', 'some-bot'], depsFor(repo, gh, out, { env: { MERGEPROOF_MODEL_KEY: MODEL_KEY, MERGEPROOF_BOT_TOKEN: BOT_TOKEN } })), 0, out.join('\n'));
    assert.deepEqual(gh.calls.label.map((l) => l.name), ['agent', 'needs-human']);
    for (const call of gh.calls.label) {
      assert.equal(call.repo, 'acme/app');
      assert.match(call.color, /^[0-9A-F]{6}$/i);
      assert.ok(call.description.length > 0);
    }
    assert.deepEqual(
      gh.calls.variable.map((v) => [v.name, v.value]),
      [
        ['MERGEPROOF_AGENT', 'claude-code'],
        ['MERGEPROOF_MODEL', 'glm-4.7'],
        ['MERGEPROOF_BOT_LOGIN', 'some-bot'],
        ['MERGEPROOF_MODEL_BASE_URL', 'https://api.z.ai/api/anthropic'],
      ],
    );
    assert.deepEqual(
      gh.calls.secret.map((s) => [s.repo, s.name, s.value]),
      [
        ['acme/app', 'MERGEPROOF_MODEL_KEY', MODEL_KEY],
        ['acme/app', 'MERGEPROOF_BOT_TOKEN', BOT_TOKEN],
      ],
    );
    const text = out.join('\n');
    assert.ok(!text.includes(MODEL_KEY) && !text.includes(BOT_TOKEN), 'secret values never appear in the output');
    assert.match(text, /set — label agent/);
    assert.match(text, /set — secret MERGEPROOF_MODEL_KEY/);
    assert.match(text, /maintainer: optional variables MERGEPROOF_MODE/);
    assert.match(text, /ok — branch mergeproof-ledger \(created on the first verdict\)/);
  } finally {
    repo.cleanup();
  }
});

test('an unset secret env var becomes a manual step, not a failure', async () => {
  const repo = makeRepo(BASE);
  try {
    const gh = fakeGh();
    const out = [];
    assert.equal(await runInit(RUN, depsFor(repo, gh, out)), 0, out.join('\n'));
    assert.deepEqual(gh.calls.secret, []);
    assert.match(out.join('\n'), new RegExp(`manual — secret MERGEPROOF_MODEL_KEY \\(not set — run: gh secret set MERGEPROOF_MODEL_KEY --repo acme/app\\)`));
  } finally {
    repo.cleanup();
  }
});

test('a gh failure message echoing a secret value is redacted', async () => {
  const repo = makeRepo(BASE);
  try {
    // The adapter's redaction, on a fake failure message containing the value.
    const redacted = redactSecret(`gh secret set failed: value "${MODEL_KEY}" rejected (HTTP 422)`, MODEL_KEY);
    assert.ok(!redacted.includes(MODEL_KEY), 'the value is gone');
    assert.ok(redacted.includes('***'), 'the redaction marker is there');

    // And init scrubs anything a misbehaving gh echoes back before it throws.
    const gh = fakeGh({ throwSecret: 'gh secret set failed: invalid value "%V%" (HTTP 422)' });
    await assert.rejects(
      runInit(RUN, depsFor(repo, gh, [], { env: { MERGEPROOF_MODEL_KEY: MODEL_KEY } })),
      (err) => !err.message.includes(MODEL_KEY) && err.message.includes('***'),
    );
  } finally {
    repo.cleanup();
  }
});

test('--dry-run writes nothing and makes no gh write call', async () => {
  const repo = makeRepo(BASE);
  try {
    const gh = fakeGh();
    const out = [];
    assert.equal(await runInit(['--dry-run', ...RUN], depsFor(repo, gh, out)), 0, out.join('\n'));
    assert.deepEqual([gh.calls.label, gh.calls.variable, gh.calls.secret], [[], [], []], 'no gh writes');
    assert.ok(gh.calls.repoView === 1 && gh.calls.branch === 1 && gh.calls.api.length > 0, 'reads still happen');
    for (const path of ['.mergeproof.json', '.github/workflows/mergeproof-pr.yml', '.mergeproof/skills/bugfix/SKILL.md']) {
      assert.ok(!existsSync(join(repo.dir, path)), `${path} not written`);
    }
    const text = out.join('\n');
    assert.match(text, /would-create — \.mergeproof\.json/);
    assert.match(text, /would-set — label agent/);
    assert.match(text, /nothing was written/);
  } finally {
    repo.cleanup();
  }
});

test('without --yes and no TTY, remote writes are skipped and reported', async () => {
  const repo = makeRepo(BASE);
  try {
    const gh = fakeGh();
    const out = [];
    assert.equal(await runInit(['--model', 'kimi-k2', '--bot-login', 'some-bot'], depsFor(repo, gh, out, { isTTY: false })), 0, out.join('\n'));
    assert.deepEqual([gh.calls.label, gh.calls.variable, gh.calls.secret], [[], [], []], 'no remote writes');
    assert.ok(existsSync(join(repo.dir, '.mergeproof.json')), 'local files are still written');
    assert.match(out.join('\n'), /skipped — label agent \(re-run with --yes\)/);
  } finally {
    repo.cleanup();
  }
});

test('a TTY asks for confirmation with the count and the repo; yes applies, no skips', async () => {
  const repo = makeRepo(BASE);
  try {
    const questions = [];
    const confirm = async (q) => {
      questions.push(q);
      return questions.length === 1;
    };
    const gh = fakeGh();
    const out = [];
    assert.equal(await runInit(['--model', 'kimi-k2', '--bot-login', 'some-bot'], depsFor(repo, gh, out, { isTTY: true, confirm })), 0, out.join('\n'));
    assert.deepEqual(questions, ['Apply 5 remote changes to acme/app? [y/N] ']); // 2 labels + 3 variables; the two unset secrets are manual steps, not counted
    assert.deepEqual(gh.calls.label.length, 2, 'confirmed: writes applied');

    const gh2 = fakeGh();
    const out2 = [];
    assert.equal(await runInit(['--model', 'kimi-k2', '--bot-login', 'some-bot'], depsFor(repo, gh2, out2, { isTTY: true, confirm: async () => false })), 0, out2.join('\n'));
    assert.deepEqual([gh2.calls.label, gh2.calls.variable, gh2.calls.secret], [[], [], []], 'declined: nothing applied');
  } finally {
    repo.cleanup();
  }
});

// ---- verification --------------------------------------------------------

test('verification reports ok for a protected repo with a write bot', async () => {
  const repo = makeRepo(BASE);
  try {
    const out = [];
    assert.equal(await runInit(RUN, depsFor(repo, fakeGh(), out)), 0, out.join('\n'));
    const text = out.join('\n');
    assert.match(text, /ok — pull requests required on main/);
    assert.match(text, /ok — CI checks required on main/);
    assert.match(text, /ok — merges restricted on main \(classic restrictions\)/);
    assert.match(text, /ok — bot permission for some-bot \(write\)/);
    assert.match(text, /manual — bot token scopes/);
    assert.match(text, /manual — bot push triggers CI/);
    assert.match(text, /manual — branch protection guidance .*github\.token/);
  } finally {
    repo.cleanup();
  }
});

test('an admin bot and an unprivileged bot are warnings, not failures', async () => {
  for (const [permission, note] of [
    ['admin', /admin: the bot could bypass the gate/],
    ['maintain', /maintain: the bot could bypass the gate/],
    ['read', /read: the bot cannot push agent branches/],
  ]) {
    const repo = makeRepo(BASE);
    try {
      const out = [];
      assert.equal(await runInit(RUN, depsFor(repo, fakeGh({ permission }), out)), 0, out.join('\n'));
      assert.match(out.join('\n'), note);
    } finally {
      repo.cleanup();
    }
  }
});

test('a protection API the login cannot read becomes unknown, never a crash', async () => {
  const repo = makeRepo(BASE);
  try {
    const gh = fakeGh({ failProtection: true });
    const out = [];
    assert.equal(await runInit(RUN, depsFor(repo, gh, out)), 0, out.join('\n'));
    const text = out.join('\n');
    assert.match(text, /unknown — pull requests required on main/);
    assert.match(text, /unknown — merges restricted on main/);
    assert.match(text, /unknown — CI checks required on main/);
    assert.ok(!text.includes('TypeError') && !text.includes('    at '), 'no stack trace');
  } finally {
    repo.cleanup();
  }
});

// The shape GET /repos/{o}/{r}/rules/branches/{b} returns: active rules only,
// no enforcement field and no bypass list.
const ruleFrom = (type, parameters) => ({ type, ...(parameters ? { parameters } : {}), ruleset_source_type: 'Repository', ruleset_source: 'acme/app', ruleset_id: 7 });

test('rulesets count for PRs, required checks and restrict-updates', async () => {
  const repo = makeRepo(BASE);
  try {
    const rules = [
      ruleFrom('pull_request', { required_approving_review_count: 1 }),
      ruleFrom('required_status_checks', { required_status_checks: [{ context: 'CI / test' }] }),
      ruleFrom('update', { update_allows_fetch_and_merge: false }),
    ];
    const out = [];
    assert.equal(await runInit(RUN, depsFor(repo, fakeGh({ protection: null, rules }), out)), 0, out.join('\n'));
    const text = out.join('\n');
    assert.match(text, /ok — pull requests required on main/); // from the ruleset only (classic protection is null)
    assert.match(text, /ok — CI checks required on main/);
    assert.match(text, /ok — merges restricted on main \(a restrict-updates ruleset/);
  } finally {
    repo.cleanup();
  }
});

test('rulesets without restrict-updates leave merges unrestricted', async () => {
  const repo = makeRepo(BASE);
  try {
    const rules = [ruleFrom('pull_request', { required_approving_review_count: 1 }), ruleFrom('non_fast_forward')];
    const out = [];
    assert.equal(await runInit(RUN, depsFor(repo, fakeGh({ protection: null, rules }), out)), 0, out.join('\n'));
    assert.match(out.join('\n'), /warn — merges restricted on main \(pushes are not restricted/);
  } finally {
    repo.cleanup();
  }
});

test('classic restrictions: empty lists still restrict, but the github-actions app must be listed', async () => {
  for (const [apps, want] of [
    [[{ slug: 'github-actions' }], /ok — merges restricted on main \(classic restrictions\)/],
    [[], /warn — merges restricted on main \(classic push restrictions do not list the github-actions app/],
  ]) {
    const repo = makeRepo(BASE);
    try {
      const protection = { required_pull_request_reviews: {}, restrictions: { users: [], teams: [], apps } };
      const out = [];
      assert.equal(await runInit(RUN, depsFor(repo, fakeGh({ protection, rules: [] }), out)), 0, out.join('\n'));
      assert.match(out.join('\n'), want);
    } finally {
      repo.cleanup();
    }
  }
});

// ---- CLI surface ---------------------------------------------------------

test('init outside a git repository is a usage error; positionals too', async () => {
  const nowhere = mkdtempSync(join(tmpdir(), 'mp-init-'));
  try {
    await assert.rejects(runInit(RUN, { ...defaultDeps, gh: fakeGh(), cwd: () => nowhere, env: () => ({}), isTTY: () => false, print: () => {} }), /inside a git repository/);
  } finally {
    rmSync(nowhere, { recursive: true, force: true });
  }
  const repo = makeRepo(BASE);
  try {
    await assert.rejects(runInit([...RUN, 'extra'], depsFor(repo, fakeGh(), [])), /init takes no arguments/);
  } finally {
    repo.cleanup();
  }
});

test('--json prints one object with repo, detected, files, remote and checks', async () => {
  const repo = makeRepo(BASE);
  try {
    const gh = fakeGh();
    const out = [];
    assert.equal(await runInit([...RUN, '--json'], depsFor(repo, gh, out, { env: { MERGEPROOF_BOT_TOKEN: BOT_TOKEN } })), 0);
    const obj = JSON.parse(out.join('\n'));
    assert.deepEqual(Object.keys(obj), ['repo', 'detected', 'files', 'remote', 'checks']);
    assert.equal(obj.repo, 'acme/app');
    assert.equal(obj.detected.installCommand, 'npm ci');
    assert.equal(obj.detected.ciWorkflow, 'CI');
    assert.ok(obj.files.length === 6 && obj.remote.length > 0 && obj.checks.length > 0);
    assert.ok(!out.join('\n').includes(BOT_TOKEN), 'no secret value in the JSON');
  } finally {
    repo.cleanup();
  }
});
