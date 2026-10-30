import { existsSync, readFileSync } from 'node:fs';
import { parseFlags } from '../args.mjs';
import { UsageError } from '../errors.mjs';
import { EXIT_CODES } from '../verdict.mjs';
import { parseRoadmap, planIssues } from '../roadmap.mjs';
import * as gh from '../adapters/gh.mjs';

// `mergeproof roadmap` (M3 phase E): one proposed GitHub issue per `ready`
// item in ROADMAP.md. It only ever creates — existing issues are never edited
// or closed — and the issues it opens start nothing by themselves: a
// maintainer reviews each and adds the `agent` label.

export const defaultDeps = {
  gh,
  print: (s) => console.log(s),
  // null means "no such file": a repo without a roadmap is not an error.
  readFile: (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null),
};

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

// The labels this command puts on the issues it opens (`bug` rides along on
// bugfix items, matching the gate's issue-label split).
const LABELS = {
  'agent-proposed': { color: '5319E7', description: 'mergeproof: proposed from a ready ROADMAP.md item — add the agent label to start it' },
  bug: { color: 'D73A4A', description: 'mergeproof: something is broken' },
};

/** Create a label; gh's "already exists" answer means the job is done. */
function ensureLabel(deps, repo, name) {
  try {
    deps.gh.createLabel({ repo, name, color: LABELS[name].color, description: LABELS[name].description });
  } catch (err) {
    if (!/already exists/i.test(String(err?.message ?? ''))) throw err;
  }
}

const issueNumber = (url) => {
  const n = Number(/\/(\d+)$/.exec(String(url ?? ''))?.[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export async function runRoadmap(argv, deps = defaultDeps) {
  const { positionals, flags } = parseFlags(argv, ['dry-run', 'json'], ['file', 'limit']);
  if (positionals.length > 0) throw new UsageError('roadmap takes no arguments');
  const file = flags.file ?? 'ROADMAP.md';
  let limit = DEFAULT_LIMIT;
  if (flags.limit !== null) {
    limit = Number(flags.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new UsageError(`--limit must be a whole number from 1 to ${MAX_LIMIT}`);
  }
  const dryRun = flags['dry-run'];

  const text = deps.readFile(file);
  if (text === null) {
    deps.print(`Mergeproof roadmap — no ${file}; nothing to do`);
    return 0;
  }

  const { items, errors } = parseRoadmap(text);
  if (errors.length > 0) {
    // Every error, one per line, and nothing is opened: a half-parsed
    // backlog must not turn into issues.
    deps.print(errors.map((e) => `${file}: ${e}`).join('\n'));
    return EXIT_CODES.USAGE;
  }

  // One listing of open AND closed issues: the marker in a body decides what
  // was already proposed, and a closed issue counts like an open one.
  const existing = deps.gh.listIssues({ state: 'all', limit: 1000 });
  const plan = planIssues(items, existing);
  const toOpen = plan.slice(0, limit);
  const ready = items.filter((i) => i.status === 'ready');

  const opened = [];
  if (!dryRun && toOpen.length > 0) {
    const { repo } = deps.gh.repoView();
    // Labels first: createIssue fails outright on a label the repo lacks.
    for (const name of new Set(toOpen.flatMap((i) => i.labels))) ensureLabel(deps, repo, name);
    for (const issue of toOpen) {
      const url = deps.gh.createIssue({ repo, title: issue.title, body: issue.body, labels: issue.labels });
      opened.push({ id: issue.id, url, number: issueNumber(url) });
    }
  }

  const summary = {
    file,
    dryRun,
    items: items.length,
    ready: ready.length,
    alreadyProposed: ready.length - plan.length,
    deferred: plan.length - toOpen.length,
    notReady: items.length - ready.length,
    opened,
    planned: toOpen.map(({ id, title, labels }) => ({ id, title, labels })),
  };
  if (flags.json) {
    deps.print(JSON.stringify(summary, null, 2));
  } else {
    const byId = new Map(opened.map((o) => [o.id, o]));
    for (const issue of toOpen) {
      const o = byId.get(issue.id);
      deps.print(o ? `opened ${o.number ? `#${o.number}` : o.url} ${issue.title}` : `would open ${issue.title}`);
    }
    deps.print(
      `Mergeproof roadmap — ${toOpen.length} ${dryRun ? 'to open' : 'opened'}, ${summary.alreadyProposed} already proposed, ${summary.deferred} deferred to the next run, ${summary.notReady} not ready`,
    );
  }
  return 0;
}
