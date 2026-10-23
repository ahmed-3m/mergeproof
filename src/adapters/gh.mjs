import { runProcess } from './process.mjs';

// GitHub access goes through the local `gh` CLI and its existing login, so
// mergeproof never handles tokens itself. Calls are argv arrays with shell:
// false; PR text (titles, bodies) is passed as data, never parsed.

const PR_FIELDS = [
  'number', 'title', 'url', 'author', 'state', 'headRefName', 'headRefOid', 'baseRefName', 'baseRefOid',
  'labels', 'commits', 'isCrossRepository', 'mergeCommit', 'mergedAt', 'statusCheckRollup',
].join(',');

/** Replace every occurrence of `secret` with ***: a gh error message must never echo a secret back. */
export function redactSecret(text, secret) {
  return secret ? text.split(secret).join('***') : text;
}

function gh(args, { input } = {}) {
  const res = runProcess('gh', args, { input });
  if (res.code !== 0) {
    let first = (res.stderr || res.stdout).trim().split('\n')[0];
    // Only secrets are passed as input; their value must never reach a message.
    if (input !== undefined) first = redactSecret(first, input);
    throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${first}`);
  }
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

// ---- `mergeproof init` support (M2). Read paths used by detection and the
// post-install verification; write paths are idempotent by construction.

/** owner/repo and the default branch of the repo the current login sees. */
export function repoView() {
  const raw = JSON.parse(gh(['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef']));
  return { repo: raw.nameWithOwner, defaultBranch: raw.defaultBranchRef?.name ?? null };
}

/** Create a label, or update an existing one (--force), with a fixed colour and description. */
export function createLabel({ repo, name, color, description }) {
  gh(['label', 'create', name, '--repo', repo, '--color', color, '--description', description, '--force']);
}

/** Create or overwrite a repository variable. */
export function setVariable({ repo, name, value }) {
  gh(['variable', 'set', name, '--body', value, '--repo', repo]);
}

/**
 * Create or overwrite a repository secret. The value travels on the child's
 * stdin (`runProcess` `input`), never in argv, and is redacted from any error
 * message gh produces.
 */
export function setSecret({ repo, name, value }) {
  gh(['secret', 'set', name, '--repo', repo], { input: value });
}

/** GET `path` through `gh api`; null on 404 when allowed, an Error otherwise. */
export function apiJson(path, { allow404 = false } = {}) {
  const res = runProcess('gh', ['api', path]);
  if (res.code === 0) return JSON.parse(res.stdout);
  const first = (res.stderr || res.stdout).trim().split('\n')[0];
  if (allow404 && /HTTP 404/.test(first)) return null;
  throw new Error(`gh api failed: ${first}`);
}

// ---- `mergeproof dispatch` support. Reads for the local runner (a
// maintainer's machine, their own gh login); dispatch never decides a verdict.

/** One read of an issue: author, title, body and label names. */
export function getIssue({ repo, number }) {
  const raw = apiJson(`repos/${repo}/issues/${number}`);
  return {
    author: raw.user?.login ?? null,
    title: raw.title ?? '',
    body: raw.body ?? '',
    labels: (raw.labels ?? []).map((l) => l.name),
    isPullRequest: Boolean(raw.pull_request), // the issues API also returns PRs
  };
}

/** Every comment on an issue, paginated: [{ author, body }]. */
export function issueComments({ repo, number }) {
  const raw = JSON.parse(gh(['api', `repos/${repo}/issues/${number}/comments`, '--paginate']));
  return (Array.isArray(raw) ? raw : []).map((c) => ({ author: c.user?.login ?? null, body: c.body ?? '' }));
}

/**
 * A login's collaborator permission (admin | maintain | write | triage | read),
 * or null on any API error — the caller treats null as untrusted (fail closed).
 */
export function collaboratorPermission({ repo, login }) {
  try {
    return apiJson(`repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`)?.permission ?? null;
  } catch {
    return null;
  }
}

/** Does the branch exist? A 404 means no; anything else throws. */
export function branchExists({ repo, branch }) {
  return apiJson(`repos/${repo}/branches/${encodeURIComponent(branch)}`, { allow404: true }) !== null;
}
