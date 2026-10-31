import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseFlags } from '../args.mjs';
import { UsageError } from '../errors.mjs';
import { DEFAULT_EVENTS, readEvents } from '../events.mjs';
import { DEFAULT_LEDGER, readLedger } from '../ledger.mjs';
import { summarize, formatRetro } from '../retro.mjs';

// `mergeproof retro` (MP-109): a read-only local summary of the events log —
// no network, no writes, no verdict. `--ledger` may name the ledger file, the
// directory that holds both `ledger.json` and `events.jsonl`, or nothing at
// all (the `.mergeproof/` defaults).

export const defaultDeps = {
  print: (s) => console.log(s),
  isDir: (p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
};

const DEFAULT_MIN_N = 5;

export async function runRetro(argv, deps = defaultDeps) {
  const { positionals, flags } = parseFlags(argv, ['json'], ['ledger', 'events', 'min-n']);
  if (positionals.length > 0) throw new UsageError('retro takes no arguments');
  let minN = DEFAULT_MIN_N;
  if (flags['min-n'] !== null) {
    minN = Number(flags['min-n']);
    if (!Number.isInteger(minN) || minN < 1) throw new UsageError('--min-n must be a positive integer');
  }

  // --events always wins; otherwise it follows --ledger: the directory that
  // holds the ledger holds the events log too, and no --ledger means the
  // .mergeproof/ defaults for both.
  let ledgerFile = resolve(DEFAULT_LEDGER);
  let eventsFile = flags.events === null ? resolve(DEFAULT_EVENTS) : resolve(flags.events);
  if (flags.ledger !== null) {
    const ledger = resolve(flags.ledger);
    if (deps.isDir(ledger)) {
      ledgerFile = join(ledger, 'ledger.json');
      if (flags.events === null) eventsFile = join(ledger, 'events.jsonl');
    } else {
      if (!ledger.endsWith('.json')) throw new UsageError('--ledger must be a ledger.json file or the directory holding it');
      ledgerFile = ledger;
      if (flags.events === null) eventsFile = join(dirname(ledger), 'events.jsonl');
    }
  }

  // Missing files are empty inputs, not errors: a repo where nothing has
  // landed yet has nothing to summarize. A present-but-malformed file still
  // fails loudly (readEvents/readLedger throw).
  const events = readEvents(eventsFile);
  const ledger = existsSync(ledgerFile) ? readLedger(ledgerFile) : null;
  const groups = summarize(events, ledger, { minN });
  deps.print(flags.json ? JSON.stringify(groups, null, 2) : formatRetro(groups, { minN }));
  return 0;
}
