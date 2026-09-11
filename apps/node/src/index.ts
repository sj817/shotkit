// @pixel.js/shotkit: HTML or a URL to PNG/WebP through the in-process
// WebKit kernel. The surface mirrors @pixel.js/shotium's -- screenshot,
// start, status, stop, a shared runtime and a default export -- so code
// written against one engine runs against the other; see README.md for
// the exact differences (what the kernel adds, what it refuses).

import { Runtime, runtime } from './runtime.js';
import type { ScreenshotOptions, ScreenshotResult, StartOptions, StartResult } from './types.js';

export { ShotKitError } from './error.js';
export { Runtime, runtime } from './runtime.js';
export type {
  CaptureStats, CaptureTiming, ImageType, PageGotoParams, ScreenshotOptions, ScreenshotResult, StartOptions, StartResult, Viewport,
} from './types.js';

/** Render one capture; starts the engine on first use. */
export function screenshot(options: ScreenshotOptions): Promise<ScreenshotResult> {
  return runtime.screenshot(options);
}

/** Start the engine now (synchronously loads the addon) instead of on the first capture. */
export function start(options?: StartOptions): StartResult {
  return runtime.start(options);
}

export function status(): StartResult {
  return runtime.status();
}

/** Wait for the captures in flight and mark the engine stopped; the next capture starts it again. */
export function stop(): Promise<void> {
  return runtime.stop();
}

export default {
  Runtime,
  runtime,
  screenshot,
  start,
  status,
  stop,
  get running(): boolean {
    return runtime.running;
  },
};
