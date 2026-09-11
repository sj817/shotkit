// The engine fingerprint: a hash of every tracked file the native build reads.
//
// Every engine artifact is named after it -- engine-linux-x64-<fingerprint>,
// engine-node-linux-x64-<fingerprint> -- so a push or a tag whose tree has
// the same build inputs reuses what an earlier run built instead of
// compiling WebKit again. The hash covers `git ls-tree -r` over the build
// closure: mode, blob id and path of every tracked file under it, which is
// content-addressed, independent of the commit or the merge, and readable
// from a blobless sparse checkout. A path outside the closure -- docs, the
// SDK sources, the benchmark, the release tooling -- does not count.
//
//   node scripts/ci/fingerprint.mjs [--lto full|thin] [--ref HEAD] [--output]
//
// --output appends fingerprint=<16 hex> and fingerprint-full=<64 hex> to
// $GITHUB_OUTPUT.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCHEMA = 1;

// What the three build workflows check out and read. tests/ contributes only
// the one C++ file CMake compiles; the SDK contributes only the pinned
// node-api-headers version (the addon is compiled against it), read from
// the lockfile below rather than hashing the lockfile itself.
export const CLOSURE = [
  'Source', 'shot', 'Tools', 'WebKitLibraries',
  'CMakeLists.txt', 'CMakePresets.json', 'vcpkg.json', 'vcpkg-configuration.json',
  'tests/capi_thread_test.cpp',
  'scripts/build-shot.ps1', 'scripts/collect-dist.ps1', 'scripts/package-release.ps1',
  'scripts/slim-icu.ps1', 'scripts/icu-data-filter.json', 'scripts/ci/fingerprint.mjs',
  '.github/workflows/build-windows.yml', '.github/workflows/build-linux.yml', '.github/workflows/build-macos.yml',
];

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function nodeApiHeadersVersion(lockfile = path.join(repositoryRoot, 'apps/node/package-lock.json')) {
  const lock = JSON.parse(readFileSync(lockfile, 'utf8'));
  const entry = lock.packages?.['node_modules/node-api-headers'];
  if (!entry?.version) throw new Error(`node-api-headers is not pinned in ${lockfile}`);
  return entry.version;
}

/** Hash a `git ls-tree -r -z` listing plus the literal lines that are not files. */
export function fingerprint(listing, extras) {
  const hash = createHash('sha256').update(`schema=${SCHEMA}\n`);
  let entries = 0;
  for (const record of listing.split('\0')) {
    if (!record) continue;
    if (!/^\d{6} (blob|commit) [0-9a-f]{40,64}\t/.test(record)) throw new Error(`unexpected ls-tree record: ${JSON.stringify(record)}`);
    hash.update(record).update('\n');
    entries++;
  }
  for (const [key, value] of Object.entries(extras)) hash.update(`${key}=${value}\n`);
  const full = hash.digest('hex');
  return { id: full.slice(0, 16), full, entries };
}

// `git ls-tree` reads trees, not blobs, so this works in the blobless
// sparse checkout the CI resolve job makes. A closure path with no tracked
// file at the ref is a warning, not an error: build-*.yml do not exist
// until the workflow that introduces them lands.
export function listTree(ref = 'HEAD', closure = CLOSURE, cwd = repositoryRoot) {
  const listing = execFileSync('git', ['ls-tree', '-r', '-z', '--full-tree', ref, '--', ...closure], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const files = listing.split('\0').filter(Boolean).map((record) => record.slice(record.indexOf('\t') + 1));
  for (const entry of closure) {
    if (!files.some((file) => file === entry || file.startsWith(`${entry}/`))) {
      process.stderr.write(`fingerprint: closure path ${entry} has no tracked files at ${ref}\n`);
    }
  }
  return listing;
}

export function compute({ ref = 'HEAD', lto = 'full' } = {}) {
  return fingerprint(listTree(ref), { 'node-api-headers': nodeApiHeadersVersion(), lto });
}

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const lto = argument('lto', 'full');
  if (!['full', 'thin'].includes(lto)) {
    process.stderr.write('--lto must be full or thin\n');
    process.exit(2);
  }
  const result = compute({ ref: argument('ref', 'HEAD'), lto });
  process.stdout.write(`${result.id}\n`);
  if (process.argv.includes('--output')) {
    if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is not set');
    appendFileSync(process.env.GITHUB_OUTPUT, `fingerprint=${result.id}\nfingerprint-full=${result.full}\n`);
  }
  process.stderr.write(`${result.entries} tracked files in the build closure, lto=${lto}, schema ${SCHEMA}\n`);
}
