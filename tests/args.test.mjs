import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFlags } from '../src/args.mjs';
import { UsageError } from '../src/errors.mjs';

test('splits positionals from known boolean flags', () => {
  const { positionals, flags } = parseFlags(['url', '--json'], ['json', 'dry-run']);
  assert.deepEqual(positionals, ['url']);
  assert.deepEqual(flags, { json: true, 'dry-run': false });
});

test('unknown flags are usage errors', () => {
  assert.throws(() => parseFlags(['--nope'], ['json']), UsageError);
});

test('value flags accept --name value and --name=value', () => {
  const { positionals, flags } = parseFlags(['--base', 'main', '--agent=claude-code', 'x'], ['json'], ['base', 'agent', 'model']);
  assert.deepEqual(positionals, ['x']);
  assert.deepEqual(flags, { json: false, base: 'main', agent: 'claude-code', model: null });
});

test('a value flag without a value is a usage error', () => {
  assert.throws(() => parseFlags(['--base'], [], ['base']), UsageError);
  assert.throws(() => parseFlags(['--base', '--json'], ['json'], ['base']), UsageError);
  assert.throws(() => parseFlags(['--json=1'], ['json']), UsageError);
});

test('-- ends flag parsing; the rest is positional', () => {
  const { positionals, flags } = parseFlags(['--json', '--', 'url', '--dry-run'], ['json', 'dry-run']);
  assert.deepEqual(positionals, ['url', '--dry-run']);
  assert.equal(flags.json, true);
  assert.equal(flags['dry-run'], false);
});
