// Compose the GitHub Release body from the runtime archives that are actually
// being attached, so sizes and checksums can never drift from the assets.
//
//   node release-notes.mjs --tag v1.2.3 --dir <archives> [--previous v1.2.2] > notes.md
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const tag = argument('tag');
const directory = argument('dir');
const previous = argument('previous');
const repository = argument('repo', 'sj817/shotkit');
if (!tag || !directory) {
  process.stderr.write('usage: release-notes.mjs --tag <tag> --dir <archives> [--previous <tag>]\n');
  process.exit(2);
}
const version = tag.replace(/^v/, '');

// Archive names end in -<os>-<arch>; everything else about them is free-form.
const LABELS = {
  'windows-x64': { os: 'Windows', arch: 'x64', pkg: '@shotkit/win32-x64' },
  'windows-arm64': { os: 'Windows', arch: 'arm64', pkg: '@shotkit/win32-arm64' },
  'linux-x64': { os: 'Linux', arch: 'x64', pkg: '@shotkit/linux-x64' },
  'linux-arm64': { os: 'Linux', arch: 'arm64', pkg: '@shotkit/linux-arm64' },
  'macos-x64': { os: 'macOS', arch: 'x64 (Intel)', pkg: '@shotkit/darwin-x64' },
  'macos-arm64': { os: 'macOS', arch: 'arm64 (Apple silicon)', pkg: '@shotkit/darwin-arm64' },
};
const ORDER = Object.keys(LABELS);

async function collect() {
  const entries = (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.tar.xz'));

  // gh run download nests each artifact in its own directory, so scan recursively
  // but keep one row per archive name.
  const rows = [];
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    const file = path.join(entry.parentPath ?? entry.path, entry.name);
    const key = entry.name.replace(/\.tar\.xz$/, '').match(/-(windows|linux|macos)-(x64|arm64)$/);
    if (!key) continue;

    let sha256 = '';
    try {
      sha256 = (await readFile(`${file}.sha256`, 'utf8')).trim().split(/\s+/)[0] ?? '';
    } catch {
      // A missing checksum should not block the release notes.
    }

    rows.push({
      key: `${key[1]}-${key[2]}`,
      name: entry.name,
      bytes: (await stat(file)).size,
      sha256,
    });
  }
  return rows.sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key));
}

const megabytes = (bytes) => `${(bytes / 1_000_000).toFixed(1)} MB`;
const short = (hash) => (hash ? `\`${hash.slice(0, 16)}…\`` : '—');

const rows = await collect();
if (rows.length === 0) {
  process.stderr.write(`release-notes: no *.tar.xz runtime archives under ${directory}\n`);
  process.exit(1);
}
if (rows.length !== ORDER.length) {
  // The publish workflow already refuses to upload a partial set; this only
  // guards a standalone run against quietly documenting half a release.
  process.stderr.write(`release-notes: warning — ${rows.length} of ${ORDER.length} runtimes present\n`);
}

const download = (name) => `https://github.com/${repository}/releases/download/${tag}/${name}`;

const assetTable = [
  '| Platform | Arch | npm package | Archive | Size | SHA-256 |',
  '|---|---|---|---|--:|---|',
  ...rows.map((row) => {
    const label = LABELS[row.key];
    return `| ${label.os} | ${label.arch} | \`${label.pkg}\` | [\`${row.name}\`](${download(row.name)}) | ${megabytes(row.bytes)} | ${short(row.sha256)} |`;
  }),
].join('\n');

const compare = previous
  ? `https://github.com/${repository}/compare/${previous}...${tag}`
  : `https://github.com/${repository}/commits/${tag}`;

process.stdout.write(`<div align="center">

# ShotKit ${tag}

**Turn HTML into PNG / WebP — without a browser.**

[![npm](https://img.shields.io/npm/v/@shotkit/node?logo=npm&label=%40shotkit%2Fnode)](https://www.npmjs.com/package/@shotkit/node)
[![docs](https://img.shields.io/badge/docs-README-blue)](https://github.com/${repository}#readme)
[![中文](https://img.shields.io/badge/文档-简体中文-red)](https://github.com/${repository}/blob/${tag}/README.zh-CN.md)

</div>

## Install

\`\`\`bash
npm install @shotkit/node
\`\`\`

> [!TIP]
> npm resolves exactly one prebuilt runtime for your platform. No node-gyp, no
> compiler, and no post-install download.

<details open>
<summary><b>Other ways to run it</b></summary>

\`\`\`bash
# One-off, no install
npx @shotkit/node --url https://example.com --out shot.png

# Global CLI — installs as \`sk\`, with \`shotkit\` as an equivalent alias
npm install -g @shotkit/node
sk --html page.html --out page.png --full-page

# Node.js API
node -e "const {launch}=require('@shotkit/node');launch().then(async s=>{await s.screenshotURL('https://example.com',{outputPath:'a.png'});await s.close()})"
\`\`\`

</details>

## Prebuilt runtimes

Standalone archives for the CLI, the C ABI, and non-Node languages. Extract completely before use —
each one unpacks into a version-free \`shotkit-<os>-<arch>/\` directory.

${assetTable}

<details>
<summary><b>Verify a download</b></summary>

\`\`\`bash
# Linux / macOS
sha256sum -c shotkit-${version}-linux-x64.tar.xz.sha256

# Windows (PowerShell)
(Get-FileHash shotkit-${version}-windows-x64.tar.xz -Algorithm SHA256).Hash
\`\`\`

Layout differs by platform: Windows archives are flat — \`shotcli.exe\`, \`shot.dll\`,
\`include/shot.h\`, and a \`manifest.json\` listing every file with its own SHA-256.
Linux and macOS use \`bin/\`, \`lib/\`, \`include/\`, plus a \`DEPENDENCIES.txt\`.

</details>

## Verified in CI

Every runtime in this release passed, on its own platform and architecture:

- [x] PNG and WebP screenshot smoke tests
- [x] Page scripts are never fetched or executed
- [x] Exactly 10 \`shot_*\` C ABI exports
- [x] Relocatable CLI (\`$ORIGIN/../lib\` / \`@loader_path/../lib\`)
- [x] Release archive within its size budget

Published to npm through [Trusted Publishing (OIDC)](https://docs.npmjs.com/trusted-publishers) — no
long-lived token is involved.

---

<details>
<summary><b>🇨🇳 简体中文</b></summary>

### 安装

\`\`\`bash
npm install @shotkit/node
\`\`\`

npm 只会为当前平台装下唯一匹配的预编译运行时——不需要 node-gyp，不需要编译器，也没有安装后下载。

\`\`\`bash
# 不安装,直接跑一次
npx @shotkit/node --url https://example.com --out shot.png

# 全局 CLI —— 命令为 \`sk\`,同时提供等价别名 \`shotkit\`
npm install -g @shotkit/node
sk --html page.html --out page.png --full-page
\`\`\`

### 预编译运行时

上面的归档表供 CLI、C ABI 和非 Node 语言直接使用，**请完整解压后再运行**。
每个归档解压出的目录都是不带版本号的 \`shotkit-<os>-<arch>/\`。
布局按平台不同：Windows 是平铺的 \`shotcli.exe\`、\`shot.dll\`、\`include/shot.h\`，
外加一份逐文件带 SHA-256 的 \`manifest.json\`；Linux 与 macOS 则是 \`bin/\`、\`lib/\`、
\`include/\`，另有 \`DEPENDENCIES.txt\`。

校验下载：

\`\`\`bash
# Linux / macOS
sha256sum -c shotkit-${version}-linux-x64.tar.xz.sha256
\`\`\`

### CI 验证项

本次发布的每个运行时，都在其对应的平台与架构上通过了：PNG/WebP 截图冒烟测试、
页面脚本零请求零执行、10 个 \`shot_*\` C ABI 导出、可重定位 CLI、以及发布归档体积闸门。

npm 侧通过 Trusted Publishing(OIDC)发布，全程不涉及长期有效的 token。

</details>

**Full changelog**: ${compare}
`);
