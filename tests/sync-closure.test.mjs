// MP-122: sync records who closed an unmerged proven PR (measurement only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createRepo } from './fixtures/repo.mjs';
import { runSync, settle, defaultDeps as syncDeps } from '../src/commands/sync.mjs';
import { emptyLedger, readLedger, trustFor, writeLedger, LEDGER_SCHEMA } from '../src/ledger.mjs';

const KEY = { kind: 'bugfix', agent: 'claude-code', model: 'claude-sonnet-5-5' };
const TRUST = { minOutcomes: 10, minCleanRate: 0.9, revertWindowDays: 14 };
const NOW = new Date('2026-11-13T00:00:00Z');

async function syncClosedOutcome(opts) {
  const repo = createRepo();
  const apiPaths = [];
  try {
    const ledgerPath = join(repo.dir, '.mergeproof', 'ledger.json');
    const url = `https://github.com/acme/app/pull/${opts.prNumber ?? 12}`;
    writeLedger(ledgerPath, {
      ...emptyLedger(),
      outcomes: [{ ...KEY, pr: opts.prNumber ?? 12, skill: 'bugfix@4', attempts: 1, verdict: 'MERGE', url, status: 'open' }],
    });
    const exitCode = await runSync([], {
      ...syncDeps,
      gh: {
        getPullRequest: () => ({ state: 'CLOSED', mergedAt: null, mergeCommit: null, author: opts.prAuthor ?? 'mergeproof-bot' }),
        apiJson: (path) => {
          apiPaths.push(path);
          if (opts.throwOnApi) throw new Error('gh api failed: HTTP 403');
          return opts.events;
        },
        createIssue: () => assert.fail('closed PRs never open revert issues'),
      },
      cwd: () => repo.dir,
      now: () => NOW,
      print: () => {},
    });
    return { exitCode, outcome: readLedger(ledgerPath).outcomes[0], apiPaths };
  } finally {
    repo.cleanup();
  }
}

test('sync records a maintainer close from the last closed issue event', async () => {
  const { exitCode, outcome, apiPaths } = await syncClosedOutcome({
    prNumber: 42,
    prAuthor: 'mergeproof-bot',
    events: [
      { event: 'closed', actor: { login: 'mergeproof-bot' } },
      { event: 'reopened', actor: { login: 'ahmed-3m' } },
      { event: 'closed', actor: { login: 'ahmed-3m' } },
      { event: 'referenced', actor: { login: 'other' } },
    ],
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(apiPaths, ['repos/acme/app/issues/42/events?per_page=100']);
  assert.equal(outcome.status, 'closed');
  assert.equal(outcome.closedBy, 'ahmed-3m');
  assert.equal(outcome.closedByAuthor, false);
});

test('sync records an author close as closedByAuthor: true', async () => {
  const { exitCode, outcome } = await syncClosedOutcome({
    prAuthor: 'mergeproof-bot',
    events: [{ event: 'closed', actor: { login: 'mergeproof-bot' } }],
  });
  assert.equal(exitCode, 0);
  assert.equal(outcome.status, 'closed');
  assert.equal(outcome.closedBy, 'mergeproof-bot');
  assert.equal(outcome.closedByAuthor, true);
});

test('a failed events read or missing closed event leaves both fields null and still settles', async () => {
  const failed = await syncClosedOutcome({ throwOnApi: true });
  assert.equal(failed.exitCode, 0);
  assert.equal(failed.outcome.status, 'closed');
  assert.equal(failed.outcome.closedBy, null);
  assert.equal(failed.outcome.closedByAuthor, null);

  const missing = await syncClosedOutcome({ events: [{ event: 'labeled', actor: { login: 'ahmed-3m' } }] });
  assert.equal(missing.exitCode, 0);
  assert.equal(missing.outcome.status, 'closed');
  assert.equal(missing.outcome.closedBy, null);
  assert.equal(missing.outcome.closedByAuthor, null);
});

test('settle handles prState without new fields and never revisits already closed outcomes', () => {
  const ledger = {
    schema: LEDGER_SCHEMA,
    outcomes: [
      { ...KEY, pr: 1, url: 'https://github.com/acme/app/pull/1', status: 'open' },
      { ...KEY, pr: 2, url: 'https://github.com/acme/app/pull/2', status: 'closed' },
    ],
  };
  const lookedUp = [];
  const { ledger: after } = settle(ledger, {
    commits: [],
    prState: (url) => {
      lookedUp.push(url);
      return { state: 'CLOSED' };
    },
    now: NOW,
    windowDays: 14,
  });
  assert.deepEqual(lookedUp, ['https://github.com/acme/app/pull/1']);
  assert.equal(after.outcomes[0].status, 'closed');
  assert.equal(after.outcomes[0].closedBy, null);
  assert.equal(after.outcomes[0].closedByAuthor, null);
  assert.deepEqual(after.outcomes[1], { ...KEY, pr: 2, url: 'https://github.com/acme/app/pull/2', status: 'closed' });
});

test('trustFor returns the exact same result with and without closedBy / closedByAuthor', () => {
  const clean = Array.from({ length: 10 }, (_, i) => ({
    ...KEY, pr: i + 1, status: 'clean', mergedAt: `2026-10-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
  }));
  const plainClosed = { ...KEY, pr: 99, status: 'closed' };
  const annotatedClosed = { ...KEY, pr: 99, status: 'closed', closedBy: 'ahmed-3m', closedByAuthor: false };

  const baseline = trustFor({ schema: LEDGER_SCHEMA, outcomes: [...clean, plainClosed] }, KEY, TRUST);
  const measured = trustFor({ schema: LEDGER_SCHEMA, outcomes: [...clean, annotatedClosed] }, KEY, TRUST);
  assert.deepEqual(measured, baseline);
  assert.equal(measured.trusted, true);
  assert.equal(measured.outcomes, 10);
});
