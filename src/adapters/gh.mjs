import { runProcess } from './process.mjs';

// GitHub access goes through the local `gh` CLI and its existing login, so
// mergeproof never handles tokens itself. Calls are argv arrays with shell:
// false; PR text (titles, bodies) is passed as data, never parsed.

const PR_FIELDS = [
  'number', 'title', 'url', 'author', 'state', 'headRefName', 'headRefOid', 'baseRefName', 'baseRefOid',
  'labels', 'commits', 'isCrossRepository', 'mergeCommit', 'mergedAt', 'statusCheckRollup',
].join(',');

function gh(args) {
  const res = runProcess('gh', args);
  if (res.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${(res.stderr || res.stdout).trim().split('\n')[0]}`);
  return res.stdout;
}

/** owner/repo and number from https://github.com/owner/repo/pull/N (+ any /files, ?query or #fragment a browser adds) */
export function parsePrUrl(prUrl) {
  const m = /^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(prUrl);
  if (!m) return null;
  return { host: m[1], repo: `${m[2]}/${m[3]}`, number: Number(m[4]) };
}

/** Normalize `gh pr view --json` output into what the gate uses. */
export function normalizePr(raw) {
  return {
    number: raw.number,
    title: raw.title ?? '',
    url: raw.url,
    author: raw.author?.login ?? 'unknown',
    state: raw.state,
    headRef: raw.headRefName,
    headSha: raw.headRefOid,
    baseRef: raw.baseRefName,
    baseSha: raw.baseRefOid,
    labels: (raw.labels ?? []).map((l) => l.name),
    subjects: (raw.commits ?? []).map((c) => c.messageHeadline ?? ''),
    isFork: raw.isCrossRepository !== false, // unknown counts as a fork
    mergeCommit: raw.mergeCommit?.oid ?? null,
    mergedAt: raw.mergedAt ?? null,
    checks: raw.statusCheckRollup ?? [],
  };
}

const RED = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR']);

/**
 * Collapse a statusCheckRollup into green | red | pending | none. Checks named
 * after mergeproof are ignored: the gate's own job is still running while it
 * looks at CI.
 */
export function checksState(rollup) {
  const checks = rollup.filter((c) => !/mergeproof/i.test(c.name ?? c.context ?? ''));
  if (checks.length === 0) return 'none';
  let pending = false;
  for (const c of checks) {
    const result = c.conclusion || c.state || '';
    if (RED.has(result)) return 'red';
    if ((c.status && c.status !== 'COMPLETED') || result === 'PENDING' || result === 'EXPECTED' || result === '') pending = true;
  }
  return pending ? 'pending' : 'green';
}

export function getPullRequest(prUrl) {
  return normalizePr(JSON.parse(gh(['pr', 'view', prUrl, '--json', PR_FIELDS])));
}

export function getChecksStatus(prUrl) {
  return checksState(JSON.parse(gh(['pr', 'view', prUrl, '--json', 'statusCheckRollup'])).statusCheckRollup ?? []);
}

/**
 * Labels on the issues the workflow dispatched the agent for (`--issue`), from the
 * PR's own repository. Never the PR's "closes #N" links, which the agent writes.
 */
export function issueLabels(prUrl, issueNumbers) {
  const { repo } = parsePrUrl(prUrl) ?? {};
  if (!repo) return [];
  return issueNumbers.flatMap((n) =>
    JSON.parse(gh(['issue', 'view', String(n), '--repo', repo, '--json', 'labels'])).labels.map((l) => l.name),
  );
}

/** Squash-merge only if the head is still the commit that was proven. */
export function squashMerge(prUrl, { body, headSha }) {
  gh(['pr', 'merge', prUrl, '--squash', '--body', body, '--match-head-commit', headSha]);
}

export function comment(prUrl, body) {
  gh(['pr', 'comment', prUrl, '--body', body]);
}

/** Label a PR, e.g. needs-human when apply lands a HUMAN verdict. */
export function addLabel(prUrl, label) {
  gh(['pr', 'edit', prUrl, '--add-label', label]);
}

export function createIssue({ repo, title, body, labels = [] }) {
  const args = ['issue', 'create', '--repo', repo, '--title', title, '--body', body];
  for (const l of labels) args.push('--label', l);
  return gh(args).trim();
}
