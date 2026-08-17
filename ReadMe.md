# ShotKit

> Turn HTML into images without a browser. A compact, script-free WebKit screenshot kernel.

[![npm](https://img.shields.io/npm/v/@shotkit/node?logo=npm)](https://www.npmjs.com/package/@shotkit/node)
[![node](https://img.shields.io/node/v/@shotkit/node)](https://www.npmjs.com/package/@shotkit/node)
[![Windows](https://github.com/sj817/shotkit/actions/workflows/windows.yml/badge.svg)](https://github.com/sj817/shotkit/actions/workflows/windows.yml)
[![Linux](https://github.com/sj817/shotkit/actions/workflows/linux.yml/badge.svg)](https://github.com/sj817/shotkit/actions/workflows/linux.yml)
[![macOS](https://github.com/sj817/shotkit/actions/workflows/macos.yml/badge.svg)](https://github.com/sj817/shotkit/actions/workflows/macos.yml)

**English** · [简体中文](README.zh-CN.md)

ShotKit renders **HTML to PNG or WebP** — from an HTML string, a local file, or a remote URL — and
it is built to be small, fast, and trivial to install.

|  | ShotKit | Playwright Chromium | Puppeteer Chrome |
|---|--:|--:|--:|
| **Screenshot, warm process** | **91 ms** | 213 ms | 284 ms |
| **Cold start → first image** | **186 ms** | 431 ms | 1,200 ms |
| **Resident memory (RSS)** | **45 MB** | 164 MB | 428 MB |
| **Engine on disk** | **64 MB** | 415 MB | 419 MB |
| **Download** | **8–12 MB** | 100s of MB | 100s of MB |
| **Install** | `npm install` | + browser download | + browser download |

<sub>1280×800 full-page PNG, same machine (i9-14900KF, Windows), Puppeteer 25.3 / Playwright 1.61,
fastest of 3 trials. Method and raw data: [`apps/benchmark`](apps/benchmark/).</sub>

So: **3× faster warm, 6× faster cold, and roughly a tenth of the memory** of headless Chrome — because
ShotKit is not a browser. It is WebCore, WebKit's layout and painting engine, cut down to a
single-process rendering kernel: no window, no multi-process shell, no automation protocol, and page
JavaScript is never executed.

That makes it a good fit for **server-side screenshots**: OG/social card generation, report
rendering, email and template previews, thumbnails, chart and invoice rendering, and visual
regression of static pages. It is a much lighter option than driving headless Chrome through
Puppeteer or Playwright when the pages you render do not need a JavaScript runtime.

**Three lines to your first image:**

```bash
npm install @shotkit/node
```

```js
import { launch } from '@shotkit/node';

const shot = await launch();
await shot.screenshotURL('https://example.com/', {
  outputPath: 'example.png',
  width: 1280,
  height: 800,
  fullPage: true,
});
await shot.close();
```

npm resolves exactly one prebuilt runtime for your platform through `os`/`cpu`-constrained optional
dependencies, so there is **no node-gyp, no compiler, and no post-install download**.

---

## Why ShotKit

|  | ShotKit | Headless Chrome / Playwright |
|---|---|---|
| Goal | HTML & CSS → pixels | Full web runtime |
| Page JavaScript / WebAssembly | Never executed | Enabled by default |
| Process model | Single process, single render thread | Multi-process |
| Graphics | Skia CPU raster (CoreGraphics on macOS) | GPU + compositor processes |
| Embedding | Node.js SDK, CLI, JSONL, C ABI | Automation protocol (CDP) |

The trade is explicit: ShotKit gives up interactive and client-rendered pages in exchange for a much
smaller distribution, a lower resident footprint, and more predictable static rendering.

**Use ShotKit when** your HTML is server-rendered or self-contained.
**Use a real browser when** the page needs to run scripts to produce what you want to capture.

## Features

- Input: HTML string, HTML/XML/XHTML file, `stdin`, or HTTP(S) URL
- Output: PNG, lossy WebP, lossless WebP — to a file or straight to a `Buffer`
- Loads external CSS, images, WebP, web fonts, and same-origin XSLT
- Renders modern CSS, SVG, MathML, CJK, RTL text, and emoji
- Viewport capture, device scale factor (HiDPI), and full-page capture
- Redirects, TLS, HTTP/2, in-memory cookies, load timeouts, custom user agent
- Four ways in: [Node.js SDK](#nodejs-sdk), [CLI](#cli), [JSONL server mode](#jsonl-server-mode),
  [C ABI](#c-abi)

**Out of scope by design:** page JavaScript, WebAssembly, Service Workers, audio/video, WebGL,
WebGPU, WebRTC, windows, user input, DevTools, and browser extensions. Pages that need client-side
rendering to produce content will capture empty. iframes are not supported yet.

## Platform support

Every release ships six prebuilt runtimes, all verified in CI by screenshot smoke tests and a C ABI
export check.

| Platform | Architectures | npm package | Release archive |
|---|---|---|---:|
| Windows | x64, arm64 | `@shotkit/win32-x64`, `@shotkit/win32-arm64` | 11.5 / 10.6 MB |
| Linux | x64, arm64 | `@shotkit/linux-x64`, `@shotkit/linux-arm64` | 9.1 / 8.2 MB |
| macOS | x64, arm64 | `@shotkit/darwin-x64`, `@shotkit/darwin-arm64` | 9.6 / 8.1 MB |

Sizes are the compressed `tar.xz` release archives, built MinSizeRel with full LTO.

## Performance

The table at the top compares engines at 1280×800 full-page. The numbers below are the SDK's own
benchmark on one 32-thread desktop, at smaller viewports and p50 per image with a resident engine —
which is why they are lower. Treat both as a shape, not a promise for your hardware.

| | Linux (WSL2) | Windows 11 |
|---|---:|---:|
| Cold start (process + first image) | 37 ms | 87 ms |
| 400×200 PNG | 14 ms | 16 ms |
| 900×620 PNG | 34 ms | 35 ms |
| 900×620 WebP q80 | 39 ms | 54 ms |
| 1920×1080 PNG | 78 ms | 63 ms |
| 900×620 @2× (HiDPI) | 96 ms | 83 ms |
| Throughput, one instance | 29 img/s | 30 img/s |

Two things worth knowing before you plan capacity:

- **Warm-up finishes on the second image.** The first render carries one-time initialization
  (~10 ms on Linux, ~21 ms on Windows); after that the curve is flat. Keep the process resident.
- **Concurrency on one instance does not increase throughput.** The native SDK accepts concurrent
  Promises but serializes them through one FIFO render thread. **To scale, run a pool of ShotKit
  processes**, roughly one per core — not more concurrent calls into one.

## Node.js SDK

[`@shotkit/node`](https://www.npmjs.com/package/@shotkit/node) loads a prebuilt in-process
`shot.node`. It uses one native render thread, returns the encoded allocation as a Buffer, and does
not launch the CLI or create temporary image files. ESM and CommonJS, Node.js 18.18+.

```js
import { launch } from '@shotkit/node';

const shot = await launch();
try {
  // From a URL
  await shot.screenshotURL('https://example.com/', { outputPath: 'url.png' });

  // From an HTML string, straight to a Buffer
  const { data, bytes, durationMs } = await shot.screenshotHTML(
    '<h1>Hello</h1>',
    { width: 800, height: 400, format: 'webp', quality: 82 },
  );

  // From a local file, full page at 2× device scale
  await shot.screenshot({
    htmlFile: './report.html',
    outputPath: 'report.png',
    scale: 2,
    fullPage: true,
  });
} finally {
  await shot.close();
}
```

Options: `outputPath`, `format` (`png` | `webp` | `webp-lossless`), `quality`, `width`, `height`,
`scale`, `fullPage`, `selector`, `timeoutMs`, `baseURL`, `userAgent`, `mimeType`, `allowFileURLs`.
Result: `{ data: Buffer, bytes, durationMs, elapsedMs, outputPath? }`.

Full SDK docs: [`bindings/node/README.md`](apps/node/README.md).

## CLI

Download a [release archive](https://github.com/sj817/shotkit/releases),
extract it completely, and run `shotcli`. ShotKit never unpacks itself at runtime and never writes a
kernel cache.

```bash
./bin/shotcli --url https://example.com/ --out example.png --full-page
./bin/shotcli --html ./page.html --out page.webp --format webp --quality 82
cat page.html | ./bin/shotcli --stdin --out stdin.png
```

`sk` is a straight passthrough to `shotcli`, so both accept the same flags and your working
directory is preserved — relative paths resolve where you typed them.

```text
shotcli (--html <file> | --stdin | --url <url>) --out <image>
        [--width W] [--height H] [--scale S] [--full-page]
        [--format png|webp|webp-lossless] [--quality 0..100]
        [--mime-type TYPE] [--timeout MS] [--base-url URL]
        [--ua STRING] [--allow-file-urls]
```

`file://` is disabled by default. Only pass `--allow-file-urls` when you trust the page and its
local resources.

## JSONL server mode

For high call volumes, keep the kernel resident. `shotcli --serve` reads one JSON request per line
from stdin and writes one JSON result per line to stdout.

```text
> shotcli --serve
< {"ready":true,"protocol":1}
> {"id":1,"url":"https://example.com/","out":"example.png","full_page":true}
< {"id":1,"ok":true,"status":0,"bytes":12345,"duration_ms":92.5}
> {"id":2,"op":"shutdown"}
```

Requests run sequentially on one render thread; start multiple processes for parallelism. Protocol
details and a Python example: [language-bindings.md](docs/language-bindings.md).

## C ABI

[`shot/capi/shot.h`](shot/capi/shot.h) is the public header. `shot.dll`,
`libshot.so`, and `libshot.dylib` each export exactly 10 `shot_*` symbols — small enough to bind
from Python ctypes/cffi, Go cgo, Rust FFI, or C#.

```c
shot_init();                        /* binds the calling thread */
shot_renderer_create(&renderer);
shot_render_options_default(&options);
shot_render_html(renderer, html, &options, &image);
shot_image_free(&image);
shot_renderer_destroy(renderer);
shot_shutdown();
```

Every C ABI call must happen on the thread that called `shot_init()`. A renderer is not thread-safe:
use it serially within a process and scale out with more processes.

## Architecture

```text
HTML / XML / URL
       │
       ├── Windows/Linux: curl + OpenSSL
       └── macOS: CFNetwork
       ▼
WebCore layout and painting
       │
       ├── Windows/Linux: Skia CPU raster
       └── macOS: CoreGraphics / CoreText
       ▼
PNG / WebP
```

- WebCore is embedded directly in one process; WebKit's UI/Web/Network multi-process layers are not
  built at all.
- JavaScriptCore is kept only as infrastructure for the DOM, GC, and regular expressions. Only the
  C-loop LLInt is built; the JIT and WebAssembly are off.
- Page scripts are rejected at several layers — settings, parser preload, and final network
  scheduling — so they are neither executed nor downloaded.
- bmalloc, WTF, JavaScriptCore, PAL, and WebCore link into one shared library as OBJECT libraries,
  with only the C ABI visible.

Design notes and the pruning rationale are in [`docs/architecture.md`](docs/architecture.md);
the size ledger is in [`docs/size-ledger.md`](docs/size-ledger.md).

## Building from source

WebKit is a large build; expect the better part of an hour on a normal machine. Prebuilt archives
are attached to each [release](https://github.com/sj817/shotkit/releases) if you only want to use it.

```powershell
# Windows: VS C++ Build Tools, LLVM/clang-cl, CMake, Ninja, Ruby, Perl, gperf, Bison/Flex, vcpkg
pwsh scripts/build-shot.ps1 -Configure -Build
```

```bash
# Linux: Ubuntu 24.04, clang-18, lld-18, system dev packages
cmake -S . -B WebKitBuild/shot-linux -G Ninja \
  -DPORT=Shot -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DCMAKE_C_COMPILER=clang-18 -DCMAKE_CXX_COMPILER=clang++-18 \
  -DLTO_MODE=full
ninja -C WebKitBuild/shot-linux shotcli
```

```bash
# macOS: Xcode, CMake, Ninja, ICU, WebP
brew install bison cmake gperf icu4c ninja webp
export CMAKE_PREFIX_PATH="$(brew --prefix icu4c);$(brew --prefix webp)"
cmake -S . -B WebKitBuild/shot-macos -G Ninja \
  -DPORT=Shot -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DCMAKE_PREFIX_PATH="$CMAKE_PREFIX_PATH" -DLTO_MODE=OFF
ninja -C WebKitBuild/shot-macos shotcli
```

More detail, including archive layout and platform dependencies:
[getting-started.md](docs/getting-started.md).

## Limitations and security boundary

- **Static pages only.** CSR/SPA pages that need scripts to render will capture empty.
- **No iframe support yet.** iframes in the main document do not complete their own navigation.
- **Not a security sandbox.** ShotKit is a single-process parse-and-render kernel with no
  browser-grade process isolation. When rendering untrusted remote content, the caller should
  confine it — restricted account, container, or separate process — with resource and time limits.
- **Single-threaded API.** One instance cannot be called concurrently from multiple threads. Use
  multiple processes for parallelism.
- **Platform pixel differences.** Windows and Linux raster with Skia; macOS uses
  CoreGraphics/CoreText. Font fallback, antialiasing, and color management differ, so visual
  regression baselines must be stored per platform.
- `extra_font_dir` and `background_rgba` exist in the ABI but are not wired up yet.

## Roadmap

- [x] Windows, Linux, macOS — x64 and arm64, all six built and published
- [x] HTML/URL → PNG/WebP, network subresources, XML/XSLT, C ABI, CLI, Node.js SDK
- [x] Size DCE, ICU data slimming, script-free network closure, stress testing
- [x] Public CI, reproducible artifacts, and tokenless npm publishing via OIDC
- [ ] iframe support
- [ ] First-class Python, Go, and Rust bindings

## Repository layout

| Path | Contents |
|---|---|
| [`shot/`](shot/) | Rendering kernel, C ABI, and CLI — the product's C++ source |
| [`apps/node/`](apps/node/) | `@shotkit/node` SDK |
| [`apps/benchmark/`](apps/benchmark/) | Cross-engine benchmark tooling and results |
| [`scripts/`](scripts/) | Build, ICU slimming, distribution, and release tooling |
| [`tests/`](tests/) | Fixture server, no-script-network check, leak harness |
| [`docs/`](docs/) | Getting started, language bindings, design notes |
| [`Source/`](Source/) | Upstream WebKit, plus the `PlatformShot.cmake` port hooks |
| [`Source/cmake/OptionsShot.cmake`](Source/cmake/OptionsShot.cmake) | Shot port features and dependency matrix |
| [`Source/WebCore/ShotPruning.cmake`](Source/WebCore/ShotPruning.cmake) | WebCore IDL/binding pruning |
| [`upstream-sync/`](upstream-sync/) | Upstream sync procedure, baseline commit, deviation ledger |
| [`docs/`](docs/) | Architecture, build options, size ledger, changelog, conventions |
| [`AGENTS.md`](AGENTS.md) | Entry point: current status, locked decisions, doc index |

`main` is a squashed release snapshot carrying only the ShotKit build closure — it shares no
ancestry with upstream WebKit, so syncing is a path-scoped patch replay rather than a merge.
The procedure, the baseline commit, and the ledger of every upstream edit live in
[`upstream-sync/`](upstream-sync/).

## Contributing

Issues and pull requests are welcome. For pruning changes, please include the effect on static
screenshot capability, the measured size change of the shared library and the release archive, and
which PNG/WebP, network, XML/XSLT, or multilingual regressions you ran.

This is a snapshot fork of WebKit and does not aim to continuously rebase on upstream. Working
conventions are in [`docs/conventions.md`](docs/conventions.md).

## License

This repository is derived from WebKit. Existing sources remain under the upstream licenses and
copyright notices carried in each file and directory, and those notices must be preserved on
redistribution.

> **A top-level license and NOTICE inventory for ShotKit's own code and its bundled third-party
> binaries is not finished yet.** Until it is, please do not describe this repository as a
> license-audited formal distribution.

ShotKit is an independent WebKit fork. It is not a browser, and it does not represent the upstream
WebKit project.
