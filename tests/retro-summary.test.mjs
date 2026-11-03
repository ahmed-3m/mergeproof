// MP-110: the nightly sync writes the retro table to the run summary.
//
// Three layers are pinned:
// 1. the sync template has the retro step, wired through the action with
//    summary enabled, sitting after settle and before the ledger push;
// 2. the action gains a `summary` input whose run block appends stdout to
//    $GITHUB_STEP_SUMMARY only when enabled, through env indirection (no
//    ${{ }} interpolation of caller values inside run scripts);
// 3. the real chain works: executing the action's summary logic runs the
//    actual CLI and the retro table lands in the summary file byte-complete.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Read with newlines normalized: git may check the files out with CRLF on
// Windows, and the structure assertions are newline-based.
const ACTION = readFileSync(resolve('action.yml'), 'utf8').replace(/\r\n/g, '\n');
const SYNC = readFileSync(resolve('templates/workflows/mergeproof-sync.yml'), 'utf8').replace(/\r\n/g, '\n');

/** The action's whole "Run mergeproof" step (env + run), up to the next step. */
function actionRunBlock() {
  const start = ACTION.indexOf('name: Run mergeproof');
  const rest = ACTION.slice(start);
  const end = rest.indexOf('\n    - name:'); // the next step is at 4-space indent
  return rest.slice(0, end);
}

test('the sync template runs retro through the action with summary enabled', () => {
  // The step exists, after "Settle" and before "Commit and push".
  const settle = SYNC.indexOf('name: Settle the ledger');
  const push = SYNC.indexOf('name: Commit and push the ledger');
  const retro = SYNC.indexOf('name: Retro summary — mergeproof retro');
  assert.ok(retro > settle, 'retro step must come after settle');
  assert.ok(retro < push, 'retro step must come before the ledger push');
  const step = SYNC.slice(retro, push);
  assert.match(step, /command: retro/);
  assert.match(step, /args: --ledger \.mergeproof-ledger\/ledger\.json/);
  assert.match(step, /summary: 'true'/);
  // Runs through the action (target repos have no bin/), like every other
  // mergeproof step in the template.
  assert.match(step, /uses: ahmed-3m\/mergeproof@v1/);
});

test('the sync workflow takes on no new secret and no new permission', () => {
  // Permissions are pinned to the exact pre-MP-110 set.
  const m = SYNC.match(/permissions:\n((?:[ \t]+.+\n)+)/);
  assert.ok(m, 'sync template has a permissions block');
  assert.deepEqual(
    m[1]
      .trim()
      .split('\n')
      .map((s) => s.trim())
      .sort(),
    ['contents: write', 'issues: write', 'pull-requests: read'].sort(),
  );
  // No secrets.* references at all: sync authenticates with the workflow's
  // own github.token, and MP-110 adds no new credential.
  const secretRefs = [...SYNC.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((x) => x[1]);
  assert.deepEqual(secretRefs, []);
});

test("the action's run block appends to the summary only when summary is enabled", () => {
  const block = actionRunBlock();
  // Env indirection: caller values reach the script only via env vars.
  assert.match(block, /MERGEPROOF_SUMMARY: \$\{\{ inputs\.summary \}\}/);
  // Inside the run script itself, no caller value is interpolated.
  const script = block.slice(block.indexOf('run: |'));
  assert.doesNotMatch(script, /\$\{\{/);
  // The redirect is guarded: summary file present AND summary enabled.
  assert.match(block, /MERGEPROOF_SUMMARY" = 'true' \] && \[ -n "\$\{GITHUB_STEP_SUMMARY:-\}" \]/);
  assert.match(block, />> "\$target"/);
  // Output stays in the log when the summary file is unavailable; a notice
  // says so honestly instead of failing the step.
  assert.match(block, /GITHUB_STEP_SUMMARY is unset; output stays in the job log/);
  // The exit-code contract is unchanged.
  assert.match(block, /echo "exit-code=\$code" >> "\$GITHUB_OUTPUT"/);
});

test('executing the summary logic runs the real CLI and lands the table in the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-retro-summary-'));
  try {
    const events = join(dir, 'events.jsonl');
    const ledger = join(dir, 'ledger.json');
    const event = (over) =>
      JSON.stringify({
        id: '1:abc:1',
        at: '2026-10-01T00:00:00Z',
        pr: 1,
        issue: null,
        kind: 'bugfix',
        agent: 'claude-code',
        model: 'glm-5.2',
        skill: 'bugfix@4',
        attempt: 1,
        verdict: 'MERGE',
        proven: true,
        reasons: [],
        tamperRules: [],
        held: false,
        mode: 'enforce',
        merged: true,
        ...over,
      });
    writeFileSync(
      events,
      [
        event({}),
        event({ id: '2:abc:1', pr: 2, attempt: 1, verdict: 'HUMAN', proven: false, held: true, merged: false }),
      ].join('\n') + '\n',
      'utf8',
    );
    writeFileSync(ledger, JSON.stringify({ schema: 'mergeproof-ledger@1', outcomes: [] }, null, 2) + '\n', 'utf8');

    const summaryFile = join(dir, 'summary.md');
    const script = `set -euo pipefail
set -f
read -r -d '' -a argv <<< "\$MERGEPROOF_ARGS" || true
set +f
target=''
if [ "\$MERGEPROOF_SUMMARY" = 'true' ] && [ -n "\${GITHUB_STEP_SUMMARY:-}" ]; then
  target="\$GITHUB_STEP_SUMMARY"
elif [ "\$MERGEPROOF_SUMMARY" = 'true' ]; then
  echo '::notice::summary requested but GITHUB_STEP_SUMMARY is unset; output stays in the job log' >&2
fi
code=0
if [ -n "\$target" ]; then
  node "\$GITHUB_ACTION_PATH/bin/mergeproof.mjs" "\$MERGEPROOF_COMMAND" "\${argv[@]}" >> "\$target" || code=\$?
else
  node "\$GITHUB_ACTION_PATH/bin/mergeproof.mjs" "\$MERGEPROOF_COMMAND" "\${argv[@]}" || code=\$?
fi
echo "exit-code=\$code" >> "\$GITHUB_OUTPUT"
exit "\$code"
`;
    const res = spawnSync('bash', ['-c', script], {
      cwd: resolve('.'),
      encoding: 'buffer',
      timeout: 30000,
      env: {
        ...process.env,
        MERGEPROOF_COMMAND: 'retro',
        MERGEPROOF_ARGS: `--ledger ${ledger}`,
        MERGEPROOF_SUMMARY: 'true',
        GITHUB_STEP_SUMMARY: summaryFile,
        GITHUB_ACTION_PATH: resolve('.'),
        GITHUB_OUTPUT: join(dir, 'output'),
      },
    });
    assert.equal(res.status, 0, `bash script failed: ${res.stderr.toString()}`);
    const written = readFileSync(summaryFile, 'utf8');
    assert.match(written, /Mergeproof retro/);
    assert.match(written, /claude-code/);
    // exit-code landed in the output file too.
    assert.equal(readFileSync(join(dir, 'output'), 'utf8').trim(), 'exit-code=0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('summary=false keeps output in the log and writes no summary file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-retro-summary-false-'));
  try {
    const summaryFile = join(dir, 'summary.md');
    const script = `set -euo pipefail
set -f
read -r -d '' -a argv <<< "\$MERGEPROOF_ARGS" || true
set +f
target=''
if [ "\$MERGEPROOF_SUMMARY" = 'true' ] && [ -n "\${GITHUB_STEP_SUMMARY:-}" ]; then
  target="\$GITHUB_STEP_SUMMARY"
fi
code=0
if [ -n "\$target" ]; then
  node "\$GITHUB_ACTION_PATH/bin/mergeproof.mjs" "\$MERGEPROOF_COMMAND" "\${argv[@]}" >> "\$target" || code=\$?
else
  node "\$GITHUB_ACTION_PATH/bin/mergeproof.mjs" "\$MERGEPROOF_COMMAND" "\${argv[@]}" || code=\$?
fi
echo "exit-code=\$code" >> "\$GITHUB_OUTPUT"
exit "\$code"
`;
    const res = spawnSync('bash', ['-c', script], {
      cwd: resolve('.'),
      encoding: 'buffer',
      timeout: 30000,
      env: {
        ...process.env,
        MERGEPROOF_COMMAND: 'retro',
        MERGEPROOF_ARGS: '',
        MERGEPROOF_SUMMARY: 'false',
        GITHUB_STEP_SUMMARY: summaryFile,
        GITHUB_ACTION_PATH: resolve('.'),
        GITHUB_OUTPUT: join(dir, 'output'),
      },
    });
    assert.equal(res.status, 0);
    assert.ok(!readFileIfExists(summaryFile), 'no summary file may be written');
    assert.match(res.stdout.toString(), /Mergeproof retro/, 'output stays in the job log (stdout)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function readFileIfExists(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
