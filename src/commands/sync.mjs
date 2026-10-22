import { resolve } from 'node:path';
import { parseFlags } from '../args.mjs';
import { UsageError } from '../errors.mjs';
import { CONFIG_FILE, parseConfig } from '../config.mjs';
import { DEFAULT_LEDGER, readLedger, writeLedger } from '../ledger.mjs';
import * as git from '../adapters/git.mjs';
import * as gh from '../adapters/gh.mjs';

export const defaultDeps = { git, gh, now: () => new Date(), cwd: () => process.cwd(), print: (s) => console.log(s) };

const DAY = 24 * 60 * 60 * 1000;

/** { mergeCommitSha: revertCommit } for every `git revert` in the history. */
export function findReverts(commits) {
  const reverts = new Map();
  for (const c of commits) {
    for (const m of c.message.matchAll(/This reverts commit ([0-9a-f]{7,40})/g)) {
      if (!reverts.has(m[1])) reverts.set(m[1], c);
    }
  }
  return reverts;
}

function revertOf(reverts, sha) {
  for (const [target, commit] of reverts) if (sha.startsWith(target)) return commit;
  return null;
}

/**
 * Settle the ledger (PROTOTYPE.md flow 3, learning half). Returns the new ledger
 * and the outcomes that were newly reverted. Pure apart from `prState`.
 *   open     → pending once the PR is merged, closed if it was closed unmerged
 *   pending  → reverted if a revert of its merge commit landed inside the window
 *   pending  → clean once the window has passed with no revert
 */
export function settle(ledger, { commits, prState, now, windowDays }) {
  const reverts = findReverts(commits);
  const newlyReverted = [];
  const outcomes = ledger.outcomes.map((o) => {
    let next = o;
    if (next.status === 'open' && next.url) {
      const st = prState(next.url);
      if (st.state === 'MERGED') next = { ...next, status: 'pending', mergedAt: st.mergedAt, mergeCommit: st.mergeCommit };
      else if (st.state === 'CLOSED') next = { ...next, status: 'closed' };
    }
    if (next.status === 'pending') {
      const mergedAt = Date.parse(next.mergedAt);
      const revert = next.mergeCommit ? revertOf(reverts, next.mergeCommit) : null;
      if (revert && Date.parse(revert.date) - mergedAt <= windowDays * DAY) {
        next = { ...next, status: 'reverted', revertCommit: revert.sha };
        newlyReverted.push(next);
      } else if (now.getTime() - mergedAt > windowDays * DAY) {
        next = { ...next, status: 'clean' };
      }
    }
    return next;
  });
  return { ledger: { ...ledger, outcomes }, newlyReverted };
}

// Find reverts of gated merges, mark those outcomes reverted, and open a
// human-triage regression issue (never labeled for the agent). Run it on the
// default branch after a fetch, e.g. in a nightly workflow (M2).
export async function runSync(argv, deps = defaultDeps) {
  const { positionals, flags } = parseFlags(argv, ['json', 'dry-run'], ['ledger', 'ref']);
  if (positionals.length > 0) throw new UsageError('sync takes no arguments');
  const root = deps.git.topLevel(deps.cwd());
  const ledgerPath = resolve(root, flags.ledger ?? DEFAULT_LEDGER);
  const ref = flags.ref ?? 'HEAD';
  const config = parseConfig(deps.git.showFile(root, deps.git.revParse(root, ref), CONFIG_FILE), `${CONFIG_FILE} (${ref})`);
  const before = readLedger(ledgerPath);
  const prState = (url) => {
    const pr = deps.gh.getPullRequest(url);
    return { state: pr.state, mergedAt: pr.mergedAt, mergeCommit: pr.mergeCommit };
  };
  const { ledger, newlyReverted } = settle(before, {
    commits: deps.git.log(root, ref),
    prState,
    now: deps.now(),
    windowDays: config.trust.revertWindowDays,
  });

  const issues = [];
  if (!flags['dry-run']) {
    writeLedger(ledgerPath, ledger);
    for (const o of newlyReverted) {
      const repo = gh.parsePrUrl(o.url ?? '')?.repo;
      if (!repo) continue;
      issues.push(
        deps.gh.createIssue({
          repo,
          title: `Regression: merged agent PR #${o.pr} was reverted`,
          body: [
            `Mergeproof merged or proved #${o.pr} (${o.kind}, ${o.agent}/${o.model}) and it was reverted in ${o.revertCommit}.`,
            `The ${o.kind} trust for this agent and model is reset until it earns ${config.trust.minOutcomes} clean outcomes again.`,
            '',
            'Triage by a human. This issue is not meant for an agent to pick up.',
          ].join('\n'),
        }),
      );
    }
  }

  const count = (s) => ledger.outcomes.filter((o) => o.status === s).length;
  const summary = { reverted: newlyReverted.map((o) => o.pr), open: count('open'), pending: count('pending'), clean: count('clean'), issues };
  deps.print(
    flags.json
      ? JSON.stringify(summary, null, 2)
      : `Mergeproof sync — ${newlyReverted.length} newly reverted, ${summary.pending} pending, ${summary.clean} clean, ${summary.open} open` +
          newlyReverted.map((o) => `\n  ✗ #${o.pr} reverted (${o.kind}, ${o.agent}/${o.model})`).join(''),
  );
  return 0;
}
