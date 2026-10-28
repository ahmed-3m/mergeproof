// Git trailer stamped on every squash merge the gate makes, e.g.
//   Mergeproof-Verdict: merge pr=42 kind=bugfix agent=claude-code model=glm-5.2 skill=bugfix@1 attempts=1
// It is the audit trail on the default branch; `sync` tracks reverts through the
// merge commit recorded in the ledger.
export const TRAILER_KEY = 'Mergeproof-Verdict';

const FIELDS = ['pr', 'kind', 'agent', 'model', 'skill', 'attempts'];
const NUMERIC = new Set(['pr', 'attempts']);
const VALUE = /^[^\s=]+$/;

export function formatTrailer(fields) {
  const parts = ['merge'];
  for (const key of FIELDS) {
    const value = fields[key];
    if (value === undefined || value === null) continue;
    const s = String(value);
    if (!VALUE.test(s)) throw new TypeError(`trailer field ${key} must not contain spaces or "=": ${JSON.stringify(s)}`);
    parts.push(`${key}=${s}`);
  }
  return `${TRAILER_KEY}: ${parts.join(' ')}`;
}

/** The last Mergeproof-Verdict trailer in a commit message, or null. */
export function parseTrailer(commitMessage) {
  const lines = String(commitMessage).split(/\r?\n/).filter((l) => l.startsWith(`${TRAILER_KEY}:`));
  if (lines.length === 0) return null;
  const [verdict, ...pairs] = lines.at(-1).slice(TRAILER_KEY.length + 1).trim().split(/\s+/);
  const out = { verdict };
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    out[key] = NUMERIC.has(key) && /^\d+$/.test(value) ? Number(value) : value;
  }
  return out;
}
