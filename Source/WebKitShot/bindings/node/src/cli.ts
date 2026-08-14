#!/usr/bin/env node
// `shotkit` — resolves the runtime shipped by the matching @shotkit/<platform>-<arch>
// package and hands every argument to it untouched, so this stays a passthrough and
// shotcli's own --help remains the authoritative interface.
import { spawn } from 'node:child_process';
import { constants } from 'node:os';

import { platformKey, resolveExecutable } from './executable.js';

async function main(): Promise<number> {
  const args = process.argv.slice(2);

  let executable: string;
  try {
    executable = await resolveExecutable();
  } catch {
    process.stderr.write(
      `shotkit: no runtime found for ${platformKey}.\n` +
        `  The prebuilt runtime installs automatically as an optional dependency.\n` +
        `  If it was skipped (--no-optional, an unsupported platform, or an offline\n` +
        `  install), reinstall with optional dependencies enabled, or point\n` +
        `  SHOTKIT_EXECUTABLE at a shotcli binary.\n`,
    );
    return 127;
  }

  // Debug helper for global installs, where the runtime can be far from the CWD.
  // Namespaced so it cannot collide with a shotcli flag.
  if (args[0] === '--shotkit-bin') {
    process.stdout.write(`${executable}\n`);
    return 0;
  }

  return await new Promise<number>((resolve) => {
    // Deliberately no cwd override: the user's working directory has to survive so
    // relative --html/--out paths resolve the way they typed them. The runtime finds
    // its own libraries regardless — Windows searches the executable's directory
    // first, and the Unix builds carry an rpath of $ORIGIN/../lib.
    const child = spawn(executable, args, { stdio: 'inherit' });

    child.on('error', (error) => {
      process.stderr.write(`shotkit: failed to start ${executable}: ${error.message}\n`);
      resolve(126);
    });

    child.on('exit', (code, signal) => {
      if (signal) {
        // Shell convention: a process killed by signal N reports 128 + N.
        const number = constants.signals[signal as keyof typeof constants.signals];
        resolve(number ? 128 + number : 1);
      } else {
        resolve(code ?? 1);
      }
    });
  });
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`shotkit: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
