import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { FileFormatError } from './errors.mjs';
import { KINDS } from './classify.mjs';

export const LEDGER_SCHEMA = 'mergeproof-ledger@1';

// Where `check` and `sync` keep the ledger unless --ledger says otherwise.
// It sits under .mergeproof/, which tamper rules stop a PR from editing.
export const DEFAULT_LEDGER = '.mergeproof/ledger.json';

// One outcome per gated PR whose proof held (whether the gate or a human merges it):
// { pr, kind, agent, model, skill, attempts, verdict, provenAt, mergedAt, mergeCommit, status }
// status: open      proven, waiting to be merged (sync checks the PR)
//         pending   merged, inside the revert window
//         clean     merged and not reverted within trust.revertWindowDays
//         reverted  sync saw a revert inside the window
//         closed    closed without merging; never counts
export const STATUSES = Object.freeze(['open', 'pending', 'clean', 'reverted', 'closed']);

export function emptyLedger() {
  return { schema: LEDGER_SCHEMA, outcomes: [] };
}

function validateOutcome(o, where, fail) {
  if (typeof o !== 'object' || o === null) fail(`${where} must be an object`);
  if (!Number.isInteger(o.pr) || o.pr < 0) fail(`${where}.pr must be a PR number`);
  if (!KINDS.includes(o.kind)) fail(`${where}.kind must be one of ${KINDS.join(', ')}`);
  for (const key of ['agent', 'model']) {
    if (typeof o[key] !== 'string' || !o[key]) fail(`${where}.${key} must be a non-empty string`);
  }
  if (!STATUSES.includes(o.status)) fail(`${where}.status must be one of ${STATUSES.join(', ')}`);
}

export function readLedger(path) {
  if (!existsSync(path)) return emptyLedger();
  const fail = (msg) => {
    throw new FileFormatError(path, msg);
  };
  let data;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(`not valid JSON (${err.message})`);
  }
  if (data?.schema !== LEDGER_SCHEMA) fail(`schema must be "${LEDGER_SCHEMA}"`);
  if (!Array.isArray(data.outcomes)) fail('outcomes must be an array');
  data.outcomes.forEach((o, i) => validateOutcome(o, `outcomes[${i}]`, fail));
  return data;
}

/** Write via a temp file and rename, so a crash never leaves half a ledger. */
export function writeLedger(path, ledger) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * Return a new ledger with `outcome` recorded. A PR that is still open replaces
 * its earlier entry (a retry re-proves the same PR); settled entries are history
 * and are never overwritten.
 */
export function appendOutcome(ledger, outcome) {
  validateOutcome(outcome, 'outcome', (msg) => {
    throw new TypeError(msg);
  });
  const outcomes = ledger.outcomes.filter((o) => !(o.pr === outcome.pr && o.status === 'open'));
  if (outcomes.some((o) => o.pr === outcome.pr && o.status !== 'closed')) {
    throw new TypeError(`PR ${outcome.pr} already has a settled outcome`);
  }
  return { ...ledger, outcomes: [...outcomes, { ...outcome }] };
}

/**
 * A filtered view of `ledger` in which every outcome that could grant or
 * remove trust is anchored in real git history: `clean` and `pending`
 * outcomes are kept only when they name a mergeCommit (≥ 7 hex chars) that
 * `isVerifiedMerge(outcome)` confirms — the caller anchors it in the gated
 * base branch with git, so a forged `mergeproof-ledger` entry (or one whose
 * commit a rebase dropped) buys no trust. `reverted` outcomes are ALWAYS
 * kept: a penalty can never be erased, whatever happened to its SHA. `open`
 * and `closed` outcomes never grant trust in `trustFor` and pass through.
 * The input ledger is not mutated; the view is what `trustFor` reads.
 * @param {object} ledger
 * @param {(outcome: object) => boolean} isVerifiedMerge
 * @returns {object} a ledger with the unverified outcomes removed.
 */
export function verifyLedger(ledger, isVerifiedMerge) {
  const outcomes = ledger.outcomes.filter((o) => {
    if (o.status !== 'clean' && o.status !== 'pending') return true;
    return typeof o.mergeCommit === 'string' && o.mergeCommit.length >= 7 && isVerifiedMerge(o);
  });
  return { ...ledger, outcomes };
}

/**
 * Trust is earned per (kind, agent, model): unlocked after trust.minOutcomes
 * merged outcomes at ≥ trust.minCleanRate clean; lost after any revert in the
 * last trust.minOutcomes merges. Pending merges count toward neither until
 * their revert window passes.
 * @returns {{ trusted: boolean, outcomes: number, cleanRate: number, text: string }}
 */
export function trustFor(ledger, { kind, agent, model }, trustConfig) {
  const merged = ledger.outcomes
    .filter((o) => o.kind === kind && o.agent === agent && o.model === model)
    .filter((o) => o.status === 'pending' || o.status === 'clean' || o.status === 'reverted')
    .sort((a, b) => String(a.mergedAt ?? '').localeCompare(String(b.mergedAt ?? '')));
  const settled = merged.filter((o) => o.status !== 'pending');
  const clean = settled.filter((o) => o.status === 'clean').length;
  const cleanRate = settled.length ? clean / settled.length : 0;
  // Settled only: pending merges count toward neither (their revert window has
  // not passed), so a run of not-yet-settled merges cannot push a revert out
  // of the recent window and restore trust early.
  const recentRevert = settled.slice(-trustConfig.minOutcomes).some((o) => o.status === 'reverted');
  const who = `${kind} for ${agent}/${model}`;
  const pct = `${Math.round(cleanRate * 100)}% clean`;
  let text;
  let trusted = false;
  if (recentRevert) text = `${who} lost trust: a revert in its last ${trustConfig.minOutcomes} merges`;
  else if (settled.length < trustConfig.minOutcomes) text = `${who} not trusted yet (${settled.length}/${trustConfig.minOutcomes} outcomes)`;
  else if (cleanRate < trustConfig.minCleanRate) text = `${who} not trusted: ${pct} (needs ${Math.round(trustConfig.minCleanRate * 100)}%)`;
  else {
    trusted = true;
    text = `${who} trusted (${settled.length} outcomes, ${pct})`;
  }
  return { trusted, outcomes: settled.length, cleanRate, text };
}
