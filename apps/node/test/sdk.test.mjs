import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';

// Self-reference by package name so the test exercises the published "exports"
// map rather than a build-output path that changes with the bundler.
import { launch, ShotKitError } from '@shotkit/node';

const outputDirectory = path.join(tmpdir(), 'shotkit-node-sdk-test');

test('native ESM client returns buffers and writes optional output', async () => {
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

test('multiple handles share a non-blocking FIFO renderer', async () => {
  const [first, second] = await Promise.all([launch(), launch()]);
  let timerTicks = 0;
  const timer = setInterval(() => ++timerTicks, 1);
  try {
    const completionOrder = [];
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => {
      const handle = index % 2 ? first : second;
      return handle.screenshotHTML(`<style>body{margin:0;background:hsl(${index * 30} 70% 50%)}</style><h1>${index}</h1>`, {
        width: 320,
        height: 180,
      }).then((result) => {
        completionOrder.push(index);
        return result;
      });
    }));
    assert.equal(results.length, 8);
    assert.deepEqual(completionOrder, [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.ok(results.every((result) => result.data[0] === 0x89));
    assert.ok(timerTicks > 0, 'native rendering blocked the Node event loop');

    await first.close();
    await assert.rejects(() => first.screenshotHTML('<p>closed</p>'), ShotKitError);
    assert.ok((await second.screenshotHTML('<p>still open</p>')).bytes > 8);
  } finally {
    clearInterval(timer);
    await first.close();
    await second.close();
  }
});

test('close waits for requests already submitted by that handle', async () => {
  const shot = await launch();
  const render = shot.screenshotHTML('<style>body{height:1600px;background:linear-gradient(#123,#def)}</style>', {
    width: 800,
    height: 600,
    fullPage: true,
  });
  const closing = shot.close();
  const result = await render;
  await closing;
  assert.ok(result.bytes > 8);
});

test('htmlFile is read by Node and does not require a native file API', async () => {
  await mkdir(outputDirectory, { recursive: true });
  const htmlPath = path.join(outputDirectory, 'input-中文.html');
  await writeFile(htmlPath, '<!doctype html><meta charset=utf-8><h1>HTML file</h1>');
  const shot = await launch();
  try {
    const result = await shot.screenshot({ htmlFile: htmlPath, width: 320, height: 180 });
    assert.equal(result.data[0], 0x89);
    assert.equal(result.outputPath, undefined);
  } finally {
    await shot.close();
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test('invalid options reject without killing the persistent process', async () => {
  const shot = await launch();
  try {
    await assert.rejects(() => shot.screenshotHTML('<p>x</p>', { quality: 101 }), ShotKitError);
    await assert.rejects(() => shot.screenshotHTML('<p>x</p>', { scale: Number.NaN }), ShotKitError);
    await assert.rejects(() => shot.screenshotHTML('<p>x</p>', { width: 12.5 }), ShotKitError);
    const result = await shot.screenshotHTML('<p>still alive</p>', { width: 200, height: 100 });
    assert.ok(result.bytes > 8);
  } finally {
    await shot.close();
  }
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
  const shot = await launch();
  try {
    const html = '<!doctype html><style>html,body{margin:0;background:transparent}</style>';
    const opaque = await shot.screenshotHTML(html, { width: 1, height: 1 });
    const transparent = await shot.screenshotHTML(html, { width: 1, height: 1, omitBackground: true });
    assert.equal(firstPNGPixel(opaque)[3], 255);
    assert.equal(firstPNGPixel(transparent)[3], 0);
  } finally {
    await shot.close();
  }
});

test('selector crops to the matched element instead of the viewport', async () => {
  const shot = await launch();
  try {
    const html = '<!doctype html><body style="margin:0;display:flex">'
      + '<div id="card" style="width:300px;height:200px;flex-shrink:0;background:#4a7"></div></body>';

    // 不传 selector：画幅是视口，右边留白。
    const full = await shot.screenshotHTML(html, { width: 1280, height: 400 });
    assert.deepEqual(pngSize(full.data), { width: 1280, height: 400 });

    // 传 selector：画幅收敛到元素自身。
    const cropped = await shot.screenshotHTML(html, { width: 1280, height: 400, selector: '#card' });
    assert.deepEqual(pngSize(cropped.data), { width: 300, height: 200 });
  } finally {
    await shot.close();
  }
});

test('selector geometry accounts for zoom and honours deviceScale', async () => {
  const shot = await launch();
  try {
    // 布局宽 600 + zoom:0.5 = 实占 300 CSS px，与模板里那套写法一致。
    const html = '<!doctype html><body style="margin:0;display:flex">'
      + '<div id="card" style="zoom:0.5;width:600px;height:400px;flex-shrink:0;background:#4a7"></div></body>';

    const cropped = await shot.screenshotHTML(html, { width: 1280, height: 400, selector: '#card' });
    assert.deepEqual(pngSize(cropped.data), { width: 300, height: 200 });

    const retina = await shot.screenshotHTML(html, { width: 1280, height: 400, selector: '#card', scale: 2 });
    assert.deepEqual(pngSize(retina.data), { width: 600, height: 400 });
  } finally {
    await shot.close();
  }
});

// 取的是元素边框盒，不是含 ink overflow 的绘制包围盒 —— 后者会被后代的阴影/绝对定位装饰撑大，
// 真实模板上实测能超出整个文档。
test('selector uses the border box, not the descendant ink overflow', async () => {
  const shot = await launch();
  try {
    const html = '<!doctype html><body style="margin:0;display:flex">'
      + '<div id="card" style="width:300px;height:200px;flex-shrink:0;background:#4a7">'
      + '<div style="position:absolute;left:900px;top:900px;width:200px;height:200px;background:#c44"></div>'
      + '<div style="width:10px;height:10px;box-shadow:0 0 0 400px #00f"></div>'
      + '</div></body>';
    const cropped = await shot.screenshotHTML(html, { width: 1280, height: 400, selector: '#card' });
    assert.deepEqual(pngSize(cropped.data), { width: 300, height: 200 });
  } finally {
    await shot.close();
  }
});

test('selector taller than the viewport is captured whole', async () => {
  const shot = await launch();
  try {
    const html = '<!doctype html><body style="margin:0;display:flex">'
      + '<div id="card" style="width:300px;height:2000px;flex-shrink:0;background:#4a7"></div></body>';
    const cropped = await shot.screenshotHTML(html, { width: 1280, height: 400, selector: '#card' });
    assert.deepEqual(pngSize(cropped.data), { width: 300, height: 2000 });
  } finally {
    await shot.close();
  }
});

test('a selector that matches nothing rejects without killing the process', async () => {
  const shot = await launch();
  try {
    await assert.rejects(
      () => shot.screenshotHTML('<div id="card">x</div>', { selector: '#missing' }),
      (error) => error instanceof ShotKitError && /selector matched no element/.test(error.message),
    );
    await assert.rejects(
      () => shot.screenshotHTML('<div id="card">x</div>', { selector: ':::nonsense' }),
      ShotKitError,
    );
    await assert.rejects(
      () => shot.screenshotHTML('<div id="card" style="display:none">x</div>', { selector: '#card' }),
      (error) => error instanceof ShotKitError && /not rendered/.test(error.message),
    );
    // 进程要活着。
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
