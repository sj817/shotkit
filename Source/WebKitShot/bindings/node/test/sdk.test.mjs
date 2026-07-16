import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { launch, ShotKitError } from '../dist/index.js';

const outputDirectory = path.join(tmpdir(), 'shotkit-node-sdk-test');

test('persistent ESM client returns buffers and writes optional output', async () => {
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = path.join(outputDirectory, 'esm-output.webp');
  const shot = await launch();
  try {
    const [png, webp] = await Promise.all([
      shot.screenshotHTML('<!doctype html><style>body{background:#36c;color:white;font:32px sans-serif}</style><h1>Node ESM</h1>', { width: 360, height: 200 }),
      shot.screenshotHTML('<!doctype html><style>body{background:#4b8;color:white;font:32px sans-serif}</style><h1>WebP</h1>', { width: 360, height: 200, format: 'webp', outputPath }),
    ]);
    assert.deepEqual([...png.data.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    assert.equal(webp.data.subarray(0, 4).toString(), 'RIFF');
    assert.equal(webp.outputPath, outputPath);
    assert.deepEqual(await readFile(outputPath), webp.data);
    assert.ok(png.durationMs > 0);
    assert.ok(png.elapsedMs >= png.durationMs);
  } finally {
    await shot.close();
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test('invalid options reject without killing the persistent process', async () => {
  const shot = await launch();
  try {
    await assert.rejects(() => shot.screenshotHTML('<p>x</p>', { quality: 101 }), ShotKitError);
    const result = await shot.screenshotHTML('<p>still alive</p>', { width: 200, height: 100 });
    assert.ok(result.bytes > 8);
  } finally {
    await shot.close();
  }
});

test('file URL input works when explicitly allowed', async () => {
  await mkdir(outputDirectory, { recursive: true });
  const htmlPath = path.join(outputDirectory, 'local.html');
  await writeFile(htmlPath, '<!doctype html><style>body{background:#eef;color:#225}</style><h1>file URL</h1>');
  const shot = await launch();
  try {
    const result = await shot.screenshotURL(pathToFileURL(htmlPath).href, {
      allowFileURLs: true,
      width: 320,
      height: 180,
    });
    assert.deepEqual([...result.data.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  } finally {
    await shot.close();
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
