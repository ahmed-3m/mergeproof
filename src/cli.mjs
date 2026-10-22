import { VERSION } from './version.mjs';
import { EXIT_CODES } from './verdict.mjs';
import { NotImplementedError, UsageError } from './errors.mjs';
import { runCheck } from './commands/check.mjs';
import { runApply } from './commands/apply.mjs';
import { runSync } from './commands/sync.mjs';
import { runInit } from './commands/init.mjs';

const COMMANDS = { check: runCheck, apply: runApply, sync: runSync, init: runInit };

export const USAGE = `mergeproof v${VERSION} — let AI agents merge, only with proof

Usage:
  mergeproof check <pr-url> [--dry-run] [--json]   gate a pull request
  mergeproof check --local [--base <ref>] [--json] preflight HEAD against its base (agents run this)
  mergeproof apply <verdict-file> --pr <pr-url> [--dry-run] [--json]  land a gate verdict (write job; runs no PR code)
  mergeproof sync [--dry-run] [--json]             settle the ledger and record reverts
  mergeproof init [--dry-run] [--yes] [--force] [--json]
                  [--agent <name>] [--model <name>] [--base-url <url>] [--bot-login <login>]
                  [--ci-workflow <name>] [--install-command <cmd>] [--test-command <cmd>]
                                                  install mergeproof into this repo (M2)
  mergeproof --version | --help

Options:
  --agent <name> --model <name>   trust bucket (set by the workflow, never by the PR; apply requires both)
  --skill <name> --attempt <n>    logged with the outcome; apply must get the gate job's values
  --issue <n>                     issue the agent was dispatched for; its bugfix label picks the bucket
  --head <sha>                    check/apply: the head whose CI completed; a PR that moved since stands down for its own new run
  --verdict-out <file>            check: write the verdict for an apply job, write nothing to GitHub
  --ledger <path>                 default .mergeproof/ledger.json
  --ref <ref>                     sync: branch whose history is scanned (default HEAD)
  --bot-login <login>             init: login of the machine user whose token opens agent PRs (required)
  --base-url <url>                init: Anthropic-compatible endpoint (defaulted for glm-* models)
  --ci-workflow <name>            init: workflow whose PR CI the gate waits for (auto-detected)
  --install-command <cmd>         init: dependency install the gate job runs (auto-detected from the lockfile)
  --test-command <cmd>            init: test command for proof runs (auto-detected from scripts.test)
  --yes                           init: apply the remote changes without asking

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
