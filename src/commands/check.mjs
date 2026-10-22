import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseFlags } from '../args.mjs';
import { UsageError } from '../errors.mjs';
import { CONFIG_FILE, parseConfig } from '../config.mjs';
import { classifyKind } from '../classify.mjs';
import { detectTampering, SAFE_PATH } from '../tamper.mjs';
import { proveChange } from '../prove.mjs';
import { decide } from '../decide.mjs';
import { DEFAULT_LEDGER, appendOutcome, readLedger, trustFor, writeLedger } from '../ledger.mjs';
import { formatTrailer } from '../trailer.mjs';
import { EXIT_CODES, formatVerdict, makeVerdict } from '../verdict.mjs';
import { matchesAny } from '../glob.mjs';
import * as git from '../adapters/git.mjs';
import * as gh from '../adapters/gh.mjs';
import { runTests } from '../adapters/runner.mjs';

export const defaultDeps = { git, gh, runTests, now: () => new Date(), cwd: () => process.cwd(), print: (s) => console.log(s) };

// Worktrees are shared node_modules with the checkout: classification sends any
// manifest change to `deps`, which is never tested, so base and head always have
// the same dependencies when tests run.
function linkNodeModules(root, dir) {
  const src = join(root, 'node_modules');
  if (existsSync(src) && !existsSync(join(dir, 'node_modules'))) symlinkSync(src, join(dir, 'node_modules'), 'junction');
}

// PR test code runs in worktrees that share the checkout's .git directory. It
// could plant a hook, an fsmonitor or a filter driver in the shared git config,
// or rewrite the ledger, and the gate's next git call or write would act on it.
// These paths are fingerprinted before and after the proof runs; any change
// is tampering, and git is not called again.
function guardedPaths(commonDir, ledgerPath) {
  const paths = ['config', 'config.worktree', 'hooks', 'info'].map((p) => join(commonDir, p));
  return ledgerPath ? [...paths, ledgerPath] : paths;
}

function fingerprint(paths) {
  const h = createHash('sha256');
  const add = (p) => {
    h.update(`\0${p}\0`);
    if (!existsSync(p)) return void h.update('-');
    const st = statSync(p);
    if (!st.isDirectory()) return void h.update(readFileSync(p));
    for (const name of readdirSync(p).sort()) add(join(p, name));
  };
  paths.forEach(add);
  return h.digest('hex');
}

/**
 * The gate itself, PROTOTYPE.md flows 1-3:
 *   classifyKind → detectTampering → proveChange → decide.
 * Reads nothing from the PR's own config: `config` comes from the base branch.
 */
export function evaluate({ root, baseSha, headSha, config, claims, ci, issueLabels = [], agent, model, ledger, ledgerPath = null }, deps = defaultDeps) {
  const files = deps.git.changedFiles(root, baseSha, headSha);
  const kind = classifyKind(files.map((f) => f.path), config, { issueLabels });
  const testFiles = files
    .filter((f) => f.status !== 'D' && matchesAny(f.path, config.paths.tests) && SAFE_PATH.test(f.path))
    .map((f) => f.path);
  const addedLines = deps.git.addedLines(root, baseSha, headSha, testFiles);
  const tamperNotes = detectTampering({ kind, files, addedLines, claims, config });
  if (tamperNotes.length > 0) return { kind, files, tamperNotes, proof: null, verdict: decide({ kind, tamperNotes }) };

  const newTests = files.filter((f) => f.status === 'A' && testFiles.includes(f.path)).map((f) => f.path);
  const trees = {};
  const tree = (which) => {
    if (!trees[which]) {
      const dir = deps.git.addWorktree(root, which === 'base' ? baseSha : headSha);
      trees[which] = dir;
      if (which === 'base') deps.git.checkoutFiles(dir, headSha, newTests);
      linkNodeModules(root, dir);
    }
    return trees[which];
  };
  const runner = (which) => (only) =>
    deps.runTests(tree(which), {
      testCommand: config.testCommand,
      testFileCommand: config.testFileCommand,
      only,
      timeoutSec: config.limits.testTimeoutSec,
    });
  const guarded = guardedPaths(deps.git.commonDir(root), ledgerPath);
  const before = fingerprint(guarded);
  let proof;
  let tampered = false;
  try {
    proof = proveChange(kind, { files, config, ci, runBase: runner('base'), runHead: runner('head') });
  } finally {
    tampered = fingerprint(guarded) !== before;
    for (const dir of Object.values(trees)) {
      if (tampered) rmSync(dir, { recursive: true, force: true });
      else deps.git.removeWorktree(root, dir);
    }
  }
  if (tampered) {
    const note = { ok: false, rule: 'testRunTamperedRepo', text: 'test run changed the git config, hooks or ledger' };
    return { kind, files, tamperNotes: [note], proof: null, tampered, verdict: decide({ kind, tamperNotes: [note] }) };
  }
  // Tampering found during the proof (a dropped test count), not a failed
  // proof: HUMAN with no retry. proof.ok is false, so the PR is never recorded.
  if (proof.tamperNotes?.length > 0) {
    return { kind, files, tamperNotes: proof.tamperNotes, proof, verdict: decide({ kind, tamperNotes: proof.tamperNotes }) };
  }
  const trust = kind ? trustFor(ledger, { kind, agent, model }, config.trust) : null;
  return { kind, files, tamperNotes, proof, trust, verdict: decide({ kind, tamperNotes, proof, trust }) };
}

// Identity is the author login; anyone can name a branch `agent/...`, and a fork
// can claim any branch name. The branch prefix only narrows a trusted login.
function notAnAgentPr(pr, config) {
  if (pr.isFork) return 'PR comes from a fork';
  if (!config.agents.logins.includes(pr.author)) return `not an agent PR (author ${pr.author} is not in agents.logins)`;
  const prefixes = config.agents.branchPrefixes;
  if (prefixes.length > 0 && !prefixes.some((p) => pr.headRef?.startsWith(p))) {
    return `agent branch ${pr.headRef} does not start with ${prefixes.join(' or ')}`;
  }
  return null;
}

// PROTOTYPE.md flows 1-3, in order:
//   loadConfig → classifyKind → detectTampering → proveChange → decide
//   → (enforce mode) merge with trailer → appendOutcome to the ledger
export async function runCheck(argv, deps = defaultDeps) {
  const { positionals, flags } = parseFlags(argv, ['local', 'dry-run', 'json'], ['base', 'agent', 'model', 'skill', 'attempt', 'issue', 'ledger']);
  if (flags.local && positionals.length > 0) {
    throw new UsageError('use either <pr-url> or --local, not both');
  }
  if (flags.local && flags.issue !== null) {
    throw new UsageError('--issue only applies to a pull request, not --local');
  }
  if (!flags.local && positionals.length !== 1) {
    throw new UsageError('expected exactly one <pr-url>, or --local');
  }
  const attempts = flags.attempt === null ? 1 : Number(flags.attempt);
  if (!Number.isInteger(attempts) || attempts < 1) throw new UsageError('--attempt must be a positive integer');
  const issue = flags.issue === null ? null : Number(flags.issue);
  if (issue !== null && (!Number.isInteger(issue) || issue < 1)) throw new UsageError('--issue must be an issue number');
  const prUrl = flags.local ? null : positionals[0];
  if (prUrl && !gh.parsePrUrl(prUrl)) throw new UsageError(`not a pull request URL: ${prUrl}`);

  const root = deps.git.topLevel(deps.cwd());
  const ledgerPath = resolve(root, flags.ledger ?? DEFAULT_LEDGER);
  let input;
  let pr = null;
  if (prUrl) {
    pr = deps.gh.getPullRequest(prUrl);
    deps.git.fetch(root, [`+refs/heads/${pr.baseRef}:refs/mergeproof/base`, `+refs/pull/${pr.number}/head:refs/mergeproof/head`]);
    input = {
      baseSha: deps.git.mergeBase(root, pr.baseSha, pr.headSha),
      configSha: pr.baseSha,
      headSha: pr.headSha,
      claims: { title: pr.title, labels: pr.labels, subjects: pr.subjects },
      ci: gh.checksState(pr.checks),
      // Only the issue the workflow dispatched the agent for; "closes #N" in the PR is agent-written.
      issueLabels: issue ? deps.gh.issueLabels(prUrl, [issue]) : [],
      agent: flags.agent ?? pr.author,
    };
  } else {
    const headSha = deps.git.revParse(root, 'HEAD');
    const configSha = deps.git.revParse(root, flags.base ?? deps.git.defaultBranch(root));
    const baseSha = deps.git.mergeBase(root, configSha, headSha);
    input = { baseSha, configSha, headSha, claims: { subjects: deps.git.commitSubjects(root, baseSha, headSha) }, ci: null, issueLabels: [] };
    input.agent = flags.agent ?? process.env.MERGEPROOF_AGENT ?? 'local';
  }
  input.model = flags.model ?? process.env.MERGEPROOF_MODEL ?? 'unknown';
  // The gate config is today's base branch tip, never the PR and never an old
  // merge-base the PR happened to branch from.
  const config = parseConfig(deps.git.showFile(root, input.configSha, CONFIG_FILE), `${CONFIG_FILE} (base ${input.configSha.slice(0, 7)})`);

  // Read once, before any PR code runs; the outcome is appended to this copy.
  const ledger = readLedger(ledgerPath);
  const notAgent = pr ? notAnAgentPr(pr, config) : null;
  let result;
  if (config.mode === 'off') {
    result = { verdict: makeVerdict('HUMAN', { notes: [{ ok: false, text: 'mergeproof is off for this repo' }] }) };
  } else if (notAgent) {
    result = { verdict: makeVerdict('HUMAN', { notes: [{ ok: false, text: notAgent }] }) };
  } else {
    result = evaluate({ root, ...input, config, ledger, ledgerPath }, deps);
  }
  const { verdict } = result;

  // Record and merge only for real PR runs. A proven PR is logged even when a
  // human must merge it, so trust can grow from human merges (shadow mode, cold start).
  let merged = false;
  if (pr && !flags['dry-run'] && result.proof?.ok && result.kind && result.kind !== 'deps') {
    const outcome = {
      pr: pr.number, url: pr.url, kind: result.kind, agent: input.agent, model: input.model,
      skill: flags.skill ?? null, attempts, verdict: verdict.verdict,
      provenAt: deps.now().toISOString(), mergedAt: null, mergeCommit: null, status: 'open',
    };
    appendOutcome(ledger, outcome); // fail before merging if the outcome can't be logged
    if (verdict.verdict === 'MERGE' && config.mode === 'enforce') {
      const trailer = formatTrailer({ pr: pr.number, kind: result.kind, agent: input.agent, model: input.model, skill: flags.skill, attempts });
      deps.gh.squashMerge(prUrl, { body: trailer, headSha: pr.headSha });
      const after = deps.gh.getPullRequest(prUrl);
      Object.assign(outcome, { status: 'pending', mergedAt: after.mergedAt ?? deps.now().toISOString(), mergeCommit: after.mergeCommit });
      merged = true;
    }
    writeLedger(ledgerPath, appendOutcome(ledger, outcome));
  }

  const mode = config.mode === 'enforce' && !flags['dry-run'] && !flags.local ? 'enforce' : flags.local ? 'local' : flags['dry-run'] ? 'dry-run' : config.mode;
  const text = `${formatVerdict(verdict)}\n  (${mode}${verdict.verdict === 'MERGE' ? (merged ? ': merged' : ': not merged') : ''})`;
  if (pr && !flags['dry-run']) deps.gh.comment(prUrl, `\`\`\`\n${text}\n\`\`\``);
  deps.print(flags.json ? JSON.stringify({ ...verdict, mode, merged }, null, 2) : text);
  return EXIT_CODES[verdict.verdict];
}
