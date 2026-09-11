// Turn ScreenshotOptions into the request the addon takes, refusing anything
// it would silently ignore.
//
// Every key is checked against an allow-list, the way shotium's request
// layer does: an option the kernel has no counterpart for -- `clip`,
// `headers`, `cache` -- is a TypeError naming it, and so is a misspelt one.
// Validation is synchronous and pure so it can be tested without an engine;
// reading a local `file` is the one asynchronous step and happens in
// `prepare`.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { NativeRenderRequest } from './native.js';
import type { ImageType, ScreenshotOptions, StartOptions } from './types.js';

const OPTIONS = new Set([
  'file', 'html', 'type', 'quality', 'scale', 'fullPage', 'selector', 'omitBackground', 'path',
  'pageGotoParams', 'viewport', 'allowFileAccess', 'baseURL', 'mimeType', 'userAgent',
]);
const UNSUPPORTED: Record<string, string> = {
  clip: 'the kernel captures the viewport, the document or a selector; crop the image afterwards',
  headers: 'the kernel sends no custom request headers',
  cache: 'ShotKit keeps no HTTP disk cache',
};
const TYPES: Record<ImageType, number> = { png: 0, webp: 1, 'webp-lossless': 2 };
const MIME_BY_EXTENSION: Record<string, string> = {
  '.xhtml': 'application/xhtml+xml', '.xht': 'application/xhtml+xml', '.xml': 'application/xml', '.svg': 'image/svg+xml',
};

export const DEFAULTS = {
  width: 1280, height: 720, quality: 90, scale: 1, timeout: 30_000, mimeType: 'text/html',
} as const;

function fail(message: string): never {
  throw new TypeError(message);
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) fail(`${name} must be a positive integer`);
  return value;
}

function bool(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') fail(`${name} must be a boolean`);
  return value;
}

function str(value: unknown, name: string): string {
  if (typeof value !== 'string') fail(`${name} must be a string`);
  return value;
}

/** The validated, normalised form of ScreenshotOptions: every field present. */
export interface Validated {
  source: { kind: 'url'; url: string } | { kind: 'html'; html: string } | { kind: 'file'; path: string };
  type: ImageType;
  quality: number;
  scale: number;
  fullPage: boolean;
  selector: string;
  omitBackground: boolean;
  path: string | undefined;
  timeout: number;
  width: number;
  height: number;
  allowFileAccess: boolean;
  baseURL: string | undefined;
  mimeType: string | undefined;
  userAgent: string | undefined;
}

export function validate(options: unknown): Validated {
  if (!isObject(options)) fail('screenshot options must be an object');
  for (const key of Object.keys(options)) {
    if (key in UNSUPPORTED) fail(`"${key}" is not supported by @pixel.js/shotkit: ${UNSUPPORTED[key]}`);
    if (!OPTIONS.has(key)) fail(`unknown option "${key}"`);
  }
  const o = options as ScreenshotOptions;

  if ((o.file === undefined) === (o.html === undefined)) fail('exactly one of file and html is required');
  let source: Validated['source'];
  if (o.html !== undefined) {
    source = { kind: 'html', html: str(o.html, 'html') };
  } else {
    const file = str(o.file, 'file');
    if (file.length === 0) fail('file must not be empty');
    if (/^https?:\/\//i.test(file)) source = { kind: 'url', url: file };
    else if (/^file:/i.test(file)) source = { kind: 'file', path: fileURLToPath(file) };
    else if (/^[a-z][a-z0-9+.-]*:/i.test(file) && !/^[a-zA-Z]:[\\/]/.test(file)) fail(`file must be an http(s) URL, a file: URL or a local path, not ${file.split(':')[0]}:`);
    else source = { kind: 'file', path: path.resolve(file) };
  }

  const type = o.type ?? 'png';
  if (type === ('jpeg' as string)) fail('type "jpeg" is not available in @pixel.js/shotkit; use png, webp or webp-lossless');
  if (!(type in TYPES)) fail('type must be png, webp or webp-lossless');
  if (o.quality !== undefined) {
    if (typeof o.quality !== 'number' || !Number.isFinite(o.quality) || o.quality < 1 || o.quality > 100) fail('quality must be a number from 1 to 100');
    if (type !== 'webp') fail(`quality applies to webp only; ${type} is lossless`);
  }
  const scale = o.scale ?? DEFAULTS.scale;
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale < 0.01 || scale > 8) fail('scale must be a number from 0.01 to 8');
  const fullPage = o.fullPage === undefined ? false : bool(o.fullPage, 'fullPage');
  const omitBackground = o.omitBackground === undefined ? false : bool(o.omitBackground, 'omitBackground');
  const selector = o.selector === undefined ? '' : str(o.selector, 'selector');
  if (o.selector !== undefined && selector.length === 0) fail('selector must not be empty');
  if (selector && fullPage) fail('selector and fullPage are exclusive: a selector already sets the capture area');
  const filePath = o.path === undefined ? undefined : str(o.path, 'path');

  let timeout: number = DEFAULTS.timeout;
  if (o.pageGotoParams !== undefined) {
    if (!isObject(o.pageGotoParams)) fail('pageGotoParams must be an object');
    for (const key of Object.keys(o.pageGotoParams)) if (key !== 'timeout' && key !== 'waitUntil') fail(`unknown pageGotoParams option "${key}"`);
    if (o.pageGotoParams.timeout !== undefined) timeout = positiveInteger(o.pageGotoParams.timeout, 'pageGotoParams.timeout');
    const waitUntil: unknown = o.pageGotoParams.waitUntil;
    if (waitUntil !== undefined && waitUntil !== 'load' && waitUntil !== 'networkidle') fail('pageGotoParams.waitUntil must be load or networkidle');
  }

  let width: number = DEFAULTS.width;
  let height: number = DEFAULTS.height;
  if (o.viewport !== undefined) {
    if (!isObject(o.viewport)) fail('viewport must be an object');
    for (const key of Object.keys(o.viewport)) if (key !== 'width' && key !== 'height') fail(`unknown viewport option "${key}"`);
    if (o.viewport.width !== undefined) width = positiveInteger(o.viewport.width, 'viewport.width');
    if (o.viewport.height !== undefined) height = positiveInteger(o.viewport.height, 'viewport.height');
  }

  const allowFileAccess = o.allowFileAccess === undefined ? false : bool(o.allowFileAccess, 'allowFileAccess');
  const baseURL = o.baseURL === undefined ? undefined : str(o.baseURL, 'baseURL');
  const mimeType = o.mimeType === undefined ? undefined : str(o.mimeType, 'mimeType');
  const userAgent = o.userAgent === undefined ? undefined : str(o.userAgent, 'userAgent');
  if (source.kind === 'url' && (baseURL !== undefined || mimeType !== undefined)) fail('baseURL and mimeType apply to html and local files, not to an http(s) URL');

  return {
    source, type, quality: o.quality ?? DEFAULTS.quality, scale, fullPage, selector, omitBackground, path: filePath,
    timeout, width, height, allowFileAccess, baseURL, mimeType, userAgent,
  };
}

/** The request the addon takes, from validated options. Reads a local file. */
export async function prepare(validated: Validated, defaultUserAgent: string): Promise<NativeRenderRequest> {
  let kind: 'url' | 'html';
  let input: string | Buffer;
  let baseURL = validated.baseURL ?? '';
  let mimeType = validated.mimeType ?? DEFAULTS.mimeType;
  if (validated.source.kind === 'url') {
    kind = 'url';
    input = validated.source.url;
  } else if (validated.source.kind === 'html') {
    kind = 'html';
    input = Buffer.from(validated.source.html, 'utf8');
  } else {
    // Read by Node, rendered as HTML with the file's own URL as its base:
    // relative subresources resolve next to it and stay behind
    // allowFileAccess, the same policy shotium applies to a local file.
    kind = 'html';
    input = await readFile(validated.source.path);
    if (validated.baseURL === undefined) baseURL = pathToFileURL(validated.source.path).href;
    if (validated.mimeType === undefined) mimeType = MIME_BY_EXTENSION[path.extname(validated.source.path).toLowerCase()] ?? DEFAULTS.mimeType;
  }
  return {
    kind, input,
    width: validated.width, height: validated.height, scale: validated.scale,
    fullPage: validated.fullPage, omitBackground: validated.omitBackground,
    timeoutMs: validated.timeout, allowFileURLs: validated.allowFileAccess,
    format: TYPES[validated.type], quality: validated.quality / 100,
    userAgent: validated.userAgent ?? defaultUserAgent, baseURL, mimeType, selector: validated.selector,
  };
}

const START_OPTIONS = new Set(['userAgent']);
const START_UNSUPPORTED: Record<string, string> = {
  cacheDir: 'ShotKit keeps no HTTP disk cache',
  cacheMaxBytes: 'ShotKit keeps no HTTP disk cache',
  resourceDir: 'the kernel carries its resources inside libshot',
};

export function validateStart(options: unknown): Required<StartOptions> {
  if (options === undefined) return { userAgent: '' };
  if (!isObject(options)) fail('start options must be an object');
  for (const key of Object.keys(options)) {
    if (key in START_UNSUPPORTED) fail(`"${key}" is not supported by @pixel.js/shotkit: ${START_UNSUPPORTED[key]}`);
    if (!START_OPTIONS.has(key)) fail(`unknown start option "${key}"`);
  }
  const o = options as StartOptions;
  return { userAgent: o.userAgent === undefined ? '' : str(o.userAgent, 'userAgent') };
}
