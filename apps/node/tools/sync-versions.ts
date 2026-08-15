// Propagate the main package version to every platform subpackage and inject
// the exact-pinned optionalDependencies into the main manifest.
//
// The checked-in package.json deliberately has NO optionalDependencies: the
// platform packages only exist on the registry after a publish run, and pins
// to unpublished versions would break `npm ci` in the development tree. The
// publish workflow runs this script right before `npm publish`, so only the
// published manifest carries the pins.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const mainPath = path.join(packageDirectory, 'package.json');
const main = JSON.parse(await readFile(mainPath, 'utf8')) as {
  version: string;
  optionalDependencies?: Record<string, string>;
};

const npmDirectory = path.join(packageDirectory, 'npm');
const optionalDependencies: Record<string, string> = {};
for (const platform of (await readdir(npmDirectory)).sort()) {
  const platformPath = path.join(npmDirectory, platform, 'package.json');
  const pkg = JSON.parse(await readFile(platformPath, 'utf8')) as { name: string; version: string };
  pkg.version = main.version;
  await writeFile(platformPath, `${JSON.stringify(pkg, null, 2)}\n`);
  optionalDependencies[pkg.name] = main.version;
}

main.optionalDependencies = optionalDependencies;
await writeFile(mainPath, `${JSON.stringify(main, null, 2)}\n`);
console.log(`synced ${Object.keys(optionalDependencies).length} platform packages to ${main.version}`);
