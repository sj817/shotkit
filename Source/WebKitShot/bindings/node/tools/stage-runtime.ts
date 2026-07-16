import { cp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = path.resolve(packageDirectory, '..', '..', '..', '..');
const packageMetadata = JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8')) as { version: string };
const compactRelease = path.join(repositoryRoot, 'WebKitBuild', 'releases', `shotkit-${packageMetadata.version}-windows-x64`);
const developmentRuntime = path.join(repositoryRoot, 'WebKitBuild', 'shot-dist');
let source = path.resolve(process.env.SHOT_DIST || compactRelease);
if (!process.env.SHOT_DIST) {
  try {
    await stat(path.join(source, 'shotcli.exe'));
  } catch {
    source = developmentRuntime;
  }
}
const target = path.join(packageDirectory, 'vendor', 'win32-x64');

await stat(path.join(source, 'shotcli.exe'));
await stat(path.join(source, 'shot.dll'));
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });

for (const entry of await readdir(source, { withFileTypes: true })) {
  if (!entry.isFile() || entry.name.toLowerCase().endsWith('.png'))
    continue;
  await cp(path.join(source, entry.name), path.join(target, entry.name));
}

const files = await readdir(target);
const bytes = (await Promise.all(files.map(async (file) => (await stat(path.join(target, file))).size))).reduce((sum, size) => sum + size, 0);
console.log(`staged ${files.length} runtime files (${(bytes / 1048576).toFixed(1)} MiB) -> ${target}`);
