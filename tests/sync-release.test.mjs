import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tagsContaining } from '../src/adapters/git.mjs';
import { settle } from '../src/commands/sync.mjs';
import { emptyLedger, trustFor } from '../src/ledger.mjs';
import { createRepo } from './fixtures/repo.mjs';

const DAY = 86_400_000;
const NOW = new Date('2026-06-20T00:00:00Z');
const PAST_MERGE = '2026-06-01T00:00:00Z';

function tagAt(dir, name, sha, isoDate) {
  const res = spawnSync('git', ['tag', '-a', name, sha, '-m', name], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GIT_COMMITTER_DATE: isoDate, GIT_AUTHOR_DATE: isoDate },
  });
  if (res.status !== 0) throw new Error(res.stderr);
}

function pendingOutcome(overrides = {}) {
  return {
    agent: 'claude',
    model: 'sonnet',
    kind: 'bugfix',
    status: 'pending',
    mergedAt: PAST_MERGE,
    mergeCommit: '1111111111111111111111111111111111111111',
    url: 'https://github.com/o/r/pull/1',
    ...overrides,
  };
}

test('tagsContaining: commit in two tags returns both oldest first; commit in no tag returns empty list', () => {
  const repo = createRepo();
  try {
    const firstSha = repo.git(['rev-parse', 'HEAD']);
    repo.write({ 'a.txt': 'v1\n' });
    const taggedSha = repo.commit('feat: first release');
    tagAt(repo.dir, 'v1.1.0', taggedSha, '2026-06-10T00:00:00Z');
    tagAt(repo.dir, 'v1.0.0', firstSha, '2026-06-05T00:00:00Z');
    repo.write({ 'b.txt': 'unreleased\n' });
    const untaggedSha = repo.commit('feat: unreleased');

    const firstTags = tagsContaining(repo.dir, firstSha);
    assert.deepEqual(firstTags.map((t) => t.name), ['v1.0.0', 'v1.1.0']);
    assert.equal(tagsContaining(repo.dir, untaggedSha).length, 0);
  } finally {
    repo.cleanup();
  }
});

test('settle with releaseOf: records oldest valid tag <= settle time, skips bad names and handles failures', () => {
  const ledger = {
    ...emptyLedger(),
    outcomes: [
      pendingOutcome({ url: 'u/1', mergeCommit: 'aaaaaaa' }),
      pendingOutcome({ url: 'u/2', mergeCommit: 'bbbbbbb' }),
      pendingOutcome({ url: 'u/3', mergeCommit: 'ccccccc' }),
      pendingOutcome({ url: 'u/4', mergeCommit: 'ddddddd' }),
      pendingOutcome({ url: 'u/5', mergeCommit: 'eeeeeee' }),
    ],
  };
  const tagsBySha = {
    aaaaaaa: [
      { name: 'v1.2.0', date: '2026-06-15T00:00:00Z' },
      { name: 'v1.0.0', date: '2026-06-05T00:00:00Z' },
    ],
    bbbbbbb: [],
    ccccccc: [
      { name: 'v9.9.9', date: '2026-06-25T00:00:00Z' },
      { name: 'v1.5.0', date: '2026-06-18T00:00:00Z' },
    ],
    ddddddd: [
      { name: 'bad tag!', date: '2026-06-02T00:00:00Z' },
      { name: 'x'.repeat(101), date: '2026-06-03T00:00:00Z' },
      { name: 'releases/v2.0', date: '2026-06-12T00:00:00Z' },
    ],
  };
  const { ledger: settled } = settle(ledger, {
    commits: [],
    prState: () => ({ state: 'MERGED' }),
    now: NOW,
    windowDays: 14,
    releaseOf: (sha) => {
      if (sha === 'eeeeeee') throw new Error('git failed');
      return tagsBySha[sha];
    },
  });

  assert.equal(settled.outcomes[0].releasedIn, 'v1.0.0');
  assert.equal(settled.outcomes[1].releasedIn, null);
  assert.equal(settled.outcomes[2].releasedIn, 'v1.5.0');
  assert.equal(settled.outcomes[3].releasedIn, 'releases/v2.0');
  assert.equal(settled.outcomes[4].status, 'clean');
  assert.equal(settled.outcomes[4].releasedIn, null);
});

test('settle without releaseOf adds no releasedIn; reverted, closed, and already-clean get no releasedIn', () => {
  const withoutRelease = settle(
    { ...emptyLedger(), outcomes: [pendingOutcome()] },
    { commits: [], prState: () => ({ state: 'MERGED' }), now: NOW, windowDays: 14 },
  );
  assert.equal(withoutRelease.ledger.outcomes[0].status, 'clean');
  assert.equal('releasedIn' in withoutRelease.ledger.outcomes[0], false);

  const calls = [];
  const mixed = settle(
    {
      ...emptyLedger(),
      outcomes: [
        pendingOutcome({ url: 'u/rev', mergeCommit: 'abcdef1234567890abcdef1234567890abcdef12' }),
        { agent: 'claude', model: 'sonnet', kind: 'bugfix', status: 'open', url: 'u/closed' },
        { agent: 'claude', model: 'sonnet', kind: 'bugfix', status: 'clean', mergedAt: PAST_MERGE, mergeCommit: 'oldclean' },
      ],
    },
    {
      commits: [{ sha: 'fedcba1234567890', date: new Date(Date.parse(PAST_MERGE) + 2 * DAY).toISOString(), message: 'Revert "x"\nThis reverts commit abcdef1234567890abcdef1234567890abcdef12.' }],
      prState: () => ({ state: 'CLOSED' }),
      now: NOW,
      windowDays: 14,
      releaseOf: (sha) => { calls.push(sha); return [{ name: 'v1.0.0', date: '2026-06-05T00:00:00Z' }]; },
    },
  );
  assert.equal(mixed.ledger.outcomes[0].status, 'reverted');
  assert.equal('releasedIn' in mixed.ledger.outcomes[0], false);
  assert.equal(mixed.ledger.outcomes[1].status, 'closed');
  assert.equal('releasedIn' in mixed.ledger.outcomes[1], false);
  assert.equal('releasedIn' in mixed.ledger.outcomes[2], false);
  assert.deepEqual(calls, []);
});

test('trustFor returns identical results with and without releasedIn', () => {
  const base = Array.from({ length: 10 }, (_, i) => ({
    agent: 'claude',
    model: 'sonnet',
    kind: 'bugfix',
    status: 'clean',
    mergedAt: PAST_MERGE,
    mergeCommit: `sha-${i}`,
  }));
  const withRelease = base.map((o, i) => ({ ...o, releasedIn: i % 2 === 0 ? 'v1.0.0' : null }));
  const key = { agent: 'claude', model: 'sonnet', kind: 'bugfix' };
  const opts = { minOutcomes: 10, minCleanRate: 0.9, revertCooldownDays: 30 };

  assert.deepEqual(trustFor({ ...emptyLedger(), outcomes: withRelease }, key, opts), trustFor({ ...emptyLedger(), outcomes: base }, key, opts));
});
