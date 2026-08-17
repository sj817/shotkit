import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { launch } from '../dist/index.mjs';

const run = promisify(execFile);
const cli = process.argv[2];
if (!cli)
  throw new Error('usage: node native-parity.mjs <shotcli>');

const directory = await mkdtemp(path.join(tmpdir(), 'shotkit-parity-'));
const htmlPath = path.join(directory, 'fixture.html');
const html = '<!doctype html><style>html,body{margin:0;width:100%;height:100%;background:#2468ac}.box{width:160px;height:90px;background:#f2a900}</style><div class=box></div>';
await writeFile(htmlPath, html);

const shot = await launch();
try {
  for (const format of ['png', 'webp-lossless']) {
    const cliPath = path.join(directory, `cli.${format === 'png' ? 'png' : 'webp'}`);
    await run(cli, ['--html', htmlPath, '--out', cliPath, '--format', format, '--width', '320', '--height', '180']);
    const native = await shot.screenshotHTML(html, { format, width: 320, height: 180 });
    assert.deepEqual(native.data, await readFile(cliPath), `${format} differs between shot.node and shotcli`);
  }
} finally {
  await shot.close();
  await rm(directory, { recursive: true, force: true });
}

console.log('shot.node and shotcli parity passed');
