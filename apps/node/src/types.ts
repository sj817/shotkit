// The public types. The shape follows @pixel.js/shotium's so that code
// written against one engine runs against the other: the same option
// names, the same `{image, stats}` result, the same start/status/stop
// lifecycle. Where the WebKit kernel has no counterpart the option is
// refused with a TypeError rather than ignored; where it has more, the
// extras are marked below.

/** png and webp as in shotium; webp-lossless is a ShotKit extension. jpeg is not available. */
export type ImageType = 'png' | 'webp' | 'webp-lossless';

export interface Viewport {
  /** CSS pixels, default 1280. */
  width?: number;
  /** CSS pixels, default 720. */
  height?: number;
}

export interface PageGotoParams {
  /** Milliseconds from navigation to giving up, default 30000. */
  timeout?: number;
  /**
   * Accepted for compatibility. The kernel always waits for the network to
   * go quiet before painting, so `load` and `networkidle` behave the same.
   */
  waitUntil?: 'load' | 'networkidle';
}

export interface ScreenshotOptions {
  /**
   * What to render: an http(s) URL, a `file:` URL or a local path. Exactly
   * one of `file` and `html` is required. A local file is read by Node and
   * rendered with its own URL as the base, so relative subresources resolve
   * next to it (and need `allowFileAccess` to load).
   */
  file?: string;
  /** ShotKit extension: render this HTML string instead of a file. */
  html?: string;
  type?: ImageType;
  /** 1–100 for webp, default 90; refused for png, which is lossless. */
  quality?: number;
  /** Device scale factor, 0.01–8, default 1. */
  scale?: number;
  /** Extend the capture to the whole document height. */
  fullPage?: boolean;
  /** Capture only the first element matching this CSS selector. Exclusive with `fullPage`. */
  selector?: string;
  /** Keep transparent page pixels instead of compositing them over white. */
  omitBackground?: boolean;
  /** Write the image here; the result's `image` is then null. */
  path?: string;
  pageGotoParams?: PageGotoParams;
  viewport?: Viewport;
  /** Let the page load `file:` subresources. Default false. */
  allowFileAccess?: boolean;
  /** ShotKit extension: base URL for relative subresources of `html`. */
  baseURL?: string;
  /** ShotKit extension: MIME type of `html` or of a local `file`, e.g. application/xhtml+xml. Default by extension, else text/html. */
  mimeType?: string;
  /** ShotKit extension: per-capture user agent; `start({userAgent})` sets the default. */
  userAgent?: string;
}

/** The subset of shotium's timing the kernel measures. */
export interface CaptureTiming {
  /** Native render + encode, milliseconds. */
  render: number;
  /** Node-side total including queueing and file output, milliseconds. */
  total: number;
}

/** The subset of shotium's CaptureStats the kernel measures. */
export interface CaptureStats {
  /** Encoded image size. */
  bytes: number;
  timing: CaptureTiming;
}

export interface ScreenshotResult {
  /** The encoded image, or null when `path` was given. */
  image: Buffer | null;
  stats: CaptureStats;
}

export interface StartOptions {
  /** Default user agent for every capture; a capture's own `userAgent` overrides it. */
  userAgent?: string;
}

export interface StartResult {
  running: boolean;
  /** The loaded shot.node, once started. */
  enginePath: string | null;
  /** ShotKit keeps no HTTP disk cache; present for shape compatibility with shotium. */
  cacheDir: null;
  cacheActive: false;
}
