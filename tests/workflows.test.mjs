// The M2 GitHub Action and workflow templates: structure and safety
// invariants, checked with plain string parsing (zero dependencies, so no
// YAML parser — a small indentation-based splitter stands in for one).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ACTION = readFileSync(resolve('action.yml'), 'utf8');
const TEMPLATE_DIR = resolve('templates/workflows');
const TEMPLATE_FILES = ['mergeproof-pr.yml', 'mergeproof-issue.yml', 'mergeproof-sync.yml'];
const TEMPLATES = Object.fromEntries(TEMPLATE_FILES.map((f) => [f, readFileSync(resolve(TEMPLATE_DIR, f), 'utf8')]));
const FILES = { 'action.yml': ACTION, ...TEMPLATES };

// Event fields that carry user-controlled text. They may be interpolated in
// `with:`/`env:` context but never inside a `run:` script (script injection).
const USER_TEXT = [
  'github.event.issue.title',
  'github.event.issue.body',
  'github.event.pull_request.title',
  'github.event.pull_request.body',
  'github.event.comment.body',
  'github.event.pull_request.head_ref',
  'head_ref',
  'pull_request.title',
];

/**
 * Every `run: |` block in a workflow or action file: the lines between the
 * `run: |` marker and the first line indented no deeper than it.
 */
function runBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let current = null;
  let indent = 0;
  for (const line of lines) {
    const m = /^(\s*)run: \|/.exec(line);
    if (m) {
      current = [];
      indent = m[1].length;
      blocks.push(current);
      continue;
    }
    if (current && (line.trim() === '' || (line.match(/^\s*/) ?? [''])[0].length > indent)) current.push(line);
    else if (current && line.trim() !== '') current = null;
  }
  return blocks.map((b) => b.join('\n'));
}

/**
 * Split a workflow into its top-level `jobs:` entries by indentation:
 * job names sit at exactly two spaces, job bodies deeper.
 */
function jobsOf(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  assert.ok(start >= 0, 'workflow must have a top-level jobs: block');
  const jobs = {};
  let name = null;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // the next top-level key ends the jobs block
    const m = /^ {2}(\S+):\s*(?:#.*)?$/.exec(line);
    if (m) {
      name = m[1];
      jobs[name] = [];
      continue;
    }
    if (name !== null) jobs[name].push(line);
  }
  return Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, v.join('\n')]));
}

const jobIf = (jobText) => /^ {4}if: (.+)$/m.exec(jobText)?.[1] ?? null;

const PR_JOBS = jobsOf(TEMPLATES['mergeproof-pr.yml']);
const ISSUE_JOBS = jobsOf(TEMPLATES['mergeproof-issue.yml']);
const SYNC_JOBS = jobsOf(TEMPLATES['mergeproof-sync.yml']);

test('templates/workflows/ exists and ships the three templates', () => {
  assert.ok(existsSync(TEMPLATE_DIR), 'templates/workflows/ must exist');
  for (const name of TEMPLATE_FILES) {
    assert.ok(existsSync(resolve(TEMPLATE_DIR, name)), `missing templates/workflows/${name}`);
  }
});

test('action.yml is a composite action that validates the command', () => {
  assert.match(ACTION, /using: '?composite'?/);
  assert.match(ACTION, /command:/);
  const validate = runBlocks(ACTION).find((b) => b.includes('MERGEPROOF_COMMAND') && b.includes('case'));
  assert.ok(validate, 'action.yml must validate the command against check | apply | sync');
  assert.match(validate, /check/);
  assert.match(validate, /apply/);
  assert.match(validate, /sync/);
});

test('action.yml passes args through the environment and runs the repo binary', () => {
  assert.match(ACTION, /MERGEPROOF_ARGS: \$\{\{ inputs\.args \}\}/, 'args belong in env:, not in run:');
  for (const block of runBlocks(ACTION)) {
    assert.doesNotMatch(block, /\$\{\{ inputs\.args/, 'inputs.args must never be interpolated inside run:');
  }
  const run = runBlocks(ACTION).find((b) => b.includes('bin/mergeproof.mjs'));
  assert.ok(run, 'action.yml must run bin/mergeproof.mjs');
  assert.match(run, /read -ra|set --/, 'args must be split without shell expansion');
  assert.match(run, /GITHUB_ACTION_PATH/);
});

for (const [file, text] of Object.entries(TEMPLATES)) {
  test(`${file}: every job starts with the MERGEPROOF_MODE kill switch`, () => {
    const jobs = jobsOf(text);
    assert.ok(Object.keys(jobs).length > 0, `${file} must have jobs`);
    for (const [name, body] of Object.entries(jobs)) {
      const cond = jobIf(body);
      assert.ok(cond, `${file}: job ${name} needs an if:`);
      assert.ok(cond.startsWith("vars.MERGEPROOF_MODE != 'off'"), `${file}: job ${name} must check the kill switch first`);
    }
  });

  test(`${file}: every multi-line run uses set -euo pipefail`, () => {
    for (const block of runBlocks(text)) {
      const first = block.split('\n').find((l) => l.trim() !== '');
      assert.match(first ?? '', /set -euo pipefail/, `${file}: every run: | block must start with set -euo pipefail`);
    }
  });

  test(`${file}: no user-controlled event text inside any run: block`, () => {
    for (const block of runBlocks(text)) {
      for (const banned of USER_TEXT) {
        assert.ok(!block.includes(banned), `${file}: ${banned} must not appear inside run: (pass it through env:)`);
      }
    }
  });
}

test('pr workflow: top-level permissions are empty and each job declares its own', () => {
  assert.match(TEMPLATES['mergeproof-pr.yml'], /^permissions: \{\}/m);
  assert.match(PR_JOBS.context, /pull-requests: read/);
  assert.match(PR_JOBS.context, /issues: read/);
});

test('pr workflow: triggered by workflow_run, never by pull_request', () => {
  const pr = TEMPLATES['mergeproof-pr.yml'];
  assert.match(pr, /^ {2}workflow_run:/m);
  assert.match(pr, /^ {2}workflow_dispatch:/m);
  assert.doesNotMatch(pr, /^ {2}pull_request:/m, 'a pull_request trigger would run the PR\'s edited copy of the workflow');
  assert.match(
    pr,
    /github\.event\.workflow_run\.event (==|!=) 'pull_request'/,
    'non-pull_request CI runs are skipped',
  );
});

test('pr workflow: the context job trusts only github-actions[bot] comments', () => {
  const ctx = PR_JOBS.context;
  assert.ok(ctx, 'pr workflow needs a context job');
  assert.match(ctx, /select\(\.user\.login == "github-actions\[bot\]"\)/);
  assert.match(ctx, /<!-- mergeproof-dispatch/);
  assert.match(ctx, /Mergeproof — RETRY/, 'the attempt count comes from bot-authored RETRY comments');
  assert.match(ctx, /GH_TOKEN: \$\{\{ github\.token \}\}/);
});

test('pr workflow: the gate job is read-only and writes the verdict file', () => {
  const gate = PR_JOBS.gate;
  assert.ok(gate, 'pr workflow needs a gate job');
  assert.match(gate, /persist-credentials: false/);
  assert.doesNotMatch(gate, /: write/, 'the gate job must hold no write permission');
  assert.doesNotMatch(gate, /secrets\./, 'the gate job must see no secrets');
  assert.match(gate, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(gate, /command: check/);
  assert.match(gate, /--verdict-out/);
  assert.match(gate, /\{\{INSTALL_COMMAND\}\}/, 'the gate job installs the repo dependencies for the proof');
  assert.match(gate, /upload-artifact/, 'the verdict file is uploaded for the apply job');
});

test('pr workflow: the apply job lands the verdict and never installs anything', () => {
  const apply = PR_JOBS.apply;
  assert.ok(apply, 'pr workflow needs an apply job');
  assert.match(apply, /command: apply/);
  assert.match(apply, /--pr \$\{\{ needs\.context\.outputs\.pr-url \}\}/, 'the PR comes from the event, not from the artifact');
  assert.doesNotMatch(apply, /\{\{INSTALL_COMMAND\}\}/, 'the apply job must never run an install command');
  assert.match(apply, /GH_TOKEN: \$\{\{ secrets\.MERGEPROOF_BOT_TOKEN \}\}/, 'the merge uses the bot token so it triggers the push CI');
  assert.match(apply, /group: mergeproof-ledger/);
  assert.match(apply, /cancel-in-progress: false/);
  assert.match(apply, /gh workflow run mergeproof-issue\.yml/, 'RETRY re-dispatches the agent');
  assert.match(apply, /--add-label needs-human/, 'exhausted retries label the PR needs-human');
});

test('issue workflow: gates who may start the agent', () => {
  const issue = TEMPLATES['mergeproof-issue.yml'];
  const agent = ISSUE_JOBS.agent;
  assert.ok(agent, 'issue workflow needs an agent job');
  assert.match(issue, /github\.event\.issue\.user\.type != 'Bot'/, 'Bot authors never start a run');
  assert.match(issue, /vars\.MERGEPROOF_AUTHORS/, 'opened issues need an allowlisted author');
  assert.match(issue, /github\.event\.label\.name == 'agent'/, 'label starts need the agent label');
  assert.match(issue, /collaborators\/\$SENDER\/permission/, 'label starts check the collaborator permission');
  assert.match(issue, /admin \| maintain \| write/, 'only write, maintain or admin may start via label');
});

test('issue workflow: daily cap and dispatch marker', () => {
  const issue = TEMPLATES['mergeproof-issue.yml'];
  assert.match(issue, /gh run list --workflow mergeproof-issue\.yml --created/);
  assert.match(issue, /MERGEPROOF_DAILY_LIMIT/);
  assert.match(issue, /<!-- mergeproof-dispatch issue=\$ISSUE_NUMBER skill=\$SKILL -->/);
  assert.match(issue, /GH_TOKEN: \$\{\{ github\.token \}\}/, 'the marker is posted with the default token (author github-actions[bot])');
  assert.match(issue, /anthropics\/claude-code-action@/);
  assert.match(issue, /ANTHROPIC_BASE_URL: \$\{\{ vars\.MERGEPROOF_MODEL_BASE_URL \}\}/);
  for (const input of ['anthropic_api_key', 'github_token', 'claude_args', 'prompt']) {
    assert.match(issue, new RegExp(`${input}:`), `the agent step must keep its ${input} input`);
  }
});

test('sync workflow: nightly, on the shared ledger concurrency group', () => {
  const sync = TEMPLATES['mergeproof-sync.yml'];
  assert.match(sync, /^ {2}schedule:/m);
  assert.match(sync, /cron: '/);
  assert.match(sync, /group: mergeproof-ledger/);
  assert.match(sync, /cancel-in-progress: false/);
  assert.match(sync, /command: sync/);
  assert.match(sync, /--ledger \.mergeproof-ledger\/ledger\.json/);
});

test('every action is pinned by a full commit SHA, except the agent harness and mergeproof itself', () => {
  // anthropics/claude-code-action moves too fast to ship a stable SHA in a
  // template (customers pin the one they audit); ahmed-3m/mergeproof is
  // referenced by its release tag because the templates ship inside it.
  const TAG_ALLOWED = ['anthropics/claude-code-action', 'ahmed-3m/mergeproof'];
  for (const [file, text] of Object.entries(FILES)) {
    const refs = [...text.matchAll(/uses: (\S+)/g)].map((m) => m[1]);
    assert.ok(refs.length > 0, `${file} must use at least one action`);
    for (const ref of refs) {
      if (TAG_ALLOWED.some((a) => ref.startsWith(a))) continue;
      assert.match(ref, /@[0-9a-f]{40}$/, `${file}: ${ref} must be pinned by a 40-hex commit SHA`);
    }
  }
});
