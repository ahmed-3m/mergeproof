import { appendOutcome, writeLedger } from './ledger.mjs';
import { formatTrailer } from './trailer.mjs';
import { formatVerdict } from './verdict.mjs';
import * as gh from './adapters/gh.mjs';

export const defaultDeps = { gh, now: () => new Date() };

/**
 * Land a verdict on GitHub — the write half both `check` and `apply` share:
 * record the outcome when the proof held, squash-merge (MERGE verdict and
 * enforce mode, pinned to the proven head) with a Mergeproof-Verdict trailer,
 * write the ledger, then comment the verdict.
 *
 * A proven PR is logged even when a human must merge it, so trust can grow
 * from human merges (shadow mode, cold start).
 *
 * @param {{ prUrl: string, pr: object, ledger: object, ledgerPath: string, config: object,
 *           verdict: { verdict: string, kind: string|null, notes: object[] }, kind: string|null,
 *           proven: boolean, agent: string, model: string, skill?: string|null, attempts: number,
 *           headSha: string, mode: string }} input
 * @returns {{ merged: boolean, text: string }} what happened, and the one-block summary to print
 */
export function land(input, deps = defaultDeps) {
  const { prUrl, pr, ledger, ledgerPath, config, verdict, kind, proven, agent, model, skill, attempts, headSha, mode } = input;
  let merged = false;
  if (proven && kind && kind !== 'deps') {
    const outcome = {
      pr: pr.number, url: pr.url, kind, agent, model,
      skill: skill ?? null, attempts, verdict: verdict.verdict,
      provenAt: deps.now().toISOString(), mergedAt: null, mergeCommit: null, status: 'open',
    };
    appendOutcome(ledger, outcome); // fail before merging if the outcome can't be logged
    if (verdict.verdict === 'MERGE' && config.mode === 'enforce') {
      const trailer = formatTrailer({ pr: pr.number, kind, agent, model, skill, attempts });
      deps.gh.squashMerge(prUrl, { body: trailer, headSha });
      const after = deps.gh.getPullRequest(prUrl);
      Object.assign(outcome, { status: 'pending', mergedAt: after.mergedAt ?? deps.now().toISOString(), mergeCommit: after.mergeCommit });
      merged = true;
    }
    writeLedger(ledgerPath, appendOutcome(ledger, outcome));
  }
  const text = `${formatVerdict(verdict)}\n  (${mode}${verdict.verdict === 'MERGE' ? (merged ? ': merged' : ': not merged') : ''})`;
  deps.gh.comment(prUrl, `\`\`\`\n${text}\n\`\`\``);
  return { merged, text };
}
