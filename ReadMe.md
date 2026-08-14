# ShotKit

> Turn HTML into images without a browser. A compact, script-free WebKit screenshot kernel.

[![npm](https://img.shields.io/npm/v/@shotkit/node?logo=npm)](https://www.npmjs.com/package/@shotkit/node)
[![node](https://img.shields.io/node/v/@shotkit/node)](https://www.npmjs.com/package/@shotkit/node)
[![Windows](https://github.com/sj817/shotkit/actions/workflows/windows.yml/badge.svg)](https://github.com/sj817/shotkit/actions/workflows/windows.yml)
[![Linux](https://github.com/sj817/shotkit/actions/workflows/linux.yml/badge.svg)](https://github.com/sj817/shotkit/actions/workflows/linux.yml)
[![macOS](https://github.com/sj817/shotkit/actions/workflows/macos.yml/badge.svg)](https://github.com/sj817/shotkit/actions/workflows/macos.yml)

**English** · [简体中文](README.zh-CN.md)

ShotKit renders **HTML to PNG or WebP** — from an HTML string, a local file, or a remote URL. It is
WebCore, WebKit's layout and painting engine, cut down to a single-process rendering kernel. It is
**not a browser**: no window, no multi-process shell, no automation protocol, and page JavaScript is
never executed.

That makes it a good fit for **server-side screenshots**: OG/social card generation, PDF-adjacent
report rendering, email and template previews, thumbnails, chart and invoice rendering, and visual
regression of static pages. It is a lighter option than driving headless Chrome through Puppeteer or
Playwright when the pages you render do not need a JavaScript runtime.

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
| Distribution | 8–12 MB compressed | Hundreds of MB |
| Cold start to first image | 37 ms (Linux) / 87 ms (Windows) | Typically hundreds of ms |

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

Measured with [`demo/browser-benchmark`](demo/browser-benchmark/) and the SDK benchmark, on one
32-thread desktop. Numbers are p50 per image with a resident engine; treat them as a shape, not a
promise for your hardware.

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
- **Concurrency on one instance buys nothing.** The engine serializes requests on its render
  thread, so `Promise.all` only saves IPC round-trips (measured 1.02–1.06×). **To scale, run a pool
  of ShotKit processes**, roughly one per core — not more concurrent calls into one.

## Node.js SDK

[`@shotkit/node`](https://www.npmjs.com/package/@shotkit/node) wraps the JSONL server mode. ESM and
CommonJS, zero runtime dependencies, Node.js 18.18+.

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
`scale`, `fullPage`, `timeoutMs`, `baseURL`, `userAgent`, `mimeType`, `allowFileURLs`.
Result: `{ data: Buffer, bytes, durationMs, elapsedMs, outputPath? }`.

Full SDK docs: [`bindings/node/README.md`](Source/WebKitShot/bindings/node/README.md).

## CLI

Download a release archive, extract it completely, and run `shotcli`. ShotKit never unpacks itself
at runtime and never writes a kernel cache.

```bash
./bin/shotcli --url https://example.com/ --out example.png --full-page
./bin/shotcli --html ./page.html --out page.png --width 1280 --height 800
./bin/shotcli --html ./page.html --out page.webp --format webp --quality 82
cat page.html | ./bin/shotcli --stdin --out stdin.png
```

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
details and a Python example: [language-bindings.md](Source/WebKitShot/docs/language-bindings.md).

## C ABI

[`Source/WebKitShot/capi/shot.h`](Source/WebKitShot/capi/shot.h) is the public header. `shot.dll`,
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

Design notes, pruning rationale, and the size ledger live in [`AGENTS.md`](AGENTS.md).

## Building from source

WebKit is a large build; expect the better part of an hour on a normal machine. Prebuilt archives
are attached to each [release](https://github.com/sj817/shotkit/releases) if you only want to use it.

```powershell
# Windows: VS C++ Build Tools, LLVM/clang-cl, CMake, Ninja, Ruby, Perl, gperf, Bison/Flex, vcpkg
pwsh Source/WebKitShot/build-shot.ps1 -Configure -Build
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
[getting-started.md](Source/WebKitShot/docs/getting-started.md).

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
| [`Source/WebKitShot/`](Source/WebKitShot/) | Kernel, C ABI, CLI, SDK, tests, release tooling |
| [`Source/WebKitShot/bindings/node/`](Source/WebKitShot/bindings/node/) | `@shotkit/node` SDK |
| [`Source/cmake/OptionsShot.cmake`](Source/cmake/OptionsShot.cmake) | Shot port features and dependency matrix |
| [`Source/WebCore/ShotPruning.cmake`](Source/WebCore/ShotPruning.cmake) | WebCore IDL/binding pruning |
| [`demo/browser-benchmark/`](demo/browser-benchmark/) | Cross-engine benchmark tooling and results |
| [`AGENTS.md`](AGENTS.md) | Architecture decisions, risks, size ledger, roadmap |

The repository keeps two lines: `main` is a squashed release snapshot carrying only the ShotKit
build closure, and `shotkit` retains full WebKit history for upstream comparison. Day-to-day work,
issues, and pull requests target `main`.

## Contributing

Issues and pull requests are welcome. For pruning changes, please include the effect on static
screenshot capability, the measured size change of the shared library and the release archive, and
which PNG/WebP, network, XML/XSLT, or multilingual regressions you ran.

This is a snapshot fork of WebKit and does not aim to continuously rebase on upstream. Working
conventions are in [`AGENTS.md`](AGENTS.md).

## License

This repository is derived from WebKit. Existing sources remain under the upstream licenses and
copyright notices carried in each file and directory, and those notices must be preserved on
redistribution.

> **A top-level license and NOTICE inventory for ShotKit's own code and its bundled third-party
> binaries is not finished yet.** Until it is, please do not describe this repository as a
> license-audited formal distribution.

ShotKit is an independent WebKit fork. It is not a browser, and it does not represent the upstream
WebKit project.
