#!/usr/bin/env node
import { main } from '../src/cli.mjs';

// npm exposes this entrypoint through symlinks. Always invoke main here instead
// of comparing process.argv[1] (the symlink) with import.meta.url (its target).
main().catch(error => {
  console.error(`Shep: ${error.message}`);
  process.exitCode = 1;
});
