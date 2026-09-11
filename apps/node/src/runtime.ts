// The engine's lifecycle, one per process, shaped like shotium's Runtime.
//
// `start()` is synchronous the way shotium's is: it loads the addon (and
// throws if the platform package is missing) and begins the kernel's
// initialisation, which the first `screenshot()` awaits. `stop()` waits
// for the captures in flight and marks the runtime stopped; the kernel's
// thread itself lives until the process exits, because the addon owns it,
// so a later `screenshot()` resumes without paying initialisation again.
// The addon serialises renders on its own thread, so captures are simply
// queued; nothing here needs a promise chain.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { ShotKitError } from './error.js';
import { loadNativeBinding, type NativeBinding, type NativeRenderResult, resolveNativeAddon } from './native.js';
import { prepare, validate, validateStart } from './request.js';
import type { ScreenshotOptions, ScreenshotResult, StartOptions, StartResult } from './types.js';

function nativeError(error: unknown): ShotKitError {
  if (error instanceof ShotKitError) return error;
  if (error instanceof Error) {
    const candidate = error as Error & { status?: unknown };
    return new ShotKitError(error.message, typeof candidate.status === 'number' ? candidate.status : undefined);
  }
  return new ShotKitError(String(error));
}

export class Runtime {
  #binding: NativeBinding | undefined;
  #enginePath: string | null = null;
  #ready: Promise<void> | undefined;
  #running = false;
  #userAgent = '';
  readonly #inFlight = new Set<Promise<unknown>>();

  get running(): boolean {
    return this.#running;
  }

  start(options?: StartOptions): StartResult {
    const settings = validateStart(options);
    if (this.#running) {
      // Adopt a repeat start, refuse a different one: two callers that
      // disagree on the user agent would each see the other's captures.
      if (settings.userAgent !== this.#userAgent) {
        throw new Error(`the engine is already running with userAgent ${JSON.stringify(this.#userAgent)}; stop() it before starting with ${JSON.stringify(settings.userAgent)}`);
      }
      return this.status();
    }
    if (!this.#binding) {
      this.#enginePath = resolveNativeAddon();
      this.#binding = loadNativeBinding();
    }
    const binding = this.#binding;
    // The kernel initialises once per process; a second start after stop()
    // finds it initialised and the promise already settled.
    this.#ready ??= binding.initialize().catch((error) => {
      this.#ready = undefined;
      throw nativeError(error);
    });
    this.#userAgent = settings.userAgent;
    this.#running = true;
    return this.status();
  }

  status(): StartResult {
    return { running: this.#running, enginePath: this.#enginePath, cacheDir: null, cacheActive: false };
  }

  async stop(): Promise<void> {
    if (!this.#running) return;
    this.#running = false;
    await Promise.allSettled([...this.#inFlight]);
  }

  async screenshot(options: ScreenshotOptions): Promise<ScreenshotResult> {
    const started = performance.now();
    const validated = validate(options);
    if (!this.#running) this.start({ userAgent: this.#userAgent });
    const operation = (async (): Promise<ScreenshotResult> => {
      await this.#ready;
      const request = await prepare(validated, this.#userAgent);
      let rendered: NativeRenderResult;
      try {
        rendered = await this.#binding!.render(request);
      } catch (error) {
        throw nativeError(error);
      }
      let image: Buffer | null = rendered.data;
      if (validated.path !== undefined) {
        const target = path.resolve(validated.path);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, rendered.data);
        image = null;
      }
      return {
        image,
        stats: { bytes: rendered.bytes, timing: { render: rendered.durationMs, total: performance.now() - started } },
      };
    })();
    this.#inFlight.add(operation);
    try {
      return await operation;
    } finally {
      this.#inFlight.delete(operation);
    }
  }
}

export const runtime = new Runtime();
