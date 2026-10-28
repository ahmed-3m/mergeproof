import { makeVerdict } from './verdict.mjs';

// Decision table (PROTOTYPE.md flow 3), checked in order:
//   any tamper note             → HUMAN (no retry: retrying teaches better cheating)
//   kind === 'deps'             → HUMAN
//   no kind fits the paths      → HUMAN
//   proof weak                  → RETRY (the agent can fix it on the same PR)
//   proof impossible            → HUMAN (e.g. the suite is already red on base)
//   kind not trusted for agent  → HUMAN
//   otherwise                   → MERGE
/**
 * @param {{ kind: string|null, tamperNotes: Array<{ok:boolean,text:string}>,
 *           proof: { ok: boolean, weak: boolean, notes: Array<{ok:boolean,text:string}> } | null,
 *           trust: { trusted: boolean, text: string } | null }} input
 * @returns {ReturnType<import('./verdict.mjs').makeVerdict>}
 */
export function decide({ kind, tamperNotes = [], proof = null, trust = null }) {
  if (tamperNotes.length > 0) return makeVerdict('HUMAN', { kind, notes: tamperNotes });
  const proofNotes = proof?.notes ?? [];
  if (kind === 'deps') {
    return makeVerdict('HUMAN', { kind, notes: [{ ok: false, text: 'dependency changes always need a human in v1' }, ...proofNotes] });
  }
  if (!kind || !proof) return makeVerdict('HUMAN', { kind, notes: proofNotes });
  if (proof.weak) return makeVerdict('RETRY', { kind, notes: proofNotes });
  if (!proof.ok) return makeVerdict('HUMAN', { kind, notes: proofNotes });
  if (!trust?.trusted) {
    return makeVerdict('HUMAN', { kind, notes: [{ ok: false, text: trust?.text ?? `${kind} is not trusted yet` }, ...proofNotes] });
  }
  return makeVerdict('MERGE', { kind, notes: [...proofNotes, { ok: true, text: trust.text }] });
}
