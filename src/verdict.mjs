// The verdict is the gate's only output contract: workflows branch on it,
// so these names and exit codes are frozen once released.
export const VERDICTS = Object.freeze({
  MERGE: 'MERGE', // proof holds and this kind is trusted for this agent
  RETRY: 'RETRY', // weak proof (CI red, new test passes on base, flaky) — agent may fix the same PR
  HUMAN: 'HUMAN', // tampering, deps, untrusted kind, or retries exhausted
});

export const EXIT_CODES = Object.freeze({
  MERGE: 0,
  ERROR: 1,
  USAGE: 2,
  RETRY: 3,
  HUMAN: 4,
});

// Token discipline: a verdict never carries more than 3 notes.
export const MAX_NOTES = 3;

/**
 * @param {keyof VERDICTS} verdict
 * @param {{ kind?: string|null, notes?: Array<{ ok: boolean, text: string }> }} [details]
 */
export function makeVerdict(verdict, { kind = null, notes = [] } = {}) {
  if (!Object.hasOwn(VERDICTS, verdict)) {
    throw new TypeError(`unknown verdict: ${verdict}`);
  }
  // Failing notes first, so truncation never hides the reason for a block.
  const ordered = [...notes.filter((n) => !n.ok), ...notes.filter((n) => n.ok)];
  return { verdict, kind, notes: ordered.slice(0, MAX_NOTES) };
}

export function formatVerdict(v, { json = false } = {}) {
  if (json) return JSON.stringify(v, null, 2);
  const head = `Mergeproof — ${v.verdict}${v.kind ? ` (kind: ${v.kind})` : ''}`;
  return [head, ...v.notes.map((n) => `  ${n.ok ? '✓' : '✗'} ${n.text}`)].join('\n');
}
