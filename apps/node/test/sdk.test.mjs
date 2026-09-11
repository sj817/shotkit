import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';

// Self-reference by package name so the test exercises the published "exports"
// map rather than a build-output path that changes with the bundler.
import shotkit, { Runtime, runtime, screenshot, ShotKitError, start, status, stop } from '@pixel.js/shotkit';

const outputDirectory = path.join(tmpdir(), 'shotkit-node-sdk-test');

test('the surface mirrors shotium: module functions, a shared runtime, a default export', () => {
  assert.equal(typeof screenshot, 'function');
  assert.equal(typeof start, 'function');
  assert.equal(typeof status, 'function');
  assert.equal(typeof stop, 'function');
  assert.ok(runtime instanceof Runtime);
  assert.deepEqual(Object.keys(shotkit).sort(), ['Runtime', 'running', 'runtime', 'screenshot', 'start', 'status', 'stop']);
  assert.equal(shotkit.running, false);
  assert.deepEqual(status(), { running: false, enginePath: null, cacheDir: null, cacheActive: false });
});

test('screenshot returns {image, stats}, starts the engine on first use, and writes path instead of returning image', async () => {
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = path.join(outputDirectory, 'esm-output.webp');
  try {
    const [png, webp] = await Promise.all([
      screenshot({ html: '<!doctype html><style>body{background:#36c;color:white;font:32px sans-serif}</style><h1>Node ESM</h1>', viewport: { width: 360, height: 200 } }),
      screenshot({ html: '<!doctype html><style>body{background:#4b8;color:white;font:32px sans-serif}</style><h1>WebP</h1>', viewport: { width: 360, height: 200 }, type: 'webp', path: outputPath }),
    ]);
    assert.deepEqual([...png.image.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    assert.equal(png.stats.bytes, png.image.length);
    assert.ok(png.stats.timing.render > 0);
    assert.ok(png.stats.timing.total >= png.stats.timing.render);
    assert.equal(webp.image, null, 'path was given, so the image is not returned');
    assert.equal((await readFile(outputPath)).subarray(0, 4).toString(), 'RIFF');
    assert.equal(webp.stats.bytes, (await readFile(outputPath)).length);
    assert.equal(runtime.running, true);
    assert.equal(shotkit.running, true);
    assert.equal(typeof status().enginePath, 'string');
  } finally {
    await stop();
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test('captures are serialised on the kernel thread without blocking the event loop; stop waits for what is in flight', async () => {
  let timerTicks = 0;
  const timer = setInterval(() => ++timerTicks, 1);
  try {
    const completionOrder = [];
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => screenshot({
      html: `<style>body{margin:0;background:hsl(${index * 30} 70% 50%)}</style><h1>${index}</h1>`,
      viewport: { width: 320, height: 180 },
    }).then((result) => {
      completionOrder.push(index);
      return result;
    })));
    assert.equal(results.length, 8);
    assert.deepEqual(completionOrder, [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.ok(results.every((result) => result.image[0] === 0x89));
    assert.ok(timerTicks > 0, 'native rendering blocked the Node event loop');

    const render = screenshot({ html: '<style>body{height:1600px;background:linear-gradient(#123,#def)}</style>', viewport: { width: 800, height: 600 }, fullPage: true });
    const stopping = stop();
    const result = await render;
    await stopping;
    assert.ok(result.stats.bytes > 8);
    assert.equal(runtime.running, false);
    // A capture after stop() starts the engine again.
    assert.ok((await screenshot({ html: '<p>again</p>' })).stats.bytes > 8);
    assert.equal(runtime.running, true);
  } finally {
    clearInterval(timer);
    await stop();
  }
});

test('start is synchronous, idempotent, and refuses a different userAgent while running', async () => {
  const first = start({ userAgent: 'ShotKit-test/1' });
  assert.equal(first.running, true);
  assert.deepEqual(start({ userAgent: 'ShotKit-test/1' }), first);
  assert.throws(() => start({ userAgent: 'other' }), /already running with userAgent "ShotKit-test\/1"/);
  assert.throws(() => start({ cacheDir: null }), TypeError);
  await stop();
  assert.equal(start().running, true);
  await stop();
});

test('a local file is read by Node, rendered with its own base URL', async () => {
  await mkdir(outputDirectory, { recursive: true });
  const htmlPath = path.join(outputDirectory, 'input-中文.html');
  await writeFile(htmlPath, '<!doctype html><meta charset=utf-8><h1>HTML file</h1>');
  try {
    for (const file of [htmlPath, pathToFileURL(htmlPath).href]) {
      const result = await screenshot({ file, viewport: { width: 320, height: 180 } });
      assert.equal(result.image[0], 0x89);
    }
  } finally {
    await stop();
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test('invalid options are TypeErrors and leave the engine alive; kernel failures are ShotKitErrors', async () => {
  await assert.rejects(() => screenshot({ html: '<p>x</p>', quality: 101, type: 'webp' }), TypeError);
  await assert.rejects(() => screenshot({ html: '<p>x</p>', scale: Number.NaN }), TypeError);
  await assert.rejects(() => screenshot({ html: '<p>x</p>', viewport: { width: 12.5 } }), TypeError);
  await assert.rejects(() => screenshot({ html: '<p>x</p>', clip: { x: 0, y: 0, width: 1, height: 1 } }), /"clip" is not supported/);
  await assert.rejects(() => screenshot({ html: '<p>x</p>', type: 'jpeg' }), /jpeg/);
  await assert.rejects(() => screenshot({ file: 'https://127.0.0.1:1/unreachable', pageGotoParams: { timeout: 2000 } }), ShotKitError);
  const result = await screenshot({ html: '<p>still alive</p>', viewport: { width: 200, height: 100 } });
  assert.ok(result.stats.bytes > 8);
  await stop();
});

// PNG 尺寸就在 IHDR 里，读头 24 字节即可，不必引入解码依赖。
function pngSize(buffer) {
  assert.deepEqual([...buffer.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function firstPNGPixel(buffer) {
  assert.equal(buffer[24], 8, 'expected 8-bit PNG');
  assert.equal(buffer[25], 6, 'expected RGBA PNG');
  const chunks = [];
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT')
      chunks.push(buffer.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const scanline = inflateSync(Buffer.concat(chunks));
  assert.ok(scanline[0] <= 4, 'unsupported PNG row filter');
  // The first pixel has no left/up neighbours, so every PNG filter leaves its
  // four bytes unchanged.
  return [...scanline.subarray(1, 5)];
}

test('omitBackground preserves transparent page pixels', async () => {
  try {
    const html = '<!doctype html><style>html,body{margin:0;background:transparent}</style>';
    const opaque = await screenshot({ html, viewport: { width: 1, height: 1 } });
    const transparent = await screenshot({ html, viewport: { width: 1, height: 1 }, omitBackground: true });
    assert.equal(firstPNGPixel(opaque.image)[3], 255);
    assert.equal(firstPNGPixel(transparent.image)[3], 0);
  } finally {
    await stop();
  }
});

test('selector crops to the matched element instead of the viewport', async () => {
  try {
    const html = '<!doctype html><body style="margin:0;display:flex">'
      + '<div id="card" style="width:300px;height:200px;flex-shrink:0;background:#4a7"></div></body>';

    // 不传 selector：画幅是视口，右边留白。
    const full = await screenshot({ html, viewport: { width: 1280, height: 400 } });
    assert.deepEqual(pngSize(full.image), { width: 1280, height: 400 });

    // 传 selector：画幅收敛到元素自身。
    const cropped = await screenshot({ html, viewport: { width: 1280, height: 400 }, selector: '#card' });
    assert.deepEqual(pngSize(cropped.image), { width: 300, height: 200 });
  } finally {
    await stop();
  }
});

test('selector geometry accounts for zoom and honours scale', async () => {
  try {
    // 布局宽 600 + zoom:0.5 = 实占 300 CSS px，与模板里那套写法一致。
    const html = '<!doctype html><body style="margin:0;display:flex">'
      + '<div id="card" style="zoom:0.5;width:600px;height:400px;flex-shrink:0;background:#4a7"></div></body>';

    const cropped = await screenshot({ html, viewport: { width: 1280, height: 400 }, selector: '#card' });
    assert.deepEqual(pngSize(cropped.image), { width: 300, height: 200 });

    const retina = await screenshot({ html, viewport: { width: 1280, height: 400 }, selector: '#card', scale: 2 });
    assert.deepEqual(pngSize(retina.image), { width: 600, height: 400 });
  } finally {
    await stop();
  }
});

// 取的是元素边框盒，不是含 ink overflow 的绘制包围盒 —— 后者会被后代的阴影/绝对定位装饰撑大，
// 真实模板上实测能超出整个文档。
test('selector uses the border box, not the descendant ink overflow', async () => {
  try {
    const html = '<!doctype html><body style="margin:0;display:flex">'
      + '<div id="card" style="width:300px;height:200px;flex-shrink:0;background:#4a7">'
      + '<div style="position:absolute;left:900px;top:900px;width:200px;height:200px;background:#c44"></div>'
      + '<div style="width:10px;height:10px;box-shadow:0 0 0 400px #00f"></div>'
      + '</div></body>';
    const cropped = await screenshot({ html, viewport: { width: 1280, height: 400 }, selector: '#card' });
    assert.deepEqual(pngSize(cropped.image), { width: 300, height: 200 });
  } finally {
    await stop();
  }
});

test('selector taller than the viewport is captured whole', async () => {
  try {
    const html = '<!doctype html><body style="margin:0;display:flex">'
      + '<div id="card" style="width:300px;height:2000px;flex-shrink:0;background:#4a7"></div></body>';
    const cropped = await screenshot({ html, viewport: { width: 1280, height: 400 }, selector: '#card' });
    assert.deepEqual(pngSize(cropped.image), { width: 300, height: 2000 });
  } finally {
    await stop();
  }
});

test('a selector that matches nothing rejects without killing the process', async () => {
  try {
    await assert.rejects(
      () => screenshot({ html: '<div id="card">x</div>', selector: '#missing' }),
      (error) => error instanceof ShotKitError && /selector matched no element/.test(error.message),
    );
    await assert.rejects(
      () => screenshot({ html: '<div id="card">x</div>', selector: ':::nonsense' }),
      ShotKitError,
    );
    await assert.rejects(
      () => screenshot({ html: '<div id="card" style="display:none">x</div>', selector: '#card' }),
      (error) => error instanceof ShotKitError && /not rendered/.test(error.message),
    );
    // 进程要活着。
    const result = await screenshot({ html: '<p>still alive</p>', viewport: { width: 200, height: 100 } });
    assert.ok(result.stats.bytes > 8);
  } finally {
    await stop();
  }
});

// The kernel gates only a file: main document (see renderURLToImage in
// shot/kernel/ShotPage.cpp); subresources next to a local page always load.
// allowFileAccess is accepted for shotium compatibility and passed through.
test('a local file resolves relative subresources next to itself', async () => {
  await mkdir(outputDirectory, { recursive: true });
  const cssPath = path.join(outputDirectory, 'local.css');
  const htmlPath = path.join(outputDirectory, 'local.html');
  await writeFile(cssPath, 'html,body{margin:0;background:#00f}');
  await writeFile(htmlPath, '<!doctype html><style>html,body{margin:0;background:#f00}</style><link rel="stylesheet" href="local.css">');
  try {
    const result = await screenshot({ file: htmlPath, viewport: { width: 1, height: 1 }, allowFileAccess: true });
    assert.deepEqual(firstPNGPixel(result.image).slice(0, 3), [0, 0, 255]);
    // Without a base of its own, the same markup as a string has nowhere to resolve the stylesheet.
    const detached = await screenshot({ html: await readFile(htmlPath, 'utf8'), viewport: { width: 1, height: 1 } });
    assert.deepEqual(firstPNGPixel(detached.image).slice(0, 3), [255, 0, 0]);
    const rebased = await screenshot({ html: await readFile(htmlPath, 'utf8'), viewport: { width: 1, height: 1 }, baseURL: pathToFileURL(htmlPath).href });
    assert.deepEqual(firstPNGPixel(rebased.image).slice(0, 3), [0, 0, 255]);
  } finally {
    await stop();
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
