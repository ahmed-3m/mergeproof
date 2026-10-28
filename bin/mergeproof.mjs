#!/usr/bin/env node
// mergeproof — npm bin entry. All logic lives in src/ so the CLI and the
// GitHub Action (milestone 2) share one source of truth.
import { main } from '../src/cli.mjs';

process.exitCode = await main(process.argv.slice(2));
