import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { FileFormatError } from './errors.mjs';

export const CONFIG_FILE = '.mergeproof.json';

export const MODES = Object.freeze(['shadow', 'enforce', 'off']);

// Defaults for every key a repo's config may omit. `mergeproof init` (M2)
// writes these out with paths detected from the repo; the gate never guesses
// beyond what the config says.
export function defaultConfig() {
  return {
    mode: 'shadow',
    testCommand: 'npm test', // full suite; split on whitespace, no shell quoting
    testFileCommand: 'node --test', // runs one test file, appended as the last argument
    paths: {
      tests: ['test/**', 'tests/**', '**/*.test.*', '**/*.spec.*'],
      // Files under a tests glob that are not tests themselves: never proven on their own.
      testSupport: ['**/fixtures/**', '**/__fixtures__/**', '**/__snapshots__/**', '**/__mocks__/**', '**/helpers/**', '**/*.snap', '**/*.json'],
      docs: ['docs/**', '**/*.md'],
      manifests: ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'],
      // Instructions coding agents read on every run: an edit steers every later agent PR, so it is never docs.
      agentInstructions: ['AGENTS.md', 'AGENT.md', 'CLAUDE.md', 'CLAUDE.local.md', 'GEMINI.md', 'CONVENTIONS.md', '.cursorrules', '.windsurfrules', '.clinerules', '.roorules', '**/.clinerules/**', '**/.cursor/**', '**/.windsurf/**', '**/.claude/**', '**/.gemini/**', '**/.codex/**', '**/.agents/**', '**/.roo/**', '**/.junie/**', '**/.kiro/**', '.aider*', '.github/copilot-instructions.md'],
    },
    issueLabels: { bugfix: ['bug'] }, // maintainer labels on the linked issue that mark a bugfix
    limits: { maxDiffLines: 300, testTimeoutSec: 600, ciWaitSec: 600 }, // ciWaitSec: how long the gate waits for pending CI
    proof: { baseFailRuns: 2, headPassRuns: 3, headReruns: 1 },
    trust: { minOutcomes: 10, minCleanRate: 0.9, revertWindowDays: 14 },
    agents: { logins: [], branchPrefixes: ['agent/'], identities: {} },
    quarantine: [], // flaky test files excluded from proof runs
  };
}

// Numeric keys and their allowed range: [min, max, integer].
const RANGES = {
  'limits.maxDiffLines': [1, Infinity, true],
  'limits.testTimeoutSec': [1, 86400, true],
  'limits.ciWaitSec': [0, 3600, true],
  'proof.baseFailRuns': [1, 10, true],
  'proof.headPassRuns': [1, 10, true],
  'proof.headReruns': [0, 5, true],
  'trust.minOutcomes': [1, 1000, true],
  'trust.minCleanRate': [0, 1, false],
  'trust.revertWindowDays': [1, 365, true],
};

function typeOf(v) {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  return typeof v;
}

// A login → trust-bucket part (an `agent` or `model` name): machine-shaped and
// bounded, because these strings flow into verdict files, comments and the
// ledger, and a login with an identity is exactly as privileged as the flags.
const IDENT_PART = /^[A-Za-z0-9._@/+-]{1,100}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;

/**
 * `agents.identities` maps an agent login to its own trust bucket. The keys
 * are GitHub logins, so they are dynamic and the generic `merge` cannot walk
 * them (it would reject every login as an unknown key); the value shape is
 * fixed: exactly `agent` and `model`. Membership in `agents.logins` is checked
 * after the merge in parseConfig, because the logins list may come from the
 * same file.
 */
function validateIdentities(value, path, fail) {
  if (typeOf(value) !== 'object') fail(`"${path}" must be an object, got ${typeOf(value)}`);
  const out = {};
  for (const [login, identity] of Object.entries(value)) {
    const at = `${path}.${login}`;
    // A GitHub login shape; also keeps "__proto__" and friends out of the map.
    if (!LOGIN.test(login)) fail(`"${at}" is not a GitHub login`);
    if (typeOf(identity) !== 'object') fail(`"${at}" must be an object with exactly "agent" and "model", got ${typeOf(identity)}`);
    const keys = Object.keys(identity).sort();
    if (keys.length !== 2 || keys[0] !== 'agent' || keys[1] !== 'model') {
      fail(`"${at}" must be an object with exactly "agent" and "model", got ${keys.join(', ') || 'none'}`);
    }
    for (const part of ['agent', 'model']) {
      if (typeof identity[part] !== 'string' || !IDENT_PART.test(identity[part])) {
        fail(`"${at}.${part}" must be 1-100 characters of A-Za-z0-9._@/+-`);
      }
    }
    out[login] = { agent: identity.agent, model: identity.model };
  }
  return out;
}

// Config keys whose values are maps (dynamic keys, fixed value shape) the
// generic merge cannot validate; each gets its own validator instead.
const MAPS = { 'agents.identities': validateIdentities };

// Deep-merge `user` over `defaults`, rejecting keys and types the defaults don't
// have, so a typo fails loudly instead of silently keeping a default.
function merge(defaults, user, prefix, fail) {
  if (typeOf(user) !== 'object') fail(`${prefix ? `"${prefix}"` : 'config'} must be an object`);
  const out = { ...defaults };
  for (const [key, value] of Object.entries(user)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!Object.hasOwn(defaults, key)) fail(`unknown key "${path}"`);
    if (MAPS[path]) {
      out[key] = MAPS[path](value, path, fail);
      continue;
    }
    const want = typeOf(defaults[key]);
    if (want === 'object') {
      out[key] = merge(defaults[key], value, path, fail);
      continue;
    }
    const got = typeOf(value);
    if (got !== want) fail(`"${path}" must be ${want === 'array' ? 'an array' : `a ${want}`}, got ${got}`);
    if (want === 'array' && !value.every((v) => typeof v === 'string' && v.length > 0)) {
      fail(`"${path}" must contain only non-empty strings`);
    }
    if (want === 'number') {
      const [min, max, integer] = RANGES[path];
      if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
        fail(`"${path}" must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}`);
      }
    }
    out[key] = value;
  }
  return out;
}

/** Parse config text (null means no file) and merge it over defaultConfig(). */
export function parseConfig(text, source = CONFIG_FILE) {
  const fail = (msg) => {
    throw new FileFormatError(source, msg);
  };
  if (text === null || text === undefined) return defaultConfig();
  let user;
  try {
    user = JSON.parse(text);
  } catch (err) {
    fail(`not valid JSON (${err.message})`);
  }
  const cfg = merge(defaultConfig(), user, '', fail);
  if (!MODES.includes(cfg.mode)) fail(`"mode" must be one of ${MODES.join(', ')}`);
  for (const key of ['testCommand', 'testFileCommand']) {
    if (!cfg[key].trim()) fail(`"${key}" must not be empty`);
  }
  // An identity without its login in agents.logins can never gate a PR
  // (notAnAgentPr refuses the author), so it is a config typo: fail loudly.
  for (const login of Object.keys(cfg.agents.identities)) {
    if (!cfg.agents.logins.includes(login)) fail(`"agents.identities.${login}" is not listed in "agents.logins"`);
  }
  return cfg;
}

/** Read CONFIG_FILE from repoRoot and merge it over defaultConfig(). A missing file means all defaults. */
export function loadConfig(repoRoot) {
  const file = join(repoRoot, CONFIG_FILE);
  return parseConfig(existsSync(file) ? readFileSync(file, 'utf8') : null, file);
}
