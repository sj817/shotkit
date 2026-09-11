import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

// The validation layer needs no engine, so this suite runs everywhere the
// package builds -- including node.yml, which has no addon.
import { DEFAULTS, prepare, validate, validateStart } from '../src/request.ts';

const rejects = (options, pattern) => assert.throws(() => validate(options), (error) => error instanceof TypeError && pattern.test(error.message), `expected ${pattern} for ${JSON.stringify(options)}`);

test('options follow shotium: names, defaults, ranges', async () => {
  const v = validate({ file: 'https://example.com/' });
  assert.deepEqual(v.source, { kind: 'url', url: 'https://example.com/' });
  assert.equal(v.type, 'png');
  assert.equal(v.width, DEFAULTS.width);
  assert.equal(v.height, DEFAULTS.height);
  assert.equal(v.timeout, DEFAULTS.timeout);
  assert.equal(v.quality, DEFAULTS.quality);
  const request = await prepare(v, 'ua-from-start');
  assert.equal(request.kind, 'url');
  assert.deepEqual([request.width, request.height, request.scale, request.timeoutMs, request.format, request.quality, request.userAgent, request.allowFileURLs],
    [1280, 720, 1, 30_000, 0, 0.9, 'ua-from-start', false]);

  const full = validate({
    html: '<p>x</p>', type: 'webp', quality: 42, scale: 2, fullPage: true, omitBackground: true, path: 'out.webp',
    pageGotoParams: { timeout: 5000, waitUntil: 'networkidle' }, viewport: { width: 320, height: 200 }, allowFileAccess: true,
    baseURL: 'https://example.com/a/', mimeType: 'application/xhtml+xml', userAgent: 'per-capture',
  });
  const prepared = await prepare(full, 'ua-from-start');
  assert.deepEqual([prepared.kind, prepared.format, prepared.quality, prepared.scale, prepared.fullPage, prepared.omitBackground, prepared.timeoutMs, prepared.width, prepared.height, prepared.allowFileURLs, prepared.baseURL, prepared.mimeType, prepared.userAgent],
    ['html', 1, 0.42, 2, true, true, 5000, 320, 200, true, 'https://example.com/a/', 'application/xhtml+xml', 'per-capture']);
  assert.equal(prepared.input.toString(), '<p>x</p>');
});

test('what the kernel cannot do is refused by name, not ignored', () => {
  rejects({ file: 'https://example.com/', clip: { x: 0, y: 0, width: 1, height: 1 } }, /"clip" is not supported/);
  rejects({ file: 'https://example.com/', headers: { a: 'b' } }, /"headers" is not supported/);
  rejects({ file: 'https://example.com/', cache: 'reload' }, /"cache" is not supported/);
  rejects({ file: 'https://example.com/', type: 'jpeg' }, /jpeg.*not available/);
  rejects({ file: 'https://example.com/', typo: 1 }, /unknown option "typo"/);
  rejects({ file: 'https://example.com/', viewport: { w: 1 } }, /unknown viewport option "w"/);
  rejects({ file: 'https://example.com/', pageGotoParams: { timeoutMs: 1 } }, /unknown pageGotoParams option/);
});

test('shape errors are TypeErrors that name the field', () => {
  rejects(undefined, /must be an object/);
  rejects({}, /exactly one of file and html/);
  rejects({ file: 'https://example.com/', html: '<p>' }, /exactly one of file and html/);
  rejects({ file: 'ftp://example.com/x' }, /file must be an http\(s\) URL/);
  rejects({ file: 'https://example.com/', quality: 101 }, /quality must be/);
  rejects({ file: 'https://example.com/', quality: 50 }, /quality applies to webp only/);
  rejects({ file: 'https://example.com/', type: 'webp-lossless', quality: 50 }, /quality applies to webp only/);
  rejects({ file: 'https://example.com/', scale: Number.NaN }, /scale must be/);
  rejects({ file: 'https://example.com/', scale: 9 }, /scale must be/);
  rejects({ file: 'https://example.com/', viewport: { width: 12.5 } }, /viewport.width must be a positive integer/);
  rejects({ file: 'https://example.com/', pageGotoParams: { timeout: 0 } }, /pageGotoParams.timeout/);
  rejects({ file: 'https://example.com/', pageGotoParams: { waitUntil: 'domcontentloaded' } }, /waitUntil must be load or networkidle/);
  rejects({ file: 'https://example.com/', selector: '' }, /selector must not be empty/);
  rejects({ file: 'https://example.com/', selector: '#a', fullPage: true }, /selector and fullPage are exclusive/);
  rejects({ file: 'https://example.com/', fullPage: 'yes' }, /fullPage must be a boolean/);
  rejects({ file: 'https://example.com/', baseURL: 'https://x/' }, /baseURL and mimeType apply to html and local files/);
});

test('a local file is read here and rendered with its own URL as the base', async () => {
  const directory = path.join(tmpdir(), 'shotkit-request-test');
  await mkdir(directory, { recursive: true });
  const page = path.join(directory, 'page 中文.xhtml');
  await writeFile(page, '<html xmlns="http://www.w3.org/1999/xhtml"><body>x</body></html>');
  try {
    for (const file of [page, pathToFileURL(page).href]) {
      const v = validate({ file });
      assert.deepEqual(v.source, { kind: 'file', path: page });
      const request = await prepare(v, '');
      assert.equal(request.kind, 'html');
      assert.equal(request.input.toString(), '<html xmlns="http://www.w3.org/1999/xhtml"><body>x</body></html>');
      assert.equal(request.baseURL, pathToFileURL(page).href);
      assert.equal(request.mimeType, 'application/xhtml+xml');
    }
    const overridden = await prepare(validate({ file: page, baseURL: 'https://cdn.example/', mimeType: 'text/html' }), '');
    assert.deepEqual([overridden.baseURL, overridden.mimeType], ['https://cdn.example/', 'text/html']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('start options: userAgent only; shotium cache options are refused by name', () => {
  assert.deepEqual(validateStart(undefined), { userAgent: '' });
  assert.deepEqual(validateStart({ userAgent: 'ua' }), { userAgent: 'ua' });
  assert.throws(() => validateStart({ cacheDir: null }), /"cacheDir" is not supported/);
  assert.throws(() => validateStart({ cacheMaxBytes: 1 }), /"cacheMaxBytes" is not supported/);
  assert.throws(() => validateStart({ resourceDir: 'x' }), /"resourceDir" is not supported/);
  assert.throws(() => validateStart({ nope: 1 }), /unknown start option "nope"/);
});
