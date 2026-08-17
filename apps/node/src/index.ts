import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { ShotKitError } from './error.js';
import { loadNativeBinding, type NativeBinding, type NativeRenderRequest, type NativeRenderResult } from './native.js';

export { ShotKitError } from './error.js';

export type ImageFormat = 'png' | 'webp' | 'webp-lossless';

export interface ScreenshotSettings {
  outputPath?: string;
  format?: ImageFormat;
  quality?: number;
  width?: number;
  height?: number;
  scale?: number;
  fullPage?: boolean;
  /** Preserve transparent page pixels instead of compositing them over white. */
  omitBackground?: boolean;
  /** Crop to the first matching element; takes precedence over fullPage. */
  selector?: string;
  timeoutMs?: number;
  baseURL?: string;
  userAgent?: string;
  mimeType?: string;
  allowFileURLs?: boolean;
}

export type ScreenshotOptions = ScreenshotSettings & (
  | { url: string; html?: never; htmlFile?: never }
  | { html: string; url?: never; htmlFile?: never }
  | { htmlFile: string; url?: never; html?: never }
);

export interface ScreenshotResult {
  /** Encoded PNG/WebP bytes backed directly by ShotKit's native allocation. */
  data: Buffer;
  bytes: number;
  /** Native render and encode time. Queueing and file I/O are excluded. */
  durationMs: number;
  /** Complete Node-side latency, including queueing and optional file I/O. */
  elapsedMs: number;
  outputPath?: string;
}

function nativeError(error: unknown): ShotKitError {
  if (error instanceof ShotKitError)
    return error;
  if (error instanceof Error) {
    const candidate = error as Error & { status?: unknown };
    return new ShotKitError(error.message, typeof candidate.status === 'number' ? candidate.status : undefined);
  }
  return new ShotKitError(String(error));
}

function formatCode(format: ImageFormat): number {
  switch (format) {
    case 'webp': return 1;
    case 'webp-lossless': return 2;
    default: return 0;
  }
}

/** A logical handle over the process-wide native ShotKit render queue. */
export class ShotKit {
  private readonly binding: NativeBinding;
  private readonly pending = new Set<Promise<unknown>>();
  private closing = false;
  private closed = false;

  private constructor(binding: NativeBinding) {
    this.binding = binding;
  }

  static async launch(): Promise<ShotKit> {
    const binding = loadNativeBinding();
    try {
      await binding.initialize();
    } catch (error) {
      throw nativeError(error);
    }
    return new ShotKit(binding);
  }

  async screenshot(options: ScreenshotOptions): Promise<ScreenshotResult> {
    if (this.closing || this.closed)
      throw new ShotKitError('ShotKit handle is closing or closed');
    const operation = this.performScreenshot(options);
    this.pending.add(operation);
    try {
      return await operation;
    } finally {
      this.pending.delete(operation);
    }
  }

  private async performScreenshot(options: ScreenshotOptions): Promise<ScreenshotResult> {
    const start = performance.now();
    if (!options || typeof options !== 'object')
      throw new ShotKitError('screenshot options must be an object');
    const inputCount = Number(options.url !== undefined) + Number(options.html !== undefined) + Number(options.htmlFile !== undefined);
    if (inputCount !== 1)
      throw new ShotKitError('provide exactly one of url, html, or htmlFile');
    if (options.url !== undefined && typeof options.url !== 'string'
        || options.html !== undefined && typeof options.html !== 'string'
        || options.htmlFile !== undefined && typeof options.htmlFile !== 'string')
      throw new ShotKitError('url, html, and htmlFile inputs must be strings');
    if (options.outputPath !== undefined && typeof options.outputPath !== 'string')
      throw new ShotKitError('outputPath must be a string');
    if (options.format !== undefined && !['png', 'webp', 'webp-lossless'].includes(options.format))
      throw new ShotKitError('format must be png, webp, or webp-lossless');
    if (options.quality !== undefined && (!Number.isFinite(options.quality) || options.quality < 0 || options.quality > 100))
      throw new ShotKitError('quality must be between 0 and 100');
    if (options.omitBackground !== undefined && typeof options.omitBackground !== 'boolean')
      throw new ShotKitError('omitBackground must be a boolean');
    const width = options.width ?? 1280;
    const height = options.height ?? 800;
    const scale = options.scale ?? 1;
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(width) || !Number.isInteger(height) || !Number.isInteger(timeoutMs)
        || !Number.isFinite(scale) || width <= 0 || height <= 0 || scale <= 0 || timeoutMs <= 0)
      throw new ShotKitError('width, height, and timeoutMs must be positive integers; scale must be finite and positive');

    let kind: 'url' | 'html';
    let input: string | Buffer;
    if (options.url !== undefined) {
      kind = 'url';
      input = options.url;
    } else {
      kind = 'html';
      input = options.htmlFile !== undefined
        ? await readFile(path.resolve(options.htmlFile))
        : Buffer.from(options.html ?? '', 'utf8');
    }

    const request: NativeRenderRequest = {
      kind,
      input,
      width,
      height,
      scale,
      fullPage: options.fullPage ?? false,
      omitBackground: options.omitBackground ?? false,
      timeoutMs,
      allowFileURLs: options.allowFileURLs ?? false,
      format: formatCode(options.format ?? 'png'),
      quality: (options.quality ?? 80) / 100,
      userAgent: options.userAgent ?? '',
      baseURL: options.baseURL ?? '',
      mimeType: options.mimeType ?? 'text/html',
      selector: options.selector ?? '',
    };

    let nativeResult: NativeRenderResult;
    try {
      nativeResult = await this.binding.render(request);
    } catch (error) {
      throw nativeError(error);
    }

    const outputPath = options.outputPath ? path.resolve(options.outputPath) : undefined;
    if (outputPath) {
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, nativeResult.data);
    }
    return {
      data: nativeResult.data,
      bytes: nativeResult.bytes,
      durationMs: nativeResult.durationMs,
      elapsedMs: performance.now() - start,
      outputPath,
    };
  }

  screenshotURL(url: string, options: ScreenshotSettings = {}): Promise<ScreenshotResult> {
    return this.screenshot({ ...options, url });
  }

  screenshotHTML(html: string, options: ScreenshotSettings = {}): Promise<ScreenshotResult> {
    return this.screenshot({ ...options, html });
  }

  async close(): Promise<void> {
    if (this.closed)
      return;
    if (this.closing) {
      await Promise.allSettled([...this.pending]);
      return;
    }
    this.closing = true;
    await Promise.allSettled([...this.pending]);
    this.closed = true;
  }
}

export function launch(): Promise<ShotKit> {
  return ShotKit.launch();
}
