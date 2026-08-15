// Stage a ShotKit runtime into a platform subpackage (npm/<platform>/).
//
// Usage: tsx tools/stage-platform.ts <platform> [sourceDir]
//   platform:  win32-x64 | win32-arm64 | linux-x64 | linux-arm64 | darwin-x64 | darwin-arm64
//   sourceDir: an extracted release archive (or any dir with the same layout).
//              Defaults, for local Windows development, to the compact release
//              WebKitBuild/releases/shotkit-windows-<arch> and falls back to
//              WebKitBuild/shot-dist.
//
// Windows runtimes are flat (shotcli.exe + *.dll); Linux/macOS use bin/ + lib/
// (the executable finds libshot via $ORIGIN/../lib or @loader_path/../lib).
// Non-runtime payload (include/, docs, checksums, screenshots) is skipped.

import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLATFORMS = ['win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'];
const SKIPPED_DIRECTORIES = new Set(['include']);
const SKIPPED_EXTENSIONS = new Set(['.txt', '.md', '.png', '.sha256', '.h']);

const packageDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = path.resolve(packageDirectory, '..', '..');

const [platform, explicitSource] = process.argv.slice(2);
if (!platform || !PLATFORMS.includes(platform)) {
  console.error(`usage: tsx tools/stage-platform.ts <${PLATFORMS.join('|')}> [sourceDir]`);
  process.exit(2);
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

async function defaultSource(): Promise<string> {
  const [, arch] = platform.split('-');
  const compact = path.join(repositoryRoot, 'WebKitBuild', 'releases', `shotkit-windows-${arch}`);
  if (platform.startsWith('win32-') && await exists(path.join(compact, 'shotcli.exe')))
    return compact;
  return path.join(repositoryRoot, 'WebKitBuild', 'shot-dist');
}

const source = path.resolve(explicitSource || await defaultSource());
const target = path.join(packageDirectory, 'npm', platform);

async function copyRuntime(from: string, to: string): Promise<void> {
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name))
        continue;
      await mkdir(path.join(to, entry.name), { recursive: true });
      await copyRuntime(path.join(from, entry.name), path.join(to, entry.name));
      continue;
    }
    if (!entry.isFile() || SKIPPED_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      continue;
    await cp(path.join(from, entry.name), path.join(to, entry.name));
  }
}

if (!await exists(path.join(target, 'package.json')))
  throw new Error(`unknown platform package: ${target}`);

// Reset only the staged runtime, never the checked-in package.json / README.md.
for (const entry of await readdir(target)) {
  if (entry === 'package.json' || entry === 'README.md')
    continue;
  await rm(path.join(target, entry), { recursive: true, force: true });
}
await copyRuntime(source, target);

const required = platform.startsWith('win32-')
  ? [path.join(target, 'shotcli.exe'), path.join(target, 'shot.dll')]
  : [path.join(target, 'bin', 'shotcli'), path.join(target, 'lib', platform.startsWith('darwin-') ? 'libshot.dylib' : 'libshot.so')];
for (const file of required) {
  if (!await exists(file))
    throw new Error(`staged runtime is missing ${path.relative(target, file)} (source: ${source})`);
}

async function totalBytes(directory: string): Promise<number> {
  let sum = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    sum += entry.isDirectory() ? await totalBytes(full) : (await stat(full)).size;
  }
  return sum;
}

console.log(`staged ${platform} runtime (${((await totalBytes(target)) / 1048576).toFixed(1)} MiB) ${source} -> ${target}`);
