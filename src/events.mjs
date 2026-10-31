import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { FileFormatError } from './errors.mjs';
import { KINDS } from './classify.mjs';
import { VERDICTS } from './verdict.mjs';

// The events log (MP-107): one JSONL record per landing, so the agent's work
// can be measured (`mergeproof retro`, MP-109). Like the ledger it sits under
// .mergeproof/, which the tamper rules stop a PR from editing. It is
// measurement ONLY: nothing here ever feeds trustFor — the ledger is and
// stays the one source of trust (pinned by tests/events.test.mjs).
export const DEFAULT_EVENTS = '.mergeproof/events.jsonl';

// One event per landing:
//   { id, at, pr, issue, kind, agent, model, skill, attempt, verdict,
//     proven, reasons, tamperRules, held, mode, merged }
// Every field is re-derived by apply (or came from the workflow's flags),
// never copied from PR text, so an agent cannot write its own history. `id`
// is deterministic per landing (pr, head, attempt), so a re-landing, a
// concurrent job or a stale push can never double-count one landing.

// The fields every event must carry, whoever wrote it. Shape only; the
// semantics (re-derived, never PR text) live in the caller.
function validateEvent(e, where, fail) {
  if (typeof e !== 'object' || e === null || Array.isArray(e)) fail(`${where} must be an object`);
  if (typeof e.id !== 'string' || e.id.length === 0 || e.id.length > 200) fail(`${where}.id must be a non-empty string of at most 200 characters`);
  if (!Number.isInteger(e.pr) || e.pr < 1) fail(`${where}.pr must be a PR number`);
  if (!Object.hasOwn(VERDICTS, e.verdict)) fail(`${where}.verdict must be one of ${Object.values(VERDICTS).join(' | ')}`);
  if (e.kind !== undefined && e.kind !== null && !KINDS.includes(e.kind)) fail(`${where}.kind must be one of ${KINDS.join(', ')} or null`);
  if (e.attempt !== undefined && (!Number.isInteger(e.attempt) || e.attempt < 1)) fail(`${where}.attempt must be a positive integer`);
  for (const key of ['at']) if (e[key] !== undefined && typeof e[key] !== 'string') fail(`${where}.${key} must be a string`);
  for (const key of ['proven', 'merged', 'held']) if (e[key] !== undefined && typeof e[key] !== 'boolean') fail(`${where}.${key} must be a boolean`);
}

// JSONL: one JSON object per line. Blank lines are skipped (a log written
// with a trailing newline ends with one); anything else must be a valid
// event, so a corrupt log fails loudly instead of measuring garbage.
function parseEvents(text, fail) {
  const events = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const where = `line ${i + 1}`;
    let e;
    try {
      e = JSON.parse(line);
    } catch (err) {
      fail(`${where} is not valid JSON (${err.message})`);
    }
    validateEvent(e, where, fail);
    events.push(e);
  }
  return events;
}

const serializeEvents = (events) => (events.length > 0 ? `${events.map((e) => JSON.stringify(e)).join('\n')}\n` : '');

/** Read and validate an events log; a missing file is an empty log (nothing has landed yet). */
export function readEvents(path) {
  if (!existsSync(path)) return [];
  return parseEvents(readFileSync(path, 'utf8'), (msg) => {
    throw new FileFormatError(path, msg);
  });
}

/**
 * Append one event to the log atomically — read everything, write a `.tmp`
 * file, rename over the target, like writeLedger — and never twice: an event
 * whose `id` is already logged was already landed, so the log keeps exactly
 * one record per landing. Returns the log as it stands after the call.
 * @throws {TypeError} when the event is not a valid event shape.
 */
export function appendEvent(path, event) {
  validateEvent(event, 'event', (msg) => {
    throw new TypeError(msg);
  });
  const existing = readEvents(path);
  if (existing.some((e) => e.id === event.id)) return existing;
  const events = [...existing, event];
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, serializeEvents(events));
  renameSync(tmp, path);
  return events;
}

/**
 * Union-merge two JSONL texts by `id` (MP-108): every remote record is kept
 * untouched and in order — a stale push can never rewrite history — and a
 * local record joins the log only when the remote does not already have its
 * `id`, so two concurrent landings both survive with no duplicates. Invalid
 * JSONL on either side is a FileFormatError, never a silent drop.
 * @returns {string} the merged log as JSONL text.
 */
export function unionEvents(remoteText, localText) {
  const remote = parseEvents(remoteText ?? '', (msg) => {
    throw new FileFormatError('events.jsonl (remote)', msg);
  });
  const local = parseEvents(localText ?? '', (msg) => {
    throw new FileFormatError('events.jsonl (local)', msg);
  });
  const seen = new Set(remote.map((e) => e.id));
  const merged = [...remote];
  for (const e of local) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    merged.push(e);
  }
  return serializeEvents(merged);
}
