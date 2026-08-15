import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';

import { ShotKitError } from './error.js';
import { resolveExecutable } from './executable.js';

export { ShotKitError } from './error.js';

export type ImageFormat = 'png' | 'webp' | 'webp-lossless';

export interface ShotKitLaunchOptions {
  /** Explicit shotcli path. Highest-priority executable selection. */
  executablePath?: string;
  /** Environment passed to shotcli in addition to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Maximum time to wait for the persistent process ready message. */
  launchTimeoutMs?: number;
}

export interface ScreenshotSettings {
  outputPath?: string;
  format?: ImageFormat;
  quality?: number;
  width?: number;
  height?: number;
  scale?: number;
  fullPage?: boolean;
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
  /** Encoded PNG/WebP bytes. */
  data: Buffer;
  /** Encoded byte length reported by ShotKit. */
  bytes: number;
  /** Render + encode + output write time measured inside shotcli. */
  durationMs: number;
  /** Full Node-side request round-trip including reading the result Buffer. */
  elapsedMs: number;
  /** Absolute path when outputPath was supplied. */
  outputPath?: string;
}

interface ShotResponse {
  id?: number;
  ready?: boolean;
  protocol?: number;
  ok?: boolean;
  status?: number;
  bytes?: number;
  duration_ms?: number;
  error?: string;
  shutdown?: boolean;
}

interface PendingRequest {
  resolve(response: ShotResponse): void;
  reject(error: Error): void;
}

function timeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ShotKitError(message)), milliseconds);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error: unknown) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * One persistent ShotKit renderer process. Calls are safe to issue concurrently;
 * ShotKit serializes them on its required render thread and resolves by request id.
 */
export class ShotKit {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly temporaryDirectory: string;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly exitPromise: Promise<void>;
  private readonly readyPromise: Promise<void>;
  private nextID = 1;
  private nextTemporaryImage = 1;
  private closing = false;
  private closed = false;
  private stderr = '';

  private constructor(executable: string, temporaryDirectory: string, options: ShotKitLaunchOptions) {
    this.temporaryDirectory = temporaryDirectory;
    this.child = spawn(executable, ['--serve'], {
      cwd: path.dirname(executable),
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    let readyReceived = false;
    this.readyPromise = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    this.exitPromise = new Promise((resolve, reject) => {
      this.child.once('error', (error) => {
        const wrapped = new ShotKitError(`failed to start shotcli: ${error.message}`);
        rejectReady(wrapped);
        this.rejectPending(wrapped);
        reject(wrapped);
      });
      this.child.once('exit', (code, signal) => {
        this.closed = true;
        if (code === 0) {
          if (!readyReceived || this.pending.size) {
            const error = new ShotKitError('shotcli exited before completing active requests');
            rejectReady(error);
            this.rejectPending(error);
          }
          resolve();
          return;
        }
        const detail = this.stderr.trim();
        const error = new ShotKitError(`shotcli exited with code ${code ?? 'null'}${signal ? ` (${signal})` : ''}${detail ? `: ${detail}` : ''}`);
        rejectReady(error);
        this.rejectPending(error);
        reject(error);
      });
    });

    this.child.stderr.on('data', (chunk: Buffer) => this.stderr += chunk.toString());
    const reader = createInterface({ input: this.child.stdout });
    reader.on('line', (line) => {
      let response: ShotResponse;
      try {
        response = JSON.parse(line) as ShotResponse;
      } catch {
        this.rejectPending(new ShotKitError(`invalid JSON from shotcli: ${line}`));
        return;
      }
      if (response.ready !== undefined) {
        if (response.ready) {
          readyReceived = true;
          resolveReady();
        } else
          rejectReady(new ShotKitError(response.error || 'shotcli initialization failed'));
        return;
      }
      if (response.id === undefined)
        return;
      const request = this.pending.get(response.id);
      if (!request)
        return;
      this.pending.delete(response.id);
      if (response.ok)
        request.resolve(response);
      else
        request.reject(new ShotKitError(response.error || `ShotKit status ${response.status}`, response.status));
    });
  }

  static async launch(options: ShotKitLaunchOptions = {}): Promise<ShotKit> {
    const executable = await resolveExecutable(options.executablePath);
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'shotkit-node-'));
    const instance = new ShotKit(executable, temporaryDirectory, options);
    try {
      await timeout(instance.readyPromise, options.launchTimeoutMs ?? 15_000, 'timed out waiting for shotcli to initialize');
      return instance;
    } catch (error) {
      instance.child.kill();
      await rm(temporaryDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values())
      request.reject(error);
    this.pending.clear();
  }

  private dispatch(payload: Record<string, unknown>): Promise<ShotResponse> {
    if (this.closed)
      return Promise.reject(new ShotKitError('ShotKit process is closed'));
    const id = this.nextID++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, (error) => {
        if (!error)
          return;
        this.pending.delete(id);
        reject(new ShotKitError(`failed to write request to shotcli: ${error.message}`));
      });
    });
  }

  async screenshot(options: ScreenshotOptions): Promise<ScreenshotResult> {
    if (this.closing || this.closed)
      throw new ShotKitError('ShotKit process is closing or closed');
    const inputCount = Number(options.url !== undefined) + Number(options.html !== undefined) + Number(options.htmlFile !== undefined);
    if (inputCount !== 1)
      throw new ShotKitError('provide exactly one of url, html, or htmlFile');
    if (options.quality !== undefined && (options.quality < 0 || options.quality > 100))
      throw new ShotKitError('quality must be between 0 and 100');

    const format = options.format ?? 'png';
    const extension = format === 'png' ? 'png' : 'webp';
    const requestedOutput = options.outputPath ? path.resolve(options.outputPath) : undefined;
    const outputPath = requestedOutput ?? path.join(this.temporaryDirectory, `${this.nextTemporaryImage++}.${extension}`);
    await mkdir(path.dirname(outputPath), { recursive: true });

    const request: Record<string, unknown> = {
      out: outputPath,
      format,
      width: options.width ?? 1280,
      height: options.height ?? 800,
      scale: options.scale ?? 1,
      full_page: options.fullPage ?? false,
      timeout_ms: options.timeoutMs ?? 30_000,
      allow_file_urls: options.allowFileURLs ?? false,
    };
    if (options.url !== undefined)
      request.url = options.url;
    if (options.html !== undefined)
      request.html = options.html;
    if (options.htmlFile !== undefined)
      request.html_file = path.resolve(options.htmlFile);
    if (options.quality !== undefined)
      request.quality = options.quality;
    if (options.baseURL !== undefined)
      request.base_url = options.baseURL;
    if (options.userAgent !== undefined)
      request.ua = options.userAgent;
    if (options.mimeType !== undefined)
      request.mime_type = options.mimeType;

    const start = performance.now();
    try {
      const response = await this.dispatch(request);
      const data = await readFile(outputPath);
      return {
        data,
        bytes: response.bytes ?? data.length,
        durationMs: response.duration_ms ?? 0,
        elapsedMs: performance.now() - start,
        outputPath: requestedOutput,
      };
    } finally {
      if (!requestedOutput)
        await unlink(outputPath).catch(() => { });
    }
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
      await this.exitPromise;
      return;
    }
    this.closing = true;
    try {
      await this.dispatch({ op: 'shutdown' });
      await this.exitPromise;
    } finally {
      this.closed = true;
      await rm(this.temporaryDirectory, { recursive: true, force: true });
    }
  }
}

export function launch(options: ShotKitLaunchOptions = {}): Promise<ShotKit> {
  return ShotKit.launch(options);
}
