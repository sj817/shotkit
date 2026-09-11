// Write @shotkit/node, the package's previous name, as a compatibility shim:
// a manifest whose only dependency is @pixel.js/shotkit at exactly this
// version, and entries that re-export it.
//
// Usage: tsx tools/legacy-shim.ts <dest>
//   Run after `npm version` and `npm run sync-versions`, so the manifest read
//   here carries the version being published.
//
// The package moved to the @pixel.js scope in 0.3.1. An install pinned to the
// old name keeps working and keeps receiving releases because this package is
// published beside every release with the same version number; what it
// installs is the new package and its platform runtime. The six old platform
// packages, @shotkit/<os>-<arch>, are not published any more: nothing depends
// on them once the main package under that name depends on @pixel.js/shotkit.
//
// Generated at publish time, never committed: the version, the exports shape
// and the repository field provenance checks against are all copies of the
// primary manifest, and a checked-in copy is a copy that drifts. The exports
// map is mirrored by shape, and a shape this file does not know is refused
// rather than shipped without the new entry.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRIMARY = '@pixel.js/shotkit';
export const LEGACY = '@shotkit/node';

interface PrimaryManifest {
  name: string;
  version: string;
  description?: string;
  license?: string;
  engines?: unknown;
  keywords?: string[];
  repository?: unknown;
  homepage?: string;
  bugs?: unknown;
  publishConfig?: unknown;
  exports: Record<string, { import?: unknown; require?: unknown }>;
  optionalDependencies?: Record<string, string>;
}

export function shimManifest(primary: PrimaryManifest): Record<string, unknown> {
  if (primary.name !== PRIMARY)
    throw new Error(`the legacy shim mirrors ${PRIMARY}, not ${primary.name}`);
  if (!primary.optionalDependencies)
    throw new Error('run sync-versions first: the published manifest carries the platform pins, this one has none');
  const keys = Object.keys(primary.exports);
  if (keys.length !== 1 || keys[0] !== '.' || !primary.exports['.'].import || !primary.exports['.'].require) {
    throw new Error(
      `${PRIMARY} exports ${JSON.stringify(primary.exports)}; this shim mirrors only "." with import and require. ` +
      'Teach tools/legacy-shim.ts the new shape before publishing.',
    );
  }
  const manifest: Record<string, unknown> = {
    name: LEGACY,
    version: primary.version,
    description: `Compatibility alias of ${PRIMARY}, the package's current name. Install ${PRIMARY} instead.`,
    license: primary.license,
    type: 'module',
    sideEffects: false,
    main: './index.cjs',
    module: './index.mjs',
    types: './index.d.cts',
    exports: {
      '.': {
        import: { types: './index.d.mts', default: './index.mjs' },
        require: { types: './index.d.cts', default: './index.cjs' },
      },
    },
    files: ['index.mjs', 'index.cjs', 'index.d.mts', 'index.d.cts', 'README.md'],
    engines: primary.engines,
    keywords: primary.keywords,
    // Provenance compares this against the repository the workflow runs in.
    repository: primary.repository,
    homepage: primary.homepage,
    bugs: primary.bugs,
    publishConfig: primary.publishConfig,
    // Exact, not a range: the two names are one package and move together.
    dependencies: { [PRIMARY]: primary.version },
  };
  for (const key of Object.keys(manifest))
    if (manifest[key] === undefined) delete manifest[key];
  return manifest;
}

const BANNER = `// ${LEGACY} is the previous name of ${PRIMARY}. Everything here is that package.\n`;

// `export *` skips the default export, and src/index.ts has one (the
// shotium-shaped object), so it gets its own line. The CJS bundle exposes
// it as `default` on module.exports, which `module.exports = require(...)`
// carries over as is.
export function shimFiles(primary: PrimaryManifest): Record<string, string> {
  return {
    'package.json': `${JSON.stringify(shimManifest(primary), null, 2)}\n`,
    'index.mjs': `${BANNER}export * from '${PRIMARY}';\nexport { default } from '${PRIMARY}';\n`,
    'index.cjs': `${BANNER}module.exports = require('${PRIMARY}');\n`,
    'index.d.mts': `export * from '${PRIMARY}';\nexport { default } from '${PRIMARY}';\n`,
    'index.d.cts': `export * from '${PRIMARY}';\nexport { default } from '${PRIMARY}';\n`,
    'README.md': readme(primary.version),
  };
}

function readme(version: string): string {
  const npm = `https://www.npmjs.com/package/${PRIMARY}`;
  return `# ${LEGACY}

> **Compatibility alias.** \`${LEGACY}\` is the previous name of [\`${PRIMARY}\`](${npm}). This package depends on \`${PRIMARY}@${version}\` and re-exports it, so an existing install pinned to the old name keeps receiving every release. New projects should install \`${PRIMARY}\` directly.
>
> **兼容别名包。** \`${LEGACY}\` 是 [\`${PRIMARY}\`](${npm}) 的旧包名。本包依赖 \`${PRIMARY}@${version}\` 并原样重新导出，已有项目保留旧依赖即可继续收到每一个新版本；新项目请直接安装 \`${PRIMARY}\`。

## Migrate / 迁移

\`\`\`bash
npm uninstall ${LEGACY}
npm install ${PRIMARY}
\`\`\`

\`\`\`diff
- import { screenshot } from '${LEGACY}';
+ import { screenshot } from '${PRIMARY}';
\`\`\`

The six \`@shotkit/<os>-<arch>\` platform packages are no longer published; the runtime now arrives as \`${PRIMARY}-<os>-<arch>\`, which npm resolves on the next install.

旧的六个 \`@shotkit/<os>-<arch>\` 平台包不再发布，运行时改由 \`${PRIMARY}-<os>-<arch>\` 提供，下次安装时由 npm 自动完成替换。
`;
}

export async function writeShim(dest: string, primary: PrimaryManifest): Promise<string[]> {
  const files = shimFiles(primary);
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  for (const [name, content] of Object.entries(files))
    await writeFile(path.join(dest, name), content);
  return Object.keys(files);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const dest = process.argv[2];
  if (!dest) {
    console.error('usage: tsx tools/legacy-shim.ts <dest>');
    process.exit(2);
  }
  const packageDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const primary = JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8')) as PrimaryManifest;
  const files = await writeShim(path.resolve(dest), primary);
  console.log(`${LEGACY}@${primary.version} -> ${PRIMARY}@${primary.version} in ${path.resolve(dest)}: ${files.join(' ')}`);
}
