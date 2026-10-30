import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import readline from 'node:readline';
import { parseFlags } from '../args.mjs';
import { UsageError } from '../errors.mjs';
import { CONFIG_FILE, defaultConfig } from '../config.mjs';
import { matchesAny } from '../glob.mjs';
import * as git from '../adapters/git.mjs';
import * as gh from '../adapters/gh.mjs';

// `mergeproof init` (M2 flow 1): install mergeproof into the repository in the
// current directory in one command. Safe to re-run, writes only what it
// reports, and never handles a secret value in argv, output or files: secret
// values come from the environment of the same name and travel to
// `gh secret set` on the child's stdin (never argv).

export const defaultDeps = {
  git,
  gh,
  cwd: () => process.cwd(),
  print: (s) => console.log(s),
  env: () => process.env,
  isTTY: () => Boolean(process.stdin.isTTY),
  // Injectable so tests never touch a real TTY.
  confirm: (question) =>
    new Promise((resolveAnswer) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(question, (answer) => {
        rl.close();
        resolveAnswer(/^(y|yes)$/i.test(answer.trim()));
      });
    }),
  overrides: {},
};

// Package data ships with the npm package; resolve relative to this module,
// never the cwd, so `npx mergeproof init` reads the installed templates.
const WORKFLOW_TEMPLATES_DIR = new URL('../../templates/workflows/', import.meta.url);
const SKILLS_DIR = new URL('../../skills/', import.meta.url);
const WORKFLOWS = ['mergeproof-pr.yml', 'mergeproof-issue.yml', 'mergeproof-sync.yml'];
const SKILLS = ['bugfix', 'feature'];
const LEDGER_BRANCH = 'mergeproof-ledger';

// Fixed label colours and descriptions: the workflows match on the names.
const LABELS = [
  { name: 'agent', color: '1D76DB', description: 'mergeproof: dispatch this issue to the coding agent' },
  { name: 'agent:urgent', color: 'B60205', description: 'mergeproof: dispatch this issue to the coding agent now' },
  { name: 'needs-human', color: 'D93F0B', description: 'mergeproof: the gate handed this over to a human' },
];

const SECRET_ENV_VARS = ['MERGEPROOF_MODEL_KEY', 'MERGEPROOF_BOT_TOKEN'];
// Repo variables only the maintainer sets; init reports them, never writes them.
const MAINTAINER_VARIABLES = ['MERGEPROOF_MODE', 'MERGEPROOF_AUTHORS', 'MERGEPROOF_DAILY_LIMIT', 'MERGEPROOF_BUGFIX_LABELS'];

const NPM_TEST_PLACEHOLDER = 'echo "Error: no test specified" && exit 1';
const GLM_BASE_URL = 'https://api.z.ai/api/anthropic';

const firstLine = (s) => String(s).split('\n')[0];

/** Every file in the working tree, repo-relative with forward slashes. */
function walkFiles(root, dir = root, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(root, full, out);
    else if (entry.isFile()) out.push(relative(root, full).split(sep).join('/'));
  }
  return out;
}

function detectInstallCommand(files) {
  const names = new Set(files);
  if (names.has('package-lock.json') || names.has('npm-shrinkwrap.json')) return 'npm ci';
  if (names.has('pnpm-lock.yaml')) return 'pnpm install --frozen-lockfile';
  if (names.has('yarn.lock')) return 'yarn install --frozen-lockfile';
  if (names.has('package.json')) return 'npm install';
  return ':';
}

/** `npm test` when scripts.test is real; null when it is npm's placeholder, empty or missing. */
function detectTestCommand(root, files) {
  if (!files.includes('package.json')) return null;
  let pkg = null;
  try {
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
  const test = pkg?.scripts?.test;
  if (typeof test !== 'string' || test.trim() === '' || test.trim() === NPM_TEST_PLACEHOLDER) return null;
  return 'npm test';
}

/** Default test globs kept as they are; a stray __tests__/ or spec/ dir is added when nothing matches. */
function detectTestPaths(root, files) {
  const paths = [...defaultConfig().paths.tests]; // never drop the defaults
  const any = files.some((f) => matchesAny(f, paths));
  if (!any) {
    if (existsSync(join(root, '__tests__'))) paths.push('__tests__/**');
    if (existsSync(join(root, 'spec'))) paths.push('spec/**');
  }
  return paths;
}

// A small line-based reader instead of a YAML library (zero dependencies).

/** Top-level `name:`, quoted or not; GitHub falls back to the file path, so we do too. */
function workflowName(text, fallback) {
  for (const line of text.split(/\r?\n/)) {
    const m = /^name:\s*(.*)$/.exec(line);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '') || fallback;
  }
  return fallback;
}

/** Does the `on:` block include pull_request? Handles the scalar, list and block-mapping forms. */
function triggersPullRequest(text) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^["']?on["']?:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const rest = m[1].split('#')[0].trim();
    if (!rest || /^[|>][+-]?[0-9]*$/.test(rest)) {
      // Block mapping (or a literal/folded block scalar): look for a
      // `pull_request:` key until the block ends.
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (l.trim() === '' || l.trim().startsWith('#')) continue;
        if (!/^\s/.test(l)) break;
        if (/^\s+["']?pull_request["']?\s*:/.test(l)) return true;
      }
      return false;
    }
    const strip = (s) => s.trim().replace(/^["']|["']$/g, '').replace(/:$/, '');
    const items = rest.startsWith('[') ? rest.replace(/^\[/, '').replace(/\].*$/, '').split(',').map(strip) : [strip(rest)];
    return items.includes('pull_request');
  }
  return false;
}

/** Non-mergeproof workflow files in .github/workflows, with name and pull_request trigger. */
function readWorkflows(root) {
  const dir = join(root, '.github', 'workflows');
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !/\.ya?ml$/.test(entry.name) || entry.name.startsWith('mergeproof-')) continue;
    const rel = `.github/workflows/${entry.name}`;
    const text = readFileSync(join(dir, entry.name), 'utf8');
    out.push({ file: rel, name: workflowName(text, rel), pullRequest: triggersPullRequest(text) });
  }
  return out;
}

function detectCiWorkflow(root, override) {
  const workflows = readWorkflows(root);
  if (override) {
    const match = workflows.find((w) => w.name === override);
    if (!match) {
      throw new UsageError(
        `--ci-workflow "${override}" does not name a workflow in .github/workflows/ (found: ${workflows.map((w) => w.name).join(', ') || 'none'})`,
      );
    }
    return match.name;
  }
  const candidates = workflows.filter((w) => w.pullRequest);
  if (candidates.length === 1) return candidates[0].name;
  if (candidates.length > 1) {
    throw new UsageError(`multiple pull_request workflows found (${candidates.map((w) => w.name).join(', ')}); pass --ci-workflow with one of them`);
  }
  throw new UsageError(
    'no pull_request workflow found in .github/workflows/: mergeproof gates a PR only after the repo\u2019s own PR CI completes, so it needs one (or pass --ci-workflow)',
  );
}

// Both placeholders land inside double-quoted YAML scalars (`workflows:
// ["\u2026"]` and `run: "\u2026"`): a newline, `"`, `\` or a control character
// would break the scalar, and `{{` would become a GitHub expression.
function assertScalarValue(value, what) {
  if (/[\r\n]/.test(value)) throw new UsageError(`${what} must not contain a newline (it lands inside a double-quoted YAML scalar)`);
  if (/["\\]/.test(value)) throw new UsageError(`${what} must not contain " or \\ (it lands inside a double-quoted YAML scalar)`);
  if (/[\x00-\x1f\x7f]/.test(value)) throw new UsageError(`${what} must not contain control characters`);
  if (value.includes('{{')) throw new UsageError(`${what} must not contain {{ (GitHub would evaluate it as an expression)`);
}

/**
 * Detection, pure apart from gh/git reads through `deps`: no writes. Flags
 * arrive as `deps.overrides` (camelCase; runInit maps the dashed flags onto
 * them) so tests can drive detection without parsing argv.
 */
export function detect(root, deps = defaultDeps) {
  const o = { ...(deps.overrides ?? {}) };
  if (!o.model) throw new UsageError('--model is required: the model name the gate logs trust for (e.g. --model glm-4.7)');
  if (!o.botLogin) throw new UsageError('--bot-login is required: the login of the machine user whose token opens agent PRs');
  const agent = o.agent ?? 'claude-code';
  const notes = [];
  let baseUrl = o.baseUrl ?? null;
  if (!baseUrl && o.model.startsWith('glm-')) {
    baseUrl = GLM_BASE_URL;
    notes.push(`--model ${o.model} starts with glm-: --base-url defaulted to ${GLM_BASE_URL}`);
  }

  const files = walkFiles(root);
  // Overrides are validated before they are used, so a broken value never
  // reaches a lookup or a template.
  if (o.installCommand) assertScalarValue(o.installCommand, '--install-command');
  if (o.ciWorkflow) assertScalarValue(o.ciWorkflow, '--ci-workflow');
  const installCommand = o.installCommand ?? detectInstallCommand(files);
  assertScalarValue(installCommand, 'the install command');
  const testCommand = o.testCommand ?? detectTestCommand(root, files);
  if (!testCommand) throw new UsageError(`--test-command is required: package.json has no scripts.test beyond npm\u2019s placeholder`);
  const testPaths = detectTestPaths(root, files);
  const ciWorkflow = detectCiWorkflow(root, o.ciWorkflow);
  assertScalarValue(ciWorkflow, 'the CI workflow name');

  const view = deps.gh.repoView();
  if (!view?.repo) throw new Error('gh repo view returned no repository');
  return {
    repo: view.repo,
    defaultBranch: view.defaultBranch ?? 'main',
    agent,
    model: o.model,
    baseUrl,
    botLogin: o.botLogin,
    installCommand,
    testCommand,
    testPaths,
    ciWorkflow,
    notes,
  };
}

function configText(detected) {
  const defaults = defaultConfig();
  const out = { mode: 'shadow' }; // constraint 7: new installs are safe by default
  if (detected.testCommand !== defaults.testCommand) out.testCommand = detected.testCommand;
  if (JSON.stringify(detected.testPaths) !== JSON.stringify(defaults.paths.tests)) out.paths = { tests: detected.testPaths };
  out.agents = { logins: [detected.botLogin] };
  return `${JSON.stringify(out, null, 2)}\n`;
}

export function fillTemplate(text, { ciWorkflow, installCommand }) {
  const filled = text.replaceAll('{{CI_WORKFLOW}}', ciWorkflow).replaceAll('{{INSTALL_COMMAND}}', installCommand);
  // `{{NAME}}` placeholders are uppercase with no spaces; GitHub's own
  // `${{ expr }}` (always a space after ${{) must survive untouched.
  const left = /\{\{[A-Z][A-Z0-9_]*\}\}/.exec(filled);
  if (left) throw new Error(`workflow template placeholder ${left[0]} was not filled`);
  return filled;
}

function buildLocalFiles(detected) {
  return [
    { path: CONFIG_FILE, content: Buffer.from(configText(detected), 'utf8') },
    ...WORKFLOWS.map((name) => ({
      path: `.github/workflows/${name}`,
      // Read as utf8 and written back as utf8: the placeholders contain no
      // newline, so the template's own line endings are preserved exactly.
      content: Buffer.from(fillTemplate(readFileSync(new URL(name, WORKFLOW_TEMPLATES_DIR), 'utf8'), detected), 'utf8'),
    })),
    ...SKILLS.map((kind) => ({
      path: `.mergeproof/skills/${kind}/SKILL.md`,
      content: readFileSync(new URL(`${kind}/SKILL.md`, SKILLS_DIR)), // byte-for-byte
    })),
  ];
}

/** absent → create, identical → unchanged, different → skipped (unless --force). Dry-run writes nothing. */
function writeLocal(root, files, { dryRun, force }) {
  return files.map((f) => {
    const abs = join(root, f.path);
    const existing = existsSync(abs) ? readFileSync(abs) : null;
    if (existing === null) {
      if (!dryRun) {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, f.content);
      }
      return { path: f.path, status: dryRun ? 'would-create' : 'created' };
    }
    if (existing.equals(f.content)) return { path: f.path, status: 'unchanged' };
    if (!force) return { path: f.path, status: 'skipped', note: 'differs from what init writes; re-run with --force to replace it' };
    if (!dryRun) writeFileSync(abs, f.content);
    return { path: f.path, status: dryRun ? 'would-overwrite' : 'overwritten' };
  });
}

/** The remote steps in execution order: labels, variables, secrets. */
function remoteSteps(detected, env) {
  const steps = [];
  for (const label of LABELS) steps.push({ kind: 'label', what: `label ${label.name}`, ...label });
  steps.push({ kind: 'variable', what: 'variable MERGEPROOF_AGENT', name: 'MERGEPROOF_AGENT', value: detected.agent });
  steps.push({ kind: 'variable', what: 'variable MERGEPROOF_MODEL', name: 'MERGEPROOF_MODEL', value: detected.model });
  steps.push({ kind: 'variable', what: 'variable MERGEPROOF_BOT_LOGIN', name: 'MERGEPROOF_BOT_LOGIN', value: detected.botLogin });
  if (detected.baseUrl) steps.push({ kind: 'variable', what: 'variable MERGEPROOF_MODEL_BASE_URL', name: 'MERGEPROOF_MODEL_BASE_URL', value: detected.baseUrl });
  for (const name of SECRET_ENV_VARS) {
    const value = env[name];
    // Only ever read from the environment of the same name; empty means unset.
    if (value) steps.push({ kind: 'secret', what: `secret ${name}`, name, value });
    else steps.push({ kind: 'manual-secret', what: `secret ${name}`, name });
  }
  return steps;
}

/**
 * Run the remote steps. `mode`: 'apply' (write), 'plan' (dry-run: would-set),
 * 'skip' (no confirmation: re-run with --yes). Manual-secret steps always
 * report the exact command to run instead.
 */
function executeRemote(detected, steps, deps, mode) {
  const results = [];
  const secrets = steps.filter((s) => s.kind === 'secret').map((s) => s.value);
  const manualNote = (s) => `not set — run: gh secret set ${s.name} --repo ${detected.repo}`;
  try {
    for (const s of steps) {
      if (s.kind === 'manual-secret') {
        results.push({ what: s.what, status: 'manual', note: manualNote(s) });
      } else if (mode === 'plan') {
        results.push({ what: s.what, status: 'would-set' });
      } else if (mode === 'skip') {
        results.push({ what: s.what, status: 'skipped', note: 're-run with --yes' });
      } else if (s.kind === 'label') {
        deps.gh.createLabel({ repo: detected.repo, name: s.name, color: s.color, description: s.description });
        results.push({ what: s.what, status: 'set' });
      } else if (s.kind === 'variable') {
        deps.gh.setVariable({ repo: detected.repo, name: s.name, value: s.value });
        results.push({ what: s.what, status: 'set', note: s.value });
      } else if (s.kind === 'secret') {
        deps.gh.setSecret({ repo: detected.repo, name: s.name, value: s.value });
        results.push({ what: s.what, status: 'set' });
      }
    }
  } catch (err) {
    // Defense in depth: even if an error message somehow carried a secret
    // value, it never leaves this function.
    let msg = err instanceof Error ? err.message : String(err);
    for (const v of secrets) msg = msg.split(v).join('***');
    throw new Error(msg);
  }
  return results;
}

/** Rules anywhere in a /rules/branches answer (items may nest full rulesets). */
function flattenRules(value) {
  const rules = [];
  const walk = (node) => {
    if (Array.isArray(node)) return void node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (typeof node.type === 'string') rules.push(node);
    for (const child of Object.values(node)) {
      if (child && typeof child === 'object') walk(child);
    }
  };
  walk(value);
  return rules;
}

/**
 * Read-only post-install verification. Every item is ok | warn | unknown |
 * manual; an unreadable API becomes `unknown` with the reason, never a crash.
 * Protection settings are never changed — the guidance below is the output.
 */
function verify(detected, deps) {
  const { repo, defaultBranch: branch, ciWorkflow, botLogin } = detected;
  const enc = encodeURIComponent;
  const read = (path, opts) => {
    try {
      return { value: deps.gh.apiJson(path, opts) };
    } catch (err) {
      return { error: firstLine(err.message) };
    }
  };

  const protection = read(`repos/${repo}/branches/${enc(branch)}/protection`, { allow404: true });
  const rules = read(`repos/${repo}/rules/branches/${enc(branch)}`, { allow404: true });

  const classic = protection.value ?? {};
  const classicPrs = classic.required_pull_request_reviews != null;
  const classicContexts = [
    ...(classic.required_status_checks?.contexts ?? []),
    ...(classic.required_status_checks?.checks ?? []).map((c) => c?.context ?? ''),
  ];
  // Any classic restrictions object restricts pushes, even with empty lists
  // (then only admins may push). The apply job merges as the github-actions
  // app, so it must be listed there or every mergeproof merge is refused.
  const classicRestricted = classic.restrictions != null;
  const botListed = (classic.restrictions?.users ?? []).some((u) => (u?.login ?? u) === botLogin);
  const actionsListed = (classic.restrictions?.apps ?? []).some((a) => (a?.slug ?? a) === 'github-actions');

  const allRules = rules.error ? [] : flattenRules(rules.value ?? []);
  const enforcing = allRules.filter((r) => r.enforcement === undefined || r.enforcement === 'active');
  const rulesPrs = enforcing.some((r) => r.type === 'pull_request');
  const rulesContexts = enforcing
    .filter((r) => r.type === 'required_status_checks')
    .flatMap((r) =>
      Array.isArray(r.parameters?.required_status_checks)
        ? r.parameters.required_status_checks.map((c) => (typeof c === 'string' ? c : c?.context ?? ''))
        : [],
    );
  // "Restrict updates": only the ruleset's bypass actors may update the branch.
  // /rules/branches does not return the bypass list, so it can't be checked here.
  const rulesRestricted = enforcing.some((r) => r.type === 'update');

  const checks = [];
  const sources = [protection.error ? null : 'classic protection', rules.error ? null : 'rulesets'].filter(Boolean).join(' + ');

  // Pull requests required on the default branch. An unreadable API makes the
  // check unknown unless the other mechanism positively proves the guarantee.
  if (classicPrs || rulesPrs) {
    checks.push({ what: `pull requests required on ${branch}`, status: 'ok', note: sources });
  } else if (protection.error || rules.error) {
    checks.push({ what: `pull requests required on ${branch}`, status: 'unknown', note: firstLine(protection.error ?? rules.error) });
  } else {
    checks.push({ what: `pull requests required on ${branch}`, status: 'warn', note: `no required reviews found (${sources || 'no protection read'}) — a push could land on ${branch} without a PR` });
  }

  // The CI workflow's checks are required status checks.
  if (protection.error && rules.error) {
    checks.push({ what: `${ciWorkflow} checks required on ${branch}`, status: 'unknown', note: protection.error });
  } else {
    const contexts = [...classicContexts, ...rulesContexts].filter(Boolean);
    const hit = contexts.filter((c) => c === ciWorkflow || c.startsWith(`${ciWorkflow} /`) || c.startsWith(`${ciWorkflow}/`));
    if (hit.length > 0) checks.push({ what: `${ciWorkflow} checks required on ${branch}`, status: 'ok', note: `required: ${hit.join(', ')}` });
    else if (protection.error || rules.error) checks.push({ what: `${ciWorkflow} checks required on ${branch}`, status: 'unknown', note: firstLine(protection.error ?? rules.error) });
    else if (contexts.length > 0) checks.push({ what: `${ciWorkflow} checks required on ${branch}`, status: 'warn', note: `required checks are ${contexts.join(', ')}` });
    else checks.push({ what: `${ciWorkflow} checks required on ${branch}`, status: 'warn', note: `no required status checks on ${branch}` });
  }

  // Merges restricted: classic push restrictions, or a "restrict updates" ruleset.
  if (botListed) {
    checks.push({ what: `merges restricted on ${branch}`, status: 'warn', note: `${botLogin} is in the classic push restrictions — the bot user must not be able to merge` });
  } else if (classicRestricted && !actionsListed) {
    checks.push({ what: `merges restricted on ${branch}`, status: 'warn', note: 'classic push restrictions do not list the github-actions app — the apply job could not merge' });
  } else if (classicRestricted || rulesRestricted) {
    const how = [classicRestricted ? 'classic restrictions' : null, rulesRestricted ? 'a restrict-updates ruleset (its bypass list must hold maintainers and the GitHub Actions app, not the bot)' : null]
      .filter(Boolean)
      .join(' and ');
    checks.push({ what: `merges restricted on ${branch}`, status: 'ok', note: how });
  } else if (protection.error || rules.error) {
    checks.push({ what: `merges restricted on ${branch}`, status: 'unknown', note: firstLine(protection.error ?? rules.error) });
  } else {
    checks.push({ what: `merges restricted on ${branch}`, status: 'warn', note: `pushes are not restricted — anyone with write, the bot included, could merge into ${branch}` });
  }

  // The bot user's permission: write expected, admin/maintain can bypass the gate.
  const perm = read(`repos/${repo}/collaborators/${enc(botLogin)}/permission`, { allow404: true });
  if (perm.error) {
    checks.push({ what: `bot permission for ${botLogin}`, status: 'unknown', note: perm.error });
  } else {
    const level = perm.value?.permission ?? null;
    if (level === 'write') checks.push({ what: `bot permission for ${botLogin}`, status: 'ok', note: 'write' });
    else if (level === 'admin' || level === 'maintain')
      checks.push({ what: `bot permission for ${botLogin}`, status: 'warn', note: `${level}: the bot could bypass the gate — give it exactly write` });
    else
      checks.push({
        what: `bot permission for ${botLogin}`,
        status: 'warn',
        note: level ? `${level}: the bot cannot push agent branches — it needs write` : `not a collaborator — invite it with write so it can push agent branches`,
      });
  }

  // Guidance mergeproof cannot verify itself.
  checks.push({
    what: 'bot token scopes',
    status: 'manual',
    note: 'a fine-grained PAT for the bot user, scoped to this repo only: contents write, pull-requests write, metadata read — and no issues, administration, workflows or actions permission (mergeproof cannot inspect a PAT\u2019s scopes)',
  });
  checks.push({
    what: 'bot push triggers CI',
    status: 'manual',
    note: 'cannot be proven locally: the first agent PR must show the CI workflow running; if it does not, MERGEPROOF_BOT_TOKEN is unset or is a GITHUB_TOKEN',
  });
  checks.push({
    what: 'branch protection guidance',
    status: 'manual',
    note: `init never changes protection: on ${branch}, require a pull request and the ${ciWorkflow} checks, and let only maintainers and the GitHub Actions app merge — the bot user must not be able to. That is why the apply job lands with github.token`,
  });
  return checks;
}

export async function runInit(argv, deps = defaultDeps) {
  const { positionals, flags } = parseFlags(
    argv,
    ['dry-run', 'yes', 'force', 'json'],
    ['agent', 'model', 'base-url', 'bot-login', 'ci-workflow', 'install-command', 'test-command'],
  );
  if (positionals.length > 0) throw new UsageError('init takes no arguments');

  let root;
  try {
    root = deps.git.topLevel(deps.cwd());
  } catch {
    throw new UsageError('init must run inside a git repository');
  }

  const fromFlags = {
    agent: flags.agent,
    model: flags.model,
    baseUrl: flags['base-url'],
    botLogin: flags['bot-login'],
    ciWorkflow: flags['ci-workflow'],
    installCommand: flags['install-command'],
    testCommand: flags['test-command'],
  };
  const overrides = {};
  for (const [k, v] of Object.entries(fromFlags)) if (v !== null) overrides[k] = v;

  const detected = detect(root, { ...deps, overrides: { ...(deps.overrides ?? {}), ...overrides } });
  const dryRun = flags['dry-run'];

  // 2. Local files.
  const files = writeLocal(root, buildLocalFiles(detected), { dryRun, force: flags.force });

  // 3. Remote setup (idempotent; every call through the gh adapter).
  const steps = remoteSteps(detected, deps.env());
  const writable = steps.filter((s) => s.kind !== 'manual-secret');
  let mode;
  let remoteState;
  if (dryRun) {
    mode = 'plan';
    remoteState = 'planned';
  } else if (flags.yes) {
    mode = 'apply';
    remoteState = 'applied';
  } else if (deps.isTTY()) {
    const go = await deps.confirm(`Apply ${writable.length} remote changes to ${detected.repo}? [y/N] `);
    mode = go ? 'apply' : 'skip';
    remoteState = go ? 'applied' : 'skipped';
  } else {
    mode = 'skip';
    remoteState = 'skipped';
  }
  const remote = executeRemote(detected, steps, deps, mode);

  remote.push({
    what: `maintainer: optional variables ${MAINTAINER_VARIABLES.join(', ')}`,
    status: 'manual',
    note: 'init never sets those; they are the maintainer\u2019s (MERGEPROOF_MODE is the kill switch)',
  });

  // The ledger branch is never created here: the PR workflow starts it as an
  // orphan on its first write. Report whether it exists (a read).
  const ledger = { what: `branch ${LEDGER_BRANCH}`, status: 'ok', note: 'created on the first verdict' };
  try {
    if (deps.gh.branchExists({ repo: detected.repo, branch: LEDGER_BRANCH })) ledger.note = 'exists';
  } catch (err) {
    ledger.status = 'unknown';
    ledger.note = firstLine(err.message);
  }
  remote.push(ledger);

  // 4. Verification, read-only, also under --dry-run.
  const checks = verify(detected, deps);

  if (flags.json) {
    deps.print(JSON.stringify({ repo: detected.repo, detected, files, remote, checks }, null, 2));
  } else {
    const render = (entries) => entries.map((e) => `  ${e.status} — ${e.what ?? e.path}${e.note ? ` (${e.note})` : ''}`);
    const all = [...remote, ...checks];
    const warn = all.filter((e) => e.status === 'warn' || e.status === 'unknown');
    const manualCount = all.filter((e) => e.status === 'manual').length;
    const okCount = all.filter((e) => e.status === 'ok' || e.status === 'set').length;
    deps.print(
      [
        `mergeproof init — ${detected.repo} (default branch ${detected.defaultBranch})${dryRun ? ' — dry run' : ''}`,
        ...detected.notes.map((n) => `  note — ${n}`),
        '',
        'local:',
        ...render(files),
        '',
        'remote:',
        ...render(remote),
        '',
        'checks:',
        ...render(checks),
        '',
        // Warnings first in the summary (terse, failures already threw).
        `summary: ${warn.length} warning(s)${warn.length ? ` — ${warn.map((w) => w.what).join('; ')}` : ''}, ${manualCount} manual, ${okCount} ok — remote ${remoteState}${dryRun ? '; nothing was written' : ''}`,
      ].join('\n'),
    );
  }
  return 0;
}
