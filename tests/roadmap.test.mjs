// `mergeproof roadmap`: parsing, dedupe and the command pipeline, with a
// fake `gh` (no network) and an injectable file reader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseRoadmap, planIssues, ROADMAP_MARKER, TITLE_MAX, BODY_MAX } from '../src/roadmap.mjs';
import { runRoadmap, defaultDeps } from '../src/commands/roadmap.mjs';
import { EXIT_CODES } from '../src/verdict.mjs';
import { USAGE } from '../src/cli.mjs';

const DOC = `# Roadmap

Intro text before any item.

### [MP-001] Add a thing
- kind: feature
- status: ready

Context line one.
Context line two.

Acceptance:
- it works
- it is tested

### [MP-002] Fix a bug
- kind: bugfix
- status: later

Body of the second.

### Not an item heading
Still part of MP-002's body, to the end of the file.
`;

// Four items, two ready, so --limit and dedupe have something to bite on.
const PLAN_DOC = `### [MP-011] Ready one
- kind: feature
- status: ready

Body one.

### [MP-012] Ready two
- kind: bugfix
- status: ready

Body two.

### [MP-013] Later
- kind: feature
- status: later

Body three.

### [MP-014] Done
- kind: feature
- status: done

Body four.
`;

// ---- parse ----------------------------------------------------------------

test('parseRoadmap reads items, fields and bodies', () => {
  const { items, errors } = parseRoadmap(DOC);
  assert.deepEqual(errors, []);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    id: 'MP-001',
    title: 'Add a thing',
    kind: 'feature',
    status: 'ready',
    body: 'Context line one.\nContext line two.\n\nAcceptance:\n- it works\n- it is tested',
  });
  assert.deepEqual(items[1], { id: 'MP-002', title: 'Fix a bug', kind: 'bugfix', status: 'later', body: 'Body of the second.\n\n### Not an item heading\nStill part of MP-002\'s body, to the end of the file.' });
});

test('a fenced format example is never items, before or inside an item', () => {
  const doc = [
    '## Format',
    '',
    '```markdown',
    '### [MP-012] Example title',
    '- kind: feature',
    '- status: ready',
    '',
    'Body.',
    '```',
    '',
    '### [MP-101] Real item',
    '- kind: feature',
    '- status: ready',
    '',
    'Real body.',
    '',
    '```text',
    '### [MP-999] Fenced inside a body',
    '```',
    '',
    'Still the real body.',
  ].join('\n');
  const { items, errors } = parseRoadmap(doc);
  assert.deepEqual(errors, []);
  assert.deepEqual(items.map((i) => i.id), ['MP-101']);
  assert.match(items[0].body, /Fenced inside a body/);
  assert.match(items[0].body, /Still the real body\.$/);
});

test('field lines allow a trailing comment and stop at the first body line', () => {
  const { items, errors } = parseRoadmap('### [MP-003] Docs item\n- kind: docs   # trailing explanation\n- status: done\nBody directly after the fields.\n- kind: body text, not a field\n');
  assert.deepEqual(errors, []);
  assert.deepEqual(items[0].kind, 'docs');
  assert.deepEqual(items[0].status, 'done');
  assert.equal(items[0].body, 'Body directly after the fields.\n- kind: body text, not a field');
});

test('parseRoadmap reports every error kind with its line', () => {
  const doc = [
    '### [BAD] Bad id', // 1: not <PREFIX>-<digits>
    '- kind: feature',
    '- status: ready',
    '',
    '### [MP-001] One', // 5
    '- kind: nope', // 6: unknown kind
    '- status: someday', // 7: unknown status
    '',
    '### [MP-001] Two', // 9: duplicate id, and missing both fields
    '',
    '### [MP-002]', // 11: no title
    '- kind: docs',
    '- status: done',
  ].join('\n');
  const { items, errors } = parseRoadmap(doc);
  assert.deepEqual(items, [], 'items with errors are reported, not returned');
  assert.deepEqual(
    errors.map((e) => /^line (\d+):/.exec(e)?.[1]),
    ['1', '6', '7', '9', '9', '9', '11'],
    ['bad id', 'unknown kind', 'unknown status', 'duplicate id', 'missing kind', 'missing status', 'missing title'].map((why, i) => `${why} — ${errors[i]}`),
  );
});

test('a #/## section heading ends the previous body and never starts an item', () => {
  const doc = '### [MP-031] First\n- kind: feature\n- status: ready\n\nFirst body.\n\n## Phase Z — next steps\n\nIntro of the section.\n\n### Subheading, still not an item\n\n### [MP-032] Second\n- kind: docs\n- status: done\n\nSecond body.\n';
  const { items, errors } = parseRoadmap(doc);
  assert.deepEqual(errors, []);
  assert.deepEqual(items.map((i) => i.id), ['MP-031', 'MP-032']);
  assert.equal(items[0].body, 'First body.', 'the section header and everything after it belong to no item');
  assert.equal(items[1].body, 'Second body.');
});

test('ROADMAP_MARKER is one exact line per id, with no prefix collisions', () => {
  assert.equal(ROADMAP_MARKER('MP-012'), '<!-- mergeproof-roadmap id=MP-012 -->');
  const bodies = [ROADMAP_MARKER('MP-1')];
  assert.ok(!bodies.some((b) => b.includes(ROADMAP_MARKER('MP-11'))), 'id=MP-1 never matches id=MP-11');
});

// ---- plan -----------------------------------------------------------------

test('planIssues maps ready items to titled, labeled, marker-ended issues', () => {
  const { items } = parseRoadmap(PLAN_DOC);
  const plan = planIssues(items, []);
  assert.deepEqual(plan.map((p) => p.id), ['MP-011', 'MP-012']);
  assert.deepEqual(plan[0], {
    id: 'MP-011',
    title: '[MP-011] Ready one',
    body: `Body one.\n\n${ROADMAP_MARKER('MP-011')}`,
    labels: ['agent-proposed'],
  });
  assert.deepEqual(plan[1].labels, ['agent-proposed', 'bug'], 'a bugfix carries the bug label');
});

test('planIssues dedupes against open AND closed issues', () => {
  const { items } = parseRoadmap(PLAN_DOC);
  const withMarker = (id, state) => ({ number: 7, title: 'whatever', state, author: { login: 'app/github-actions' }, body: `finished\n\n${ROADMAP_MARKER(id)}` });
  assert.deepEqual(planIssues(items, [withMarker('MP-011', 'open')]).map((p) => p.id), ['MP-012'], 'an open issue suppresses its item');
  assert.deepEqual(planIssues(items, [withMarker('MP-012', 'closed')]).map((p) => p.id), ['MP-011'], 'a closed issue suppresses its item too');
  assert.deepEqual(planIssues(items, [{ number: 8, title: 't', state: 'open', body: null }]).map((p) => p.id), ['MP-011', 'MP-012'], 'a null body is just no marker');
});

test('planIssues counts a marker only in an issue the proposer opened', () => {
  const { items } = parseRoadmap(PLAN_DOC);
  const issue = (login) => ({ number: 9, title: 'x', state: 'open', author: { login }, body: ROADMAP_MARKER('MP-011') });
  const ids = (issues, opts) => planIssues(items, issues, opts).map((p) => p.id);
  assert.deepEqual(ids([issue('mallory')]), ['MP-011', 'MP-012'], 'a marker pasted by anyone else suppresses nothing');
  assert.deepEqual(ids([issue('dependabot[bot]')]), ['MP-011', 'MP-012'], 'nor one from another bot');
  assert.deepEqual(ids([issue('github-actions[bot]')]), ['MP-012'], 'the REST spelling of the workflow token counts');
  assert.deepEqual(ids([issue('app/github-actions')]), ['MP-012'], "and so does gh's");
  assert.deepEqual(ids([issue('octocat')], { proposer: 'OctoCat' }), ['MP-012'], '--proposer names a local runner, case-insensitively');
  assert.deepEqual(ids([{ number: 9, title: 'x', state: 'open', body: ROADMAP_MARKER('MP-011') }]), ['MP-011', 'MP-012'], 'no author, no dedupe');
});

test('titles and bodies are capped and the marker survives the cap', () => {
  const items = [{ id: 'MP-021', title: 'T'.repeat(TITLE_MAX + 50), kind: 'feature', status: 'ready', body: 'B'.repeat(BODY_MAX + 50) }];
  const [plan] = planIssues(items, []);
  assert.equal(plan.title.length, TITLE_MAX);
  assert.ok(plan.title.endsWith('...'));
  assert.ok(plan.body.length <= BODY_MAX);
  assert.ok(plan.body.endsWith(`\n\n${ROADMAP_MARKER('MP-021')}`), 'the dedupe marker is never truncated away');
});

// ---- the command ----------------------------------------------------------

function fakeGh({ issues = [], labelError = null } = {}) {
  const calls = { repoView: 0, list: [], label: [], issue: [] };
  return {
    calls,
    // No edit or close method exists at all: calling one would throw.
    repoView() {
      calls.repoView++;
      return { repo: 'acme/app', defaultBranch: 'main' };
    },
    listIssues: (opts) => (calls.list.push(opts), issues),
    createLabel: (o) => {
      calls.label.push(o);
      if (labelError) throw new Error(labelError);
    },
    createIssue: (o) => (calls.issue.push(o), `https://github.com/acme/app/issues/${100 + calls.issue.length}`),
  };
}

function depsFor(files, gh, out) {
  return { ...defaultDeps, gh, print: (s) => out.push(s), readFile: (f) => (f in files ? files[f] : null) };
}

test('runRoadmap opens one labeled issue per not-yet-proposed ready item', async () => {
  const gh = fakeGh({ issues: [{ number: 3, title: 'old', state: 'closed', body: 'an unrelated closed issue' }] });
  const out = [];
  assert.equal(await runRoadmap([], depsFor({ 'ROADMAP.md': PLAN_DOC }, gh, out)), 0, out.join('\n'));
  assert.deepEqual(gh.calls.list, [{ state: 'all', limit: 1000 }], 'one listing, open and closed');
  assert.deepEqual(gh.calls.issue.map((i) => i.repo), ['acme/app', 'acme/app']);
  assert.deepEqual(gh.calls.issue.map((i) => i.title), ['[MP-011] Ready one', '[MP-012] Ready two']);
  assert.deepEqual(gh.calls.issue.map((i) => i.labels), [['agent-proposed'], ['agent-proposed', 'bug']]);
  assert.ok(gh.calls.issue.every((i) => i.body.endsWith(ROADMAP_MARKER(i.title.slice(1, i.title.indexOf(']'))))));
  assert.deepEqual(
    gh.calls.label.map((l) => l.name).sort(),
    ['agent-proposed', 'bug'],
    'every label the opened issues need is ensured first',
  );
  assert.deepEqual(
    out,
    ['opened #101 [MP-011] Ready one', 'opened #102 [MP-012] Ready two', 'Mergeproof roadmap — 2 opened, 0 already proposed, 0 deferred to the next run, 2 not ready'],
  );
});

test('a listing that may be cut short opens nothing (fail closed)', async () => {
  const gh = fakeGh({ issues: Array.from({ length: 1000 }, (_, i) => ({ number: i + 1, title: 't', body: '' })) });
  const out = [];
  await assert.rejects(runRoadmap([], depsFor({ 'ROADMAP.md': PLAN_DOC }, gh, out)), /at least 1000 issues/);
  assert.equal(gh.calls.issue.length, 0);
  assert.equal(gh.calls.label.length, 0);
});

test('--limit caps how many issues one run opens, in file order', async () => {
  const gh = fakeGh();
  const out = [];
  assert.equal(await runRoadmap(['--limit', '1'], depsFor({ 'ROADMAP.md': PLAN_DOC }, gh, out)), 0, out.join('\n'));
  assert.deepEqual(gh.calls.issue.map((i) => i.title), ['[MP-011] Ready one']);
  assert.match(out.at(-1), /1 opened, 0 already proposed, 1 deferred to the next run, 2 not ready/);
  await assert.rejects(runRoadmap(['--limit', '0'], depsFor({ 'ROADMAP.md': PLAN_DOC }, gh, out)), /--limit must be a whole number from 1 to 20/);
  await assert.rejects(runRoadmap(['--limit', '21'], depsFor({ 'ROADMAP.md': PLAN_DOC }, gh, out)), /--limit must be a whole number from 1 to 20/);
  await assert.rejects(runRoadmap(['--limit'], depsFor({ 'ROADMAP.md': PLAN_DOC }, gh, out)), /--limit needs a value/);
  await assert.rejects(runRoadmap(['extra'], depsFor({ 'ROADMAP.md': PLAN_DOC }, gh, out)), /roadmap takes no arguments/);
});

test('--dry-run prints what it would open and writes nothing', async () => {
  const gh = fakeGh();
  const out = [];
  assert.equal(await runRoadmap(['--dry-run'], depsFor({ 'ROADMAP.md': PLAN_DOC }, gh, out)), 0, out.join('\n'));
  assert.deepEqual([gh.calls.issue.length, gh.calls.label.length, gh.calls.repoView], [0, 0, 0], 'no writes and no repoView');
  assert.deepEqual(out, ['would open [MP-011] Ready one', 'would open [MP-012] Ready two', 'Mergeproof roadmap — 2 to open, 0 already proposed, 0 deferred to the next run, 2 not ready']);
});

test('a missing roadmap file is a one-line no-op, exit 0, no gh call', async () => {
  const gh = fakeGh();
  const out = [];
  assert.equal(await runRoadmap([], depsFor({}, gh, out)), 0);
  assert.deepEqual(out, ['Mergeproof roadmap — no ROADMAP.md; nothing to do']);
  assert.deepEqual([gh.calls.list.length, gh.calls.issue.length, gh.calls.repoView], [0, 0, 0]);
  // --file picks another path, and the note names it.
  assert.equal(await runRoadmap(['--file', 'docs/ROADMAP.md'], depsFor({}, gh, out)), 0);
  assert.equal(out.at(-1), 'Mergeproof roadmap — no docs/ROADMAP.md; nothing to do');
});

test('parse errors list every line, exit with the usage code and open nothing', async () => {
  const bad = '### [MP-001] One\n- kind: nope\n- status: ready\n\n### [MP-001] Two\n- kind: feature\n';
  const gh = fakeGh();
  const out = [];
  assert.equal(await runRoadmap(['--file', 'BACKLOG.md'], depsFor({ 'BACKLOG.md': bad }, gh, out)), EXIT_CODES.USAGE);
  assert.equal(out.length, 1);
  assert.match(out[0], /BACKLOG\.md: line 2: \[MP-001\] has unknown kind "nope"/);
  assert.match(out[0], /BACKLOG\.md: line 5: duplicate id MP-001/);
  assert.match(out[0], /BACKLOG\.md: line 5: \[MP-001\] is missing "- status/);
  assert.deepEqual([gh.calls.list.length, gh.calls.issue.length, gh.calls.label.length, gh.calls.repoView], [0, 0, 0, 0], 'not even a listing');
});

test('an "already exists" label is tolerated; any other label error fails the run', async () => {
  const tolerant = fakeGh({ labelError: 'gh label create failed: name already exists' });
  const out = [];
  assert.equal(await runRoadmap([], depsFor({ 'ROADMAP.md': PLAN_DOC }, tolerant, out)), 0, out.join('\n'));
  assert.equal(tolerant.calls.issue.length, 2, 'issues still open');

  const broken = fakeGh({ labelError: 'gh label create failed: no permission' });
  await assert.rejects(runRoadmap([], depsFor({ 'ROADMAP.md': PLAN_DOC }, broken, [])), /no permission/);
  assert.equal(broken.calls.issue.length, 0);
});

test('--json prints the counts and the opened issues', async () => {
  const gh = fakeGh();
  const out = [];
  assert.equal(await runRoadmap(['--json', '--dry-run'], depsFor({ 'ROADMAP.md': PLAN_DOC }, gh, out)), 0);
  const obj = JSON.parse(out.join('\n'));
  assert.deepEqual(
    ['file', 'dryRun', 'items', 'ready', 'alreadyProposed', 'deferred', 'notReady', 'opened', 'planned'],
    Object.keys(obj),
  );
  assert.deepEqual([obj.items, obj.ready, obj.alreadyProposed, obj.notReady], [4, 2, 0, 2]);
  assert.deepEqual(obj.opened, []);
  assert.deepEqual(obj.planned.map((p) => p.id), ['MP-011', 'MP-012']);
});

// ---- the shipped surface --------------------------------------------------

test('usage lists the roadmap command', () => {
  assert.match(USAGE, /mergeproof roadmap \[--file ROADMAP\.md\] \[--limit <n>\] \[--proposer <login>\] \[--dry-run\] \[--json\]/);
});

test('this repo\'s ROADMAP.md parses cleanly', () => {
  // Shape only: which items are ready changes with every roadmap edit, and
  // pinning it here would make each of those edits a test change too.
  const { items, errors } = parseRoadmap(readFileSync(resolve('ROADMAP.md'), 'utf8'));
  assert.deepEqual(errors, []);
  assert.ok(items.length > 0);
  assert.ok(items.some((i) => i.status === 'ready'), 'at least one item is ready to propose');
  assert.ok(items.every((i) => i.body.includes('Acceptance:') && i.body.split('\n').length >= 3), 'every item carries context and an acceptance list');
});
