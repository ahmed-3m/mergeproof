import { resolve } from 'node:path';
import { parseFlags } from '../args.mjs';
import { UsageError } from '../errors.mjs';
import { CONFIG_FILE, parseConfig } from '../config.mjs';
import { notAnAgentPr } from '../agents.mjs';
import { inspect } from '../inspect.mjs';
import { decide } from '../decide.mjs';
import { DEFAULT_LEDGER, readLedger, trustFor } from '../ledger.mjs';
import { EXIT_CODES, formatVerdict, makeVerdict } from '../verdict.mjs';
import { readVerdictFile } from '../verdictfile.mjs';
import { land } from '../land.mjs';
import * as git from '../adapters/git.mjs';
import * as gh from '../adapters/gh.mjs';

export const defaultDeps = { git, gh, now: () => new Date(), cwd: () => process.cwd(), print: (s) => console.log(s) };

// A HUMAN verdict lands as a label so a human finds the PR; RETRY lands
// nothing extra, the workflow counts retries itself.
export const HUMAN_LABEL = 'needs-human';

// The write half of the check/apply split (M2): land a verdict a read-only
// gate job produced with `check --verdict-out`. This command never runs PR
// code, so it cannot re-prove the change — the file is trusted for that one
// fact only. Everything else (identity, flags, kind, tamper rules, trust, CI)
// is re-derived here, because the file is written in the job that ran PR code
// and every field in it is attacker-controlled.
export async function runApply(argv, deps = defaultDeps) {
  const { positionals, flags } = parseFlags(argv, ['dry-run', 'json'], ['pr', 'ledger', 'agent', 'model', 'skill', 'attempt', 'issue', 'head']);
  if (positionals.length !== 1) throw new UsageError('expected exactly one <verdict-file>');
  // The PR comes from the workflow (the event that triggered it), never from the
  // file: a file naming another PR would borrow this PR's proof for that one.
  const prUrl = flags.pr;
  if (!prUrl || !gh.parsePrUrl(prUrl)) throw new UsageError('apply requires --pr <pr-url> (the pull request the gate job checked)');
  if (flags.head !== null && !/^[0-9a-f]{40}$/.test(flags.head)) throw new UsageError('--head must be a 40-character commit sha');
  const agent = flags.agent;
  const model = flags.model;
  if (!agent || !model) throw new UsageError('apply requires --agent and --model (the same values the gate job got)');
  const attempts = flags.attempt === null ? 1 : Number(flags.attempt);
  if (!Number.isInteger(attempts) || attempts < 1) throw new UsageError('--attempt must be a positive integer');
  const issue = flags.issue === null ? null : Number(flags.issue);
  if (issue !== null && (!Number.isInteger(issue) || issue < 1)) throw new UsageError('--issue must be an issue number');
  const skill = flags.skill;

  const verdict = readVerdictFile(positionals[0]);
  const dryRun = flags['dry-run'];

  // Suspicious: the file disagrees with something apply can check. Nothing is
  // merged or logged, but the PR is commented and labeled needs-human, because
  // a PR whose gate output was tampered with needs a human. Notes posted here
  // are apply's own (re-derived), never text from the file.
  const suspect = (text, extraNotes = []) => {
    const refused = makeVerdict('HUMAN', { notes: [{ ok: false, text }, ...extraNotes] });
    const line = `${formatVerdict(refused)}\n  (gate output did not survive the re-check; nothing merged or logged)`;
    if (!dryRun) {
      deps.gh.comment(prUrl, `\`\`\`\n${line}\n\`\`\``);
      deps.gh.addLabel(prUrl, HUMAN_LABEL);
    }
    deps.print(flags.json ? JSON.stringify({ ...refused, mode: 'refused', merged: false }, null, 2) : line);
    return EXIT_CODES.HUMAN;
  };

  // The workflow passes the same trust-bucket flags to both jobs; a file that
  // carries different ones was not written by this workflow's gate.
  if (verdict.url !== prUrl) return suspect('verdict file is for a different pull request');
  const fromFlags = { agent, model, skill, attempts, issue };
  const fromFile = { agent: verdict.agent, model: verdict.model, skill: verdict.skill, attempts: verdict.attempts, issue: verdict.issue };
  if (Object.keys(fromFlags).some((k) => fromFile[k] !== fromFlags[k])) {
    return suspect("verdict file does not match the workflow's flags");
  }
  // The workflow pins the head its event's CI completed and passes the same
  // --head to both jobs; a file naming a different head was not written by
  // this workflow's gate.
  if (flags.head !== null && flags.head !== verdict.headSha) {
    return suspect("verdict file does not match the workflow's flags");
  }

  const root = deps.git.topLevel(deps.cwd());
  const ledgerPath = resolve(root, flags.ledger ?? DEFAULT_LEDGER);

  // Re-read the PR and the gate config from today's base branch tip (fetched
  // like runCheck does, PR head included, so the diff can be re-derived).
  const pr = deps.gh.getPullRequest(prUrl);

  // Benign refusals: the world changed, not the file. Print only, write nothing.
  const refuse = (text) => {
    const refused = makeVerdict('HUMAN', { kind: verdict.kind, notes: [{ ok: false, text }] });
    deps.print(
      flags.json
        ? JSON.stringify({ ...refused, mode: 'refused', merged: false }, null, 2)
        : `${formatVerdict(refused)}\n  (nothing written)`,
    );
    return EXIT_CODES.HUMAN;
  };

  if (pr.state !== 'OPEN') return refuse(`PR is ${pr.state}, not open`);
  if (pr.headSha !== verdict.headSha) return refuse('PR changed after the gate ran');

  deps.git.fetch(root, [`+refs/heads/${pr.baseRef}:refs/mergeproof/base`, `+refs/pull/${pr.number}/head:refs/mergeproof/head`]);
  if (deps.git.revParse(root, 'refs/mergeproof/head') !== verdict.headSha) return refuse('PR changed after the gate ran');
  // The fetched base tip, the same single snapshot check gated against — never
  // the API's base SHA, which can lag the fetch.
  const baseTip = deps.git.revParse(root, 'refs/mergeproof/base');
  const config = parseConfig(deps.git.showFile(root, baseTip, CONFIG_FILE), `${CONFIG_FILE} (base ${baseTip.slice(0, 7)})`);

  const notAgent = notAnAgentPr(pr, config);
  if (notAgent) return refuse(notAgent);
  if (config.mode === 'off') return refuse('mergeproof is off for this repo');

  // Re-derive kind and the path tamper rules with git only (the same inspect()
  // the gate uses, so the two cannot drift).
  const baseSha = deps.git.mergeBase(root, baseTip, verdict.headSha);
  const claims = { title: pr.title, labels: pr.labels, subjects: pr.subjects };
  const issueLabels = issue ? deps.gh.issueLabels(prUrl, [issue]) : [];
  const { kind, tamperNotes } = inspect({ root, baseSha, headSha: verdict.headSha, config, claims, issueLabels }, deps);

  // A tamper note forces HUMAN with no proof, in the gate as here. A file that
  // says so agrees and lands normally (comment + label, nothing logged); one
  // that says anything else hid the tampering.
  if (tamperNotes.length > 0 && (verdict.verdict !== 'HUMAN' || verdict.proven)) {
    return suspect('verdict file disagrees with the re-check', tamperNotes);
  }
  if (kind !== verdict.kind) {
    return suspect(`verdict file disagrees with the re-check (file says ${verdict.kind ?? 'no kind'}, paths say ${kind ?? 'no kind'})`);
  }

  // The file's proof outcome is the one thing apply takes from it. It must be
  // internally consistent: MERGE requires a proof that held, RETRY means the
  // proof did not hold but was fixable.
  if (!verdict.proven && verdict.verdict === 'MERGE') return suspect('verdict file disagrees with the re-check (MERGE with proven false)');
  if (verdict.proven && verdict.verdict === 'RETRY') return suspect('verdict file disagrees with the re-check (RETRY with proven true)');

  let proof;
  if (!verdict.proven) {
    proof =
      verdict.verdict === 'RETRY'
        ? { ok: false, weak: true, notes: [{ ok: false, text: 'proof was weak when the gate ran' }] }
        : { ok: false, weak: false, notes: [{ ok: false, text: 'proof did not hold when the gate ran' }] };
  } else {
    // The proof held; CI is the one part of it apply can re-check, so a MERGE
    // whose CI is no longer green is landed as RETRY, like check would.
    const ci = deps.gh.getChecksStatus(prUrl);
    if (ci === 'red') proof = { ok: false, weak: true, notes: [{ ok: false, text: 'CI is red' }] };
    else if (ci === 'pending') proof = { ok: false, weak: true, notes: [{ ok: false, text: 'CI has not finished' }] };
    else proof = { ok: true, weak: false, notes: [] };
  }

  // Trust comes from this job's own ledger, under the workflow's flags.
  const ledger = readLedger(ledgerPath);
  const trust = kind ? trustFor(ledger, { kind, agent, model }, config.trust) : null;
  const rederived = decide({ kind, tamperNotes, proof, trust });

  // apply may only lower a verdict (MERGE → RETRY on a CI that went red),
  // never raise one: any other disagreement means the file was tampered with.
  // A gate HUMAN that re-checks as MERGE (trust grew between the jobs) lands
  // the lower verdict; that is not tampering.
  const lowered = verdict.verdict === 'MERGE' && rederived.verdict === 'RETRY';
  let final = rederived;
  if (verdict.verdict === 'HUMAN' && rederived.verdict === 'MERGE') {
    final = makeVerdict('HUMAN', { kind, notes: [{ ok: false, text: 'the gate said HUMAN; landing the lower verdict' }] });
  } else if (rederived.verdict !== verdict.verdict && !lowered) {
    return suspect(`verdict file disagrees with the re-check (re-check says ${rederived.verdict})`, rederived.notes);
  }

  if (dryRun) {
    const wouldRecord = proof.ok && kind && kind !== 'deps';
    const wouldMerge = wouldRecord && final.verdict === 'MERGE' && config.mode === 'enforce';
    const plan = [
      ...(wouldRecord ? ['record the outcome'] : []),
      ...(wouldMerge ? ['merge'] : []),
      'comment',
      ...(final.verdict === 'HUMAN' ? [`label ${HUMAN_LABEL}`] : []),
    ].join(', ');
    deps.print(
      flags.json
        ? JSON.stringify({ ...final, mode: 'dry-run', merged: false }, null, 2)
        : `${formatVerdict(final)}\n  (dry-run: would ${plan})`,
    );
    return EXIT_CODES[final.verdict];
  }

  const { merged, text } = land(
    {
      prUrl, pr, ledger, ledgerPath, config, verdict: final,
      kind, proven: proof.ok, agent, model, skill, attempts,
      headSha: verdict.headSha, mode: config.mode,
    },
    { gh: deps.gh, now: deps.now },
  );
  if (final.verdict === 'HUMAN') deps.gh.addLabel(prUrl, HUMAN_LABEL);
  deps.print(flags.json ? JSON.stringify({ ...final, mode: config.mode, merged }, null, 2) : text);
  return EXIT_CODES[final.verdict];
}
