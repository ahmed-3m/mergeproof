// Git-anchored ledger verification (trust.verifyCommits): a forged clean or
// pending outcome whose mergeCommit is not real history of the gated base
// buys no trust, while a revert penalty can never be erased — plus the whole
// gate on a real git repo, where only a genuine ancestor of main grants trust.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { verifyLedger, trustFor, LEDGER_SCHEMA } from '../src/ledger.mjs';
import { isAncestor } from '../src/adapters/git.mjs';
import { createRepo, testFile, FIXED_MATH } from './fixtures/repo.mjs';
import { evaluate, defaultDeps } from '../src/commands/check.mjs';
import { parseConfig } from '../src/config.mjs';

const KEY = { kind: 'bugfix', agent: 'claude-code', model: 'glm-5.2' };
const TRUST = { minOutcomes: 10, minCleanRate: 0.9, revertWindowDays: 14 };

function outcome(over = {}) {
  return { pr: 1, ...KEY, skill: 'bugfix@1', attempts: 1, verdict: 'MERGE', mergedAt: '2026-09-01T00:00:00Z', status: 'clean', ...over };
}

const clean = (pr) => outcome({ pr, mergeCommit: `${String(pr).padStart(40, '0')}`.slice(-40) });

test('verifyLedger keeps only git-anchored clean/pending outcomes, and never drops a revert', () => {
  const ledger = {
    schema: LEDGER_SCHEMA,
    outcomes: [
      clean(1), // mergeCommit is verified history
      clean(2), // forged: never merged
      outcome({ pr: 3 }), // no mergeCommit at all
      outcome({ pr: 4, mergeCommit: 'abc' }), // too short to be a commit
      outcome({ pr: 5, status: 'pending', mergeCommit: 'c'.repeat(40) }), // pending, verified
      outcome({ pr: 6, status: 'pending', mergeCommit: 'd'.repeat(40) }), // pending, forged
      outcome({ pr: 7, status: 'reverted', mergeCommit: 'e'.repeat(40) }), // penalty kept, SHA missing
      outcome({ pr: 8, status: 'reverted' }), // penalty kept, no SHA at all
      outcome({ pr: 9, status: 'open' }), // never grants trust; kept as-is
      outcome({ pr: 10, status: 'closed' }), // never grants trust; kept as-is
    ],
  };
  const verified = new Set([clean(1).mergeCommit, 'c'.repeat(40)]);
  const view = verifyLedger(ledger, (o) => verified.has(o.mergeCommit));
  assert.deepEqual(view.outcomes.map((o) => o.pr), [1, 5, 7, 8, 9, 10]);
  assert.equal(ledger.outcomes.length, 10, 'the input ledger is not mutated');
  assert.equal(view.schema, LEDGER_SCHEMA);
});

test('a forged ledger loses its trust; a revert penalty survives verification', () => {
  const tenClean = Array.from({ length: 10 }, (_, i) => clean(i + 1));
  const nothing = () => false; // no mergeCommit is real history
  const t = trustFor(verifyLedger({ schema: LEDGER_SCHEMA, outcomes: tenClean }, nothing), KEY, TRUST);
  assert.equal(t.trusted, false, 'ten forged clean outcomes grant nothing');
  assert.match(t.text, /not trusted yet \(0\/10 /);

  // However many forged cleans pile up, the revert they would mask stays.
  const withRevert = [...tenClean, outcome({ pr: 11, status: 'reverted', mergeCommit: 'e'.repeat(40) })];
  const lost = trustFor(verifyLedger({ schema: LEDGER_SCHEMA, outcomes: withRevert }, nothing), KEY, TRUST);
  assert.equal(lost.trusted, false);
  assert.match(lost.text, /lost trust/);
});

test('isAncestor is false for unknown or malformed SHAs, never an error', () => {
  const repo = createRepo();
  try {
    const sha = repo.git(['rev-parse', 'HEAD']);
    assert.equal(isAncestor(repo.dir, sha, sha), true, 'a commit is its own ancestor');
    assert.equal(isAncestor(repo.dir, '0123456789abcdef0123456789abcdef01234567', sha), false, 'a SHA that exists nowhere');
    assert.equal(isAncestor(repo.dir, 'not-a-sha', sha), false);
    assert.equal(isAncestor(repo.dir, undefined, sha), false);
    assert.equal(isAncestor(repo.dir, sha, '0123456789abcdef0123456789abcdef01234567'), false);
  } finally {
    repo.cleanup();
  }
});

test('check grants trust only from merge commits that are real history of the gated base', () => {
  const repo = createRepo(undefined, { trust: { minOutcomes: 1, verifyCommits: true } });
  try {
    const pastMerge = repo.git(['rev-parse', 'HEAD']); // the ledger's "merged PR"
    repo.write({ 'README.md': 'history moves on\n' });
    repo.commit('chore: seed history');
    const baseSha = repo.git(['rev-parse', 'HEAD']); // main tip = the anchor
    repo.branch('agent/fix').write({ 'src/math.mjs': FIXED_MATH, 'tests/mul.test.mjs': testFile('mul by 3', ['assert.equal(mul(3, 2), 6);']) });
    const headSha = repo.commit('fix: mul by 3');
    repo.git(['checkout', '--quiet', 'main']);
    const config = parseConfig(repo.git(['show', `${baseSha}:.mergeproof.json`]));
    assert.equal(config.trust.verifyCommits, true);

    const ledgerOf = (mergeCommit) => ({ schema: LEDGER_SCHEMA, outcomes: [outcome({ pr: 9, mergeCommit })] });
    const gate = (ledger) =>
      evaluate(
        {
          root: repo.dir, baseSha, headSha, configSha: baseSha, config,
          claims: { subjects: ['fix: mul by 3'] }, ci: null, issueLabels: ['bug'],
          agent: 'claude-code', model: 'glm-5.2', ledger,
        },
        defaultDeps,
      );

    // The merge commit is an ancestor of the base tip: trust is granted, the
    // proven bugfix merges.
    const honest = gate(ledgerOf(pastMerge));
    assert.equal(honest.trust.trusted, true, honest.trust.text);
    assert.equal(honest.verdict.verdict, 'MERGE', JSON.stringify(honest.verdict));

    // A fabricated 40-hex SHA on the mergeproof-ledger branch is rejected:
    // the outcome buys nothing, so the same proven PR waits for a human.
    const forged = gate(ledgerOf('a'.repeat(40)));
    assert.equal(forged.trust.trusted, false);
    assert.match(forged.trust.text, /not trusted yet \(0\/1 /);
    assert.equal(forged.verdict.verdict, 'HUMAN', JSON.stringify(forged.verdict));
    assert.match(forged.verdict.notes.map((n) => n.text).join('\n'), /not trusted yet/);

    // A revert penalty anchored to nothing still costs: kept by verifyLedger,
    // the bucket has lost trust however many clean outcomes it claims.
    const reverted = gate({ schema: LEDGER_SCHEMA, outcomes: [outcome({ pr: 9, status: 'reverted', mergeCommit: 'b'.repeat(40) })] });
    assert.equal(reverted.trust.trusted, false);
    assert.match(reverted.trust.text, /lost trust/);
    assert.equal(reverted.verdict.verdict, 'HUMAN', JSON.stringify(reverted.verdict));
  } finally {
    repo.cleanup();
  }
});
