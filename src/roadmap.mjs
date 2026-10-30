// ROADMAP.md parsing and the issue plan (pure, no I/O). `mergeproof roadmap`
// turns maintainer-written backlog items into proposed GitHub issues; the
// marker comment each issue carries is the dedupe key, matched against open
// AND closed issues so an item whose issue was finished is never re-proposed.

const ID_RE = /^[A-Z][A-Z0-9]{1,9}-\d{1,5}$/;
const KINDS = new Set(['feature', 'bugfix', 'refactor', 'docs']);
const STATUSES = new Set(['ready', 'later', 'done']);
// Only `### [ID]` headings start an item; a plain `### Section` heading is
// body text, so one item can span subsections. A `#`/`##` section heading
// ends the previous item's body (never starts one), so a phase header never
// leaks into the last item's issue body.
const ITEM_RE = /^###\s+\[([^\]]*)\]\s*(.*)$/;
const SECTION_RE = /^#{1,2}\s/;
const FIELD_RE = /^-\s*(kind|status):\s*(.*)$/;
// A fenced block (the format example at the top of the file) is never items.
const FENCE_RE = /^\s{0,3}(?:```|~~~)/;

export const TITLE_MAX = 256; // GitHub's issue title limit
export const BODY_MAX = 60000; // safely under GitHub's 65536-character body limit

/** The HTML comment every opened issue ends with; the dedupe key by id. */
export function ROADMAP_MARKER(id) {
  return `<!-- mergeproof-roadmap id=${id} -->`;
}

/**
 * Parse ROADMAP.md text into items plus one error string per problem, each
 * naming its line. An item with any error is reported but not returned: a
 * half-valid backlog must not turn into issues.
 */
export function parseRoadmap(text) {
  const items = [];
  const errors = [];
  const firstAt = new Map(); // id -> line of first definition
  let current = null; // { line, id, title, kind, status, body[], fields }
  let fence = false; // inside a ``` / ~~~ block: never an item start

  const finish = () => {
    if (!current) return;
    const { line, id, title, kind, status } = current;
    const before = errors.length;
    // A field error names the field's own line; anything else the heading's.
    const at = (n) => `line ${n ?? line}`;
    if (!ID_RE.test(id)) errors.push(`${at()}: "[${id}]" is not a roadmap id (want e.g. MP-012)`);
    else if (firstAt.has(id)) errors.push(`${at()}: duplicate id ${id} (first defined at line ${firstAt.get(id)})`);
    else firstAt.set(id, line);
    if (title === '') errors.push(`${at()}: [${id}] has no title`);
    if (kind === null) errors.push(`${at()}: [${id}] is missing "- kind: ..."`);
    else if (!KINDS.has(kind)) errors.push(`${at(current.kindLine)}: [${id}] has unknown kind "${kind}" (feature | bugfix | refactor | docs)`);
    if (status === null) errors.push(`${at()}: [${id}] is missing "- status: ..."`);
    else if (!STATUSES.has(status)) errors.push(`${at(current.statusLine)}: [${id}] has unknown status "${status}" (ready | later | done)`);
    if (errors.length === before) {
      items.push({ id, title, kind, status, body: current.body.join('\n').trim() });
    }
    current = null;
  };

  for (const [i, raw] of String(text).split(/\r?\n/).entries()) {
    const lineNo = i + 1;
    if (FENCE_RE.test(raw)) fence = !fence;
    if (!fence) {
      if (SECTION_RE.test(raw)) finish(); // a section heading ends the previous item
      const heading = ITEM_RE.exec(raw);
      if (heading) {
        finish();
        current = { line: lineNo, id: heading[1].trim(), title: heading[2].trim(), kind: null, status: null, body: [], fields: true };
        continue;
      }
    }
    if (!current) continue;
    if (current.fields) {
      const field = FIELD_RE.exec(raw);
      if (field) {
        // The documented format allows a trailing "# ..." explanation.
        const value = field[2].split('#')[0].trim();
        if (field[1] === 'kind' && current.kind === null) {
          current.kind = value;
          current.kindLine = lineNo;
        } else if (field[1] === 'status' && current.status === null) {
          current.status = value;
          current.statusLine = lineNo;
        }
        continue;
      }
      if (raw.trim() === '') continue; // a blank line may sit between fields and body
      current.fields = false; // the first body line ends the field block
    }
    current.body.push(raw);
  }
  finish();
  return { items, errors };
}

// The cap must never eat the marker: it is what the next run dedupes on.
function cappedBody(body, marker) {
  const full = `${body}\n\n${marker}`;
  if (full.length <= BODY_MAX) return full;
  return `${body.slice(0, BODY_MAX - marker.length - 2).trimEnd()}\n\n${marker}`;
}

/**
 * The issues to open, in file order: `ready` items whose marker appears in no
 * existing issue body — open or closed, the caller passes both. Each becomes
 * `{ id, title: '[MP-012] …', body, labels }` where labels carry `bug` only
 * for a bugfix (the gate's issue-label split).
 */
export function planIssues(items, existingIssues = []) {
  const bodies = (existingIssues ?? []).map((issue) => String(issue.body ?? ''));
  return items
    .filter((item) => item.status === 'ready' && !bodies.some((body) => body.includes(ROADMAP_MARKER(item.id))))
    .map((item) => {
      const fullTitle = `[${item.id}] ${item.title}`;
      const marker = ROADMAP_MARKER(item.id);
      return {
        id: item.id,
        title: fullTitle.length <= TITLE_MAX ? fullTitle : `${fullTitle.slice(0, TITLE_MAX - 3)}...`,
        body: cappedBody(item.body, marker),
        labels: item.kind === 'bugfix' ? ['agent-proposed', 'bug'] : ['agent-proposed'],
      };
    });
}
