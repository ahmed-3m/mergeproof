// Bad invocation: the CLI prints the message plus usage and exits with EXIT_CODES.USAGE.
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

// A config, ledger or other input file that exists but can't be used. The CLI
// prints the message and exits with EXIT_CODES.ERROR; it never falls back to defaults.
export class FileFormatError extends Error {
  constructor(file, message) {
    super(`${file}: ${message}`);
    this.name = 'FileFormatError';
    this.file = file;
  }
}

// Placeholder for pipeline stages that are scaffolded but not built yet.
export class NotImplementedError extends Error {
  constructor(feature) {
    super(`${feature} is not implemented yet`);
    this.name = 'NotImplementedError';
    this.feature = feature;
  }
}
