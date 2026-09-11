// Exercise a built engine the way users receive it: the CLI from the release
// archive and the Node SDK on the packaged addon, on the runner that can
// execute them.
//
// One script for the three platforms, replacing the shell blocks that each
// OS workflow used to carry. It runs against the two engine artifacts of a
// fingerprint (downloaded into --engine-dir by build.yml's verify job), or
// against a local build tree (--build-dir) for the same checks on a
// developer machine.
//
//   node scripts/ci/verify-runtime.mjs --os linux --arch x64 --engine-dir <dir> [--xslt]
//   node scripts/ci/verify-runtime.mjs --os windows --arch x64 --build-dir WebKitBuild/shot \
//        [--vcpkg-bin WebKitBuild/vcpkg_installed/x64-windows-webkit/bin]
//
// What runs, in order: PNG and WebP smoke renders through shotcli; the SDK
// suite (`npm test`), the native/CLI parity check and the soak, all with
// SHOTKIT_NATIVE_PATH pointing at the addon under test; the fixture
// server's no-script-network assertion (a page whose script would fetch a
// second URL must produce exactly one request); and with --xslt the XML
// document through the CLI and the SDK. Every failure names its stage.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};
const flag = (name) => argv.includes(`--${name}`);

const platformOs = option('os');
const arch = option('arch');
// Absolute, because the SDK tests run with apps/node as their cwd.
const engineDir = option('engine-dir') && path.resolve(option('engine-dir'));
const buildDir = option('build-dir');
const port = Number(option('port', '8988'));
if (!['windows', 'linux', 'macos'].includes(platformOs) || !['x64', 'arm64'].includes(arch) || (!engineDir && !buildDir)) {
  process.stderr.write('usage: verify-runtime.mjs --os <windows|linux|macos> --arch <x64|arm64> (--engine-dir <dir> | --build-dir <dir>) [--xslt] [--vcpkg-bin <dir>]\n');
  process.exit(2);
}
const windows = platformOs === 'windows';
const exe = windows ? '.exe' : '';
const npm = windows ? 'npm.cmd' : 'npm';
const python = windows ? 'python' : 'python3';

const temporary = mkdtempSync(path.join(os.tmpdir(), 'shotkit-verify-'));
process.on('exit', () => rmSync(temporary, { recursive: true, force: true }));

function stage(name) {
  process.stdout.write(`\n=== ${name}\n`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: windows && command.endsWith('.cmd'), ...options });
  if (result.error) throw new Error(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status ?? `signal ${result.signal}`}`);
}

function sizeAbove(file, minimum) {
  const size = existsSync(file) ? statSync(file).size : 0;
  if (size <= minimum) throw new Error(`${file} is ${size} bytes; expected more than ${minimum}`);
  return size;
}

// The artifact layout download-artifact leaves: <engine-dir>/<artifact name>/...
function artifactDirectory(prefix) {
  const candidates = readdirSync(engineDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => path.join(engineDir, entry.name));
  if (candidates.length !== 1) throw new Error(`expected exactly one ${prefix}* directory under ${engineDir}, found ${candidates.length}`);
  return candidates[0];
}

let addon;
let shotcli;
const extraPath = [];
if (buildDir) {
  const bin = path.resolve(root, buildDir, 'bin');
  addon = path.join(bin, 'shot.node');
  shotcli = path.join(bin, `shotcli${exe}`);
  const vcpkgBin = option('vcpkg-bin');
  if (vcpkgBin) extraPath.push(path.resolve(root, vcpkgBin));
} else {
  const nodeDir = artifactDirectory(`engine-node-${platformOs}-${arch}-`);
  addon = path.join(nodeDir, 'shot.node');
  const archiveDir = artifactDirectory(`engine-${platformOs}-${arch}-`);
  const archive = path.join(archiveDir, `shotkit-${platformOs}-${arch}.tar.xz`);
  if (!existsSync(archive)) throw new Error(`no release archive at ${archive}`);
  stage(`extract ${path.basename(archive)}`);
  // Windows' own bsdtar reads .tar.xz and understands D:\ paths; the GNU
  // tar a Git Bash puts first on PATH reads `D:` as a remote host.
  const tar = windows ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  run(tar, ['-xf', archive, '-C', temporary]);
  const extracted = path.join(temporary, `shotkit-${platformOs}-${arch}`);
  // Windows keeps the CLI and its DLL closure flat; the others use bin/ and lib/.
  shotcli = windows ? path.join(extracted, 'shotcli.exe') : path.join(extracted, 'bin', 'shotcli');
}
for (const required of [addon, shotcli]) {
  if (!existsSync(required)) throw new Error(`missing ${required}`);
}
const env = { ...process.env, SHOTKIT_NATIVE_PATH: addon };
if (extraPath.length > 0) env.PATH = `${extraPath.join(path.delimiter)}${path.delimiter}${env.PATH}`;
process.stdout.write(`addon:   ${addon}\nshotcli: ${shotcli}\n`);

stage('smoke: PNG and WebP through shotcli');
const smokeHtml = path.join(temporary, 'shot-smoke.html');
writeFileSync(smokeHtml, '<!doctype html><meta charset=utf-8><style>body{background:#eef2f7;font:32px sans-serif}h1{color:#246}</style><h1>ShotKit CI ✓</h1>\n');
const smokePng = path.join(temporary, 'shot-smoke.png');
const smokeWebp = path.join(temporary, 'shot-smoke.webp');
run(shotcli, ['--html', smokeHtml, '--out', smokePng, '--width', '640', '--height', '360'], { env });
run(shotcli, ['--html', smokeHtml, '--out', smokeWebp, '--format', 'webp', '--quality', '82', '--width', '640', '--height', '360'], { env });
process.stdout.write(`png ${sizeAbove(smokePng, 100)} bytes, webp ${sizeAbove(smokeWebp, 100)} bytes\n`);

stage('SDK suite, native/CLI parity and soak against the addon');
const sdk = path.join(root, 'apps', 'node');
run(npm, ['test'], { cwd: sdk, env });
run(process.execPath, [path.join(sdk, 'test', 'native-parity.mjs'), shotcli], { cwd: root, env });
run(process.execPath, ['--expose-gc', path.join(sdk, 'test', 'native-soak.mjs')], { cwd: root, env });

stage('fixture server: scripts are never fetched');
const server = spawn(python, [path.join(root, 'tests', 'fixture_server.py'), String(port)], { stdio: ['ignore', 'inherit', 'inherit'] });
process.on('exit', () => { if (server.exitCode === null) server.kill(); });
const base = `http://127.0.0.1:${port}`;
const ready = await (async () => {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`${base}/reset-counts`);
      if (response.ok) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
})();
if (!ready) throw new Error('fixture server did not become ready');
await fetch(`${base}/reset-counts`);
run(shotcli, ['--url', `${base}/script-network`, '--out', path.join(temporary, 'no-script-network.png'), '--timeout', '5000'], { env });
const counts = await (await fetch(`${base}/request-counts`)).json();
if (JSON.stringify(counts) !== JSON.stringify({ '/script-network': 1 })) throw new Error(`unexpected network requests: ${JSON.stringify(counts)}`);
process.stdout.write(`NO-SCRIPT NETWORK PASS: ${JSON.stringify(counts)}\n`);

if (flag('xslt')) {
  stage('XML/XSLT through the CLI and the SDK');
  const xslt = path.join(temporary, 'xslt.png');
  run(shotcli, ['--url', `${base}/document.xml`, '--out', xslt, '--timeout', '5000'], { env });
  sizeAbove(xslt, 100);
  // The SDK call is inline so that the API it exercises is spelled once,
  // here, and changes with the SDK.
  const snippet = `import {launch} from ${JSON.stringify(pathToFileURL(path.join(sdk, 'dist', 'index.mjs')).href)};
    const s = await launch();
    const r = await s.screenshotURL(${JSON.stringify(`${base}/document.xml`)}, {mimeType: 'application/xml', timeoutMs: 5000});
    if (r.bytes < 100) throw new Error('native CFNetwork/XML output too small');
    await s.close();`;
  run(process.execPath, ['--input-type=module', '-e', snippet], { cwd: root, env });
}

server.kill();
process.stdout.write('\nverify-runtime: all stages passed\n');
