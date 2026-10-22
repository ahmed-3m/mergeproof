import { UsageError } from './errors.mjs';

// Minimal flag parser (node:util parseArgs is not stable across our Node 18 floor).
// Boolean `--flag` switches and `--name value` / `--name=value` options; anything
// unknown is a usage error.
export function parseFlags(argv, booleanFlags, valueFlags = []) {
  const bools = new Set(booleanFlags);
  const values = new Set(valueFlags);
  const flags = Object.fromEntries(booleanFlags.map((f) => [f, false]));
  for (const f of valueFlags) flags[f] = null;
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (bools.has(name) && eq === -1) {
      flags[name] = true;
    } else if (values.has(name)) {
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined || value === '' || (eq === -1 && value.startsWith('--'))) {
        throw new UsageError(`--${name} needs a value`);
      }
      flags[name] = value;
    } else {
      throw new UsageError(`unknown flag: ${arg}`);
    }
  }
  return { positionals, flags };
}
