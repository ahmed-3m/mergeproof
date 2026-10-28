import { resolve } from 'node:path';
import { parseFlags } from '../args.mjs';
import { UsageError } from '../errors.mjs';
import { CONFIG_FILE, parseConfig } from '../config.mjs';
import { DEFAULT_LEDGER, readLedger, writeLedger } from '../ledger.mjs';
import * as git from '../adapters/git.mjs';
import * as gh from '../adapters/gh.mjs';

export const defaultDeps = { git, gh, now: () => new Date(), cwd: () => process.cwd(), print: (s) => console.log(s) };

const DAY = 24 * 60 * 60 * 1000;

// A revert is found three ways, so one squashed under another message or
// made by hand still counts:
//   shas  "This reverts commit <sha>" (git revert)
//   prs   "Reverts owner/repo#N" on a line of its own (GitHub's revert PR body,
//         kept when the revert PR is squashed with its description)
//   content  a later commit whose change is the exact undo of the merge
//            (same stable patch id), whatever its message
// A false match only marks an outcome reverted, which costs trust, never adds it.
export function findReverts(commits) {
  const shas = new Map();
  const prs = new Map();
  for (const c of commits) {
    for (const m of c.message.matchAll(/This reverts commit ([0-9a-f]{7,40})/g)) {
      if (!shas.has(m[1])) shas.set(m[1], c);
    }
    for (const m of c.message.matchAll(/^Reverts (?:([\w.-]+\/[\w.-]+))?#(\d+)[ \t]*$/gm)) {
      const key = `${(m[1] ?? '').toLowerCase()}#${m[2]}`;
      if (!prs.has(key)) prs.set(key, c);
    }
  }
  return { shas, prs };
}

function revertOf(reverts, o, { commits, patchId, mergedAt, windowEnd }) {
  for (const [target, commit] of reverts.shas) if (o.mergeCommit.startsWith(target)) return commit;
  // Message and content matches must come after the merge: a "Reverts #N" or
  // an identical undo from before it is about something else.
  const after = (c) => Date.parse(c.date) >= mergedAt && Date.parse(c.date) <= windowEnd && !o.mergeCommit.startsWith(c.sha);
  const repo = (o.url?.match(/^https:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\//)?.[1] ?? '').toLowerCase();
  for (const key of [`${repo}#${o.pr}`, `#${o.pr}`]) {
    const commit = reverts.prs.get(key);
    if (commit && after(commit)) return commit;
  }
  if (!patchId) return null;
  const undo = patchId(o.mergeCommit, true);
  if (!undo) return null;
  return commits.filter(after).reverse().find((c) => patchId(c.sha, false) === undo) ?? null;
}

/**
 * Settle the ledger (PROTOTYPE.md flow 3, learning half). Returns the new ledger
 * and the outcomes that were newly reverted. Pure apart from `prState` and `patchId`.
 *   open     → pending once the PR is merged, closed if it was closed unmerged
 *   pending  → reverted if a revert of its merge commit landed inside the window
 *   pending  → clean once the window has passed with no revert
 */
export function settle(ledger, { commits, prState, now, windowDays, patchId = null }) {
  const reverts = findReverts(commits);
  const ids = new Map();
  const cachedPatchId = patchId && ((sha, reverse) => {
    const key = `${sha}:${reverse}`;
    if (!ids.has(key)) ids.set(key, patchId(sha, reverse));
    return ids.get(key);
  });
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
      const windowEnd = mergedAt + windowDays * DAY;
      const revert = next.mergeCommit ? revertOf(reverts, next, { commits, patchId: cachedPatchId, mergedAt, windowEnd }) : null;
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
    patchId: (sha, reverse) => deps.git.patchId(root, sha, { reverse }),
  });

  const issues = [];
  if (!flags['dry-run']) {
    // Issues first, ledger second: a failed createIssue must leave the outcome
    // `pending` on disk so the next sync retries it. The reverse order would
    // settle it silently and the triage issue would never exist; a failed
    // write after a successful issue at worst opens a duplicate, which is
    // visible and stops once a write lands.
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
    writeLedger(ledgerPath, ledger);
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
