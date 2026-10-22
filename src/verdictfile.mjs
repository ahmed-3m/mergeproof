import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { FileFormatError } from './errors.mjs';
import { KINDS } from './classify.mjs';
import { MAX_NOTES, VERDICTS } from './verdict.mjs';
import { parsePrUrl } from './adapters/gh.mjs';

// The verdict file `check --verdict-out` writes and `apply` lands. It is the
// handoff between the gate job, which runs PR code and must not write to
// GitHub, and the apply job, which can write but never runs PR code. The file
// is written in the job that ran PR code, so PR test code can rewrite it after
// the gate: every field in it is attacker-controlled. apply validates it
// strictly and re-derives everything but "the proof held" for itself.
export const VERDICT_FILE_SCHEMA = 'mergeproof-verdict@1';

// Note text is never posted by apply, and these bounds keep a forged file from
// smuggling bulk or formatting into anything that might quote it.
const MAX_NOTE_TEXT = 300;

const FIELDS = ['schema', 'url', 'pr', 'headSha', 'kind', 'verdict', 'notes', 'proven', 'agent', 'model', 'skill', 'attempts', 'issue'];

function validateVerdict(data, fail) {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) fail('verdict must be a JSON object');
  for (const key of FIELDS) if (!Object.hasOwn(data, key)) fail(`missing key "${key}"`);
  for (const key of Object.keys(data)) if (!FIELDS.includes(key)) fail(`unknown key "${key}"`);
  if (data.schema !== VERDICT_FILE_SCHEMA) fail(`schema must be "${VERDICT_FILE_SCHEMA}"`);
  if (typeof data.url !== 'string' || !parsePrUrl(data.url)) fail('url must be a pull request URL');
  const number = parsePrUrl(data.url).number;
  if (!Number.isInteger(data.pr) || data.pr < 1 || data.pr !== number) fail(`pr must be the PR number in the url (${number})`);
  if (typeof data.headSha !== 'string' || !/^[0-9a-f]{40}$/.test(data.headSha)) fail('headSha must be a 40-character hex commit sha');
  if (!Object.hasOwn(VERDICTS, data.verdict)) fail(`verdict must be one of ${Object.values(VERDICTS).join(' | ')}`);
  if (data.kind !== null && !KINDS.includes(data.kind)) fail(`kind must be one of ${KINDS.join(', ')} or null`);
  if (!Array.isArray(data.notes)) fail('notes must be an array');
  if (data.notes.length > MAX_NOTES) fail(`notes must have at most ${MAX_NOTES} entries`);
  data.notes.forEach((n, i) => {
    if (typeof n !== 'object' || n === null || typeof n.ok !== 'boolean' || typeof n.text !== 'string') {
      fail(`notes[${i}] must be { ok: boolean, text: string }`);
    }
    if (n.text.length > MAX_NOTE_TEXT) fail(`notes[${i}].text must be at most ${MAX_NOTE_TEXT} characters`);
    if (/[\u0000-\u001f\u007f`]/.test(n.text)) fail(`notes[${i}].text must not contain newlines, backticks or control characters`);
  });
  if (typeof data.proven !== 'boolean') fail('proven must be a boolean');
  if (!Number.isInteger(data.attempts) || data.attempts < 1) fail('attempts must be a positive integer');
  for (const key of ['agent', 'model', 'skill']) {
    if (data[key] !== null && typeof data[key] !== 'string') fail(`${key} must be a string or null`);
  }
  if (data.issue !== null && (!Number.isInteger(data.issue) || data.issue < 1)) fail('issue must be an issue number or null');
}

/** Read and strictly validate a verdict file; anything malformed is a FileFormatError. */
export function readVerdictFile(path) {
  const fail = (msg) => {
    throw new FileFormatError(path, msg);
  };
  if (!existsSync(path)) fail('file not found');
  let data;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(`not valid JSON (${err.message})`);
  }
  validateVerdict(data, fail);
  return data;
}

/** Write via a temp file and rename, like writeLedger, so a crash never leaves half a verdict. */
export function writeVerdictFile(path, data) {
  validateVerdict(data, (msg) => {
    throw new TypeError(msg);
  });
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, path);
}
