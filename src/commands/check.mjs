import { existsSync, symlinkSync } from 'node:fs';
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

/**
 * The gate itself, PROTOTYPE.md flows 1-3:
 *   classifyKind → detectTampering → proveChange → decide.
 * Reads nothing from the PR's own config: `config` comes from the base commit.
 */
export function evaluate({ root, baseSha, headSha, config, claims, ci, issueLabels = [], agent, model, ledger }, deps = defaultDeps) {
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
  let proof;
  try {
    proof = proveChange(kind, { files, config, ci, runBase: runner('base'), runHead: runner('head') });
  } finally {
    for (const dir of Object.values(trees)) deps.git.removeWorktree(root, dir);
  }
  const trust = kind ? trustFor(ledger, { kind, agent, model }, config.trust) : null;
  return { kind, files, tamperNotes, proof, trust, verdict: decide({ kind, tamperNotes, proof, trust }) };
}

function isAgentPr(pr, config) {
  return config.agents.logins.includes(pr.author) || config.agents.branchPrefixes.some((p) => pr.headRef?.startsWith(p));
}

// PROTOTYPE.md flows 1-3, in order:
//   loadConfig → classifyKind → detectTampering → proveChange → decide
//   → (enforce mode) merge with trailer → appendOutcome to the ledger
export async function runCheck(argv, deps = defaultDeps) {
  const { positionals, flags } = parseFlags(argv, ['local', 'dry-run', 'json'], ['base', 'agent', 'model', 'skill', 'attempt', 'ledger']);
  if (flags.local && positionals.length > 0) {
    throw new UsageError('use either <pr-url> or --local, not both');
  }
  if (!flags.local && positionals.length !== 1) {
    throw new UsageError('expected exactly one <pr-url>, or --local');
  }
  const attempts = flags.attempt === null ? 1 : Number(flags.attempt);
  if (!Number.isInteger(attempts) || attempts < 1) throw new UsageError('--attempt must be a positive integer');
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
      headSha: pr.headSha,
      claims: { title: pr.title, labels: pr.labels, subjects: pr.subjects },
      ci: gh.checksState(pr.checks),
      issueLabels: pr.linkedIssues.length ? deps.gh.issueLabels(prUrl, pr.linkedIssues) : [],
      agent: flags.agent ?? pr.author,
    };
  } else {
    const headSha = deps.git.revParse(root, 'HEAD');
    const base = flags.base ?? deps.git.defaultBranch(root);
    const baseSha = deps.git.mergeBase(root, deps.git.revParse(root, base), headSha);
    input = { baseSha, headSha, claims: { subjects: deps.git.commitSubjects(root, baseSha, headSha) }, ci: null, issueLabels: [] };
    input.agent = flags.agent ?? process.env.MERGEPROOF_AGENT ?? 'local';
  }
  input.model = flags.model ?? process.env.MERGEPROOF_MODEL ?? 'unknown';
  const config = parseConfig(deps.git.showFile(root, input.baseSha, CONFIG_FILE), `${CONFIG_FILE} (base ${input.baseSha.slice(0, 7)})`);

  let result;
  if (config.mode === 'off') {
    result = { verdict: makeVerdict('HUMAN', { notes: [{ ok: false, text: 'mergeproof is off for this repo' }] }) };
  } else if (pr && !isAgentPr(pr, config)) {
    result = { verdict: makeVerdict('HUMAN', { notes: [{ ok: false, text: `not an agent PR (author ${pr.author}, branch ${pr.headRef})` }] }) };
  } else {
    result = evaluate({ root, ...input, config, ledger: readLedger(ledgerPath) }, deps);
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
    const before = readLedger(ledgerPath);
    appendOutcome(before, outcome); // fail before merging if the outcome can't be logged
    if (verdict.verdict === 'MERGE' && config.mode === 'enforce') {
      const trailer = formatTrailer({ pr: pr.number, kind: result.kind, agent: input.agent, model: input.model, skill: flags.skill, attempts });
      deps.gh.squashMerge(prUrl, { body: trailer, headSha: pr.headSha });
      const after = deps.gh.getPullRequest(prUrl);
      Object.assign(outcome, { status: 'pending', mergedAt: after.mergedAt ?? deps.now().toISOString(), mergeCommit: after.mergeCommit });
      merged = true;
    }
    writeLedger(ledgerPath, appendOutcome(before, outcome));
  }

  const mode = config.mode === 'enforce' && !flags['dry-run'] && !flags.local ? 'enforce' : flags.local ? 'local' : flags['dry-run'] ? 'dry-run' : config.mode;
  const text = `${formatVerdict(verdict)}\n  (${mode}${verdict.verdict === 'MERGE' ? (merged ? ': merged' : ': not merged') : ''})`;
  if (pr && !flags['dry-run']) deps.gh.comment(prUrl, `\`\`\`\n${text}\n\`\`\``);
  deps.print(flags.json ? JSON.stringify({ ...verdict, mode, merged }, null, 2) : text);
  return EXIT_CODES[verdict.verdict];
}
