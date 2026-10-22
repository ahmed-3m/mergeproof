import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseFlags } from '../args.mjs';
import { UsageError } from '../errors.mjs';
import { CONFIG_FILE, parseConfig } from '../config.mjs';
import { proveChange } from '../prove.mjs';
import { decide } from '../decide.mjs';
import { DEFAULT_LEDGER, readLedger, trustFor } from '../ledger.mjs';
import { EXIT_CODES, formatVerdict, makeVerdict } from '../verdict.mjs';
import { notAnAgentPr } from '../agents.mjs';
import { inspect } from '../inspect.mjs';
import { VERDICT_FILE_SCHEMA, writeVerdictFile } from '../verdictfile.mjs';
import { land } from '../land.mjs';
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
  const { kind, files, testFiles, tamperNotes } = inspect({ root, baseSha, headSha, config, claims, issueLabels }, deps);
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

// PROTOTYPE.md flows 1-3, in order:
//   loadConfig → classifyKind → detectTampering → proveChange → decide
//   → (enforce mode) merge with trailer → appendOutcome to the ledger
export async function runCheck(argv, deps = defaultDeps) {
  const { positionals, flags } = parseFlags(argv, ['local', 'dry-run', 'json'], ['base', 'agent', 'model', 'skill', 'attempt', 'issue', 'ledger', 'verdict-out']);
  if (flags.local && positionals.length > 0) {
    throw new UsageError('use either <pr-url> or --local, not both');
  }
  if (flags.local && flags.issue !== null) {
    throw new UsageError('--issue only applies to a pull request, not --local');
  }
  if (flags.local && flags['verdict-out'] !== null) {
    throw new UsageError('--verdict-out only applies to a pull request, not --local');
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

  // --verdict-out runs the gate for a separate apply job (M2): like --dry-run
  // it writes nothing to GitHub or the ledger, and it additionally hands the
  // verdict to that job as a file.
  const readOnly = flags['dry-run'] || flags['verdict-out'] !== null;
  const mode = flags.local
    ? 'local'
    : config.mode === 'enforce' && !readOnly
      ? 'enforce'
      : flags['dry-run']
        ? 'dry-run'
        : flags['verdict-out'] !== null
          ? 'verdict-out'
          : config.mode;
  let merged = false;
  let text = `${formatVerdict(verdict)}\n  (${mode}${verdict.verdict === 'MERGE' ? (merged ? ': merged' : ': not merged') : ''})`;
  if (pr && !readOnly) {
    ({ merged, text } = land(
      {
        prUrl, pr, ledger, ledgerPath, config, verdict,
        kind: result.kind, proven: result.proof?.ok === true,
        agent: input.agent, model: input.model, skill: flags.skill, attempts,
        headSha: pr.headSha, mode,
      },
      { gh: deps.gh, now: deps.now },
    ));
  }
  if (flags['verdict-out'] !== null) {
    writeVerdictFile(resolve(deps.cwd(), flags['verdict-out']), {
      schema: VERDICT_FILE_SCHEMA,
      url: pr.url,
      pr: pr.number,
      headSha: input.headSha,
      kind: result.kind ?? null,
      verdict: verdict.verdict,
      notes: verdict.notes,
      proven: result.proof?.ok === true && !(result.tamperNotes?.length > 0),
      agent: input.agent,
      model: input.model,
      skill: flags.skill ?? null,
      attempts,
      issue,
    });
  }
  deps.print(flags.json ? JSON.stringify({ ...verdict, mode, merged }, null, 2) : text);
  return EXIT_CODES[verdict.verdict];
}
