import { VERSION } from './version.mjs';
import { EXIT_CODES } from './verdict.mjs';
import { NotImplementedError, UsageError } from './errors.mjs';
import { runCheck } from './commands/check.mjs';
import { runSync } from './commands/sync.mjs';

const COMMANDS = { check: runCheck, sync: runSync };

export const USAGE = `mergeproof v${VERSION} — let AI agents merge, only with proof

Usage:
  mergeproof check <pr-url> [--dry-run] [--json]   gate a pull request
  mergeproof check --local [--base <ref>] [--json] preflight HEAD against its base (agents run this)
  mergeproof sync [--dry-run] [--json]             settle the ledger and record reverts
  mergeproof --version | --help

Options:
  --agent <name> --model <name>   trust bucket (set by the workflow, never by the PR)
  --skill <name> --attempt <n>    logged with the outcome
  --issue <n>                     issue the agent was dispatched for; its bugfix label picks the bucket
  --ledger <path>                 default .mergeproof/ledger.json
  --ref <ref>                     sync: branch whose history is scanned (default HEAD)

Exit codes: 0 MERGE, 3 RETRY, 4 HUMAN, 2 usage error, 1 other error`;

export async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(USAGE);
    return 0;
  }
  if (cmd === '--version' || cmd === '-v') {
    console.log(VERSION);
    return 0;
  }

  const handler = COMMANDS[cmd];
  if (!handler) {
    console.error(`mergeproof: unknown command "${cmd}"\n\n${USAGE}`);
    return EXIT_CODES.USAGE;
  }

  try {
    return await handler(rest);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`mergeproof ${cmd}: ${err.message}\n\n${USAGE}`);
      return EXIT_CODES.USAGE;
    }
    if (err instanceof NotImplementedError) {
      console.error(`mergeproof ${cmd} — not implemented yet (${err.feature})`);
      return EXIT_CODES.ERROR;
    }
    console.error(`mergeproof ${cmd}: ${err.message}`);
    return EXIT_CODES.ERROR;
  }
}
