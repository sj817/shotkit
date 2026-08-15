// Locating the shotcli runtime is shared by the SDK and the `shotkit` CLI, so it
// lives here rather than in either entry point.
import { existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { ShotKitError } from './error.js';

// tsup --shims provides __dirname to the ESM build; native CJS supplies it itself.
const packageDirectory = path.dirname(__dirname);

export const platformKey = `${process.platform}-${process.arch}`;

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function executableName(): string {
  return process.platform === 'win32' ? 'shotcli.exe' : 'shotcli';
}

/** The runtime shipped by the matching `@shotkit/<platform>-<arch>` package, if installed. */
function installedRuntimeDirectory(): string | undefined {
  try {
    const requireFromPackage = createRequire(path.join(packageDirectory, 'package.json'));
    return path.dirname(requireFromPackage.resolve(`@shotkit/${platformKey}/package.json`));
  } catch {
    return undefined;
  }
}

/**
 * The development tree's `WebKitBuild/shot-dist`, located by walking up from this
 * package rather than by counting `..` segments. The count would be baked into the
 * published bundle, so moving the package inside the repository would silently
 * point the fallback at nothing. Outside a checkout the walk finds no marker and
 * returns undefined, which is what an installed package wants anyway.
 */
function developmentRuntimeDirectory(): string | undefined {
  let directory = packageDirectory;
  for (let depth = 0; depth < 6; ++depth) {
    const candidate = path.join(directory, 'WebKitBuild', 'shot-dist');
    if (existsSync(candidate))
      return candidate;
    const parent = path.dirname(directory);
    if (parent === directory)
      break;
    directory = parent;
  }
  return undefined;
}

export async function resolveExecutable(explicit?: string): Promise<string> {
  const runtimeDirectories = [
    installedRuntimeDirectory(),
    // Repository-development fallbacks: a staged platform subpackage, then the
    // flat Windows development runtime.
    path.join(packageDirectory, 'npm', platformKey),
    developmentRuntimeDirectory(),
  ].filter((directory): directory is string => !!directory);

  const executable = executableName();
  const candidates = [
    explicit,
    process.env.SHOTKIT_EXECUTABLE,
    // Windows runtimes are flat; Linux/macOS use bin/ (+ lib/ via rpath).
    ...runtimeDirectories.flatMap((directory) => [
      path.join(directory, executable),
      path.join(directory, 'bin', executable),
    ]),
  ].filter((candidate): candidate is string => !!candidate).map((candidate) => path.resolve(candidate));

  for (const candidate of candidates) {
    if (await exists(candidate))
      return candidate;
  }
  throw new ShotKitError(`shotcli not found for ${platformKey}; install @shotkit/${platformKey}, set SHOTKIT_EXECUTABLE, or pass executablePath`);
}
