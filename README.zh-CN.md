# ShotKit

> 不用浏览器，把 HTML 变成图片。一个精简的、不执行脚本的 WebKit 截图内核。

[![npm](https://img.shields.io/npm/v/@shotkit/node?logo=npm)](https://www.npmjs.com/package/@shotkit/node)
[![node](https://img.shields.io/node/v/@shotkit/node)](https://www.npmjs.com/package/@shotkit/node)
[![Windows](https://github.com/sj817/shotkit/actions/workflows/windows.yml/badge.svg)](https://github.com/sj817/shotkit/actions/workflows/windows.yml)
[![Linux](https://github.com/sj817/shotkit/actions/workflows/linux.yml/badge.svg)](https://github.com/sj817/shotkit/actions/workflows/linux.yml)
[![macOS](https://github.com/sj817/shotkit/actions/workflows/macos.yml/badge.svg)](https://github.com/sj817/shotkit/actions/workflows/macos.yml)

[English](ReadMe.md) · **简体中文**

ShotKit 把 **HTML 渲染成 PNG 或 WebP** —— 输入可以是 HTML 字符串、本地文件或远程 URL。它是从
WebKit 的排版绘制引擎 WebCore 裁切出来的单进程渲染内核，**不是浏览器**：没有窗口，没有多进程外壳，
没有自动化协议，页面 JavaScript 永不执行。

适合的场景是服务端出图：OG / 社交卡片生成、报表渲染、邮件与模板预览、缩略图、图表与发票出图，
以及静态页面的视觉回归。当你要渲染的页面本来就不需要 JavaScript 运行时，它比用 Puppeteer 或
Playwright 驱动无头 Chrome 要轻得多。

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

npm 通过带 `os`/`cpu` 限制的可选依赖，只会为当前平台装下唯一匹配的那个预编译运行时——
**不需要 node-gyp，不需要编译器，也没有安装后下载**。

---

## 为什么是 ShotKit

|  | ShotKit | 无头 Chrome / Playwright |
|---|---|---|
| 目标 | HTML/CSS → 像素 | 完整网页运行环境 |
| 页面 JavaScript / WebAssembly | 永不执行 | 默认启用 |
| 进程模型 | 单进程、单渲染线程 | 多进程 |
| 图形路径 | Skia CPU 软光栅（macOS 用 CoreGraphics） | GPU 加合成进程 |
| 嵌入方式 | Node.js SDK、CLI、JSONL、C ABI | 自动化协议（CDP） |
| 分发体积 | 8–12 MB 压缩包 | 数百 MB |
| 冷启动到第一张图 | 37 ms（Linux）/ 87 ms（Windows） | 通常数百 ms |

取舍很明确：放弃交互式和客户端渲染的页面，换来小得多的分发体积、更低的常驻开销，
以及更可预测的静态渲染结果。

**该用 ShotKit**：你的 HTML 是服务端渲染的，或者本身就是自包含的。
**该用真浏览器**：页面必须先跑脚本才能产出你要截的内容。

## 能力

- 输入：HTML 字符串、HTML/XML/XHTML 文件、`stdin`，或 HTTP(S) URL
- 输出：PNG、有损 WebP、无损 WebP —— 写文件或直接拿 `Buffer`
- 加载外链 CSS、图片、WebP、Web 字体和同源 XSLT
- 渲染现代 CSS、SVG、MathML、CJK、RTL 文本和 emoji
- 视口截图、设备像素比（HiDPI）、整页截图
- 重定向、TLS、HTTP/2、内存 Cookie、加载超时、自定义 UA
- 四种调用方式：[Node.js SDK](#nodejs-sdk)、[CLI](#cli)、[JSONL 常驻协议](#jsonl-常驻协议)、[C ABI](#c-abi)

**设计上就不做的**：页面 JavaScript、WebAssembly、Service Worker、音视频、WebGL、WebGPU、
WebRTC、窗口、用户输入、DevTools、浏览器扩展。依赖客户端渲染才能出内容的页面会截到空白。
iframe 目前尚未支持。

## 平台支持

每个 release 发布六个预编译运行时，全部经过 CI 的截图冒烟测试和 C ABI 导出面校验。

| 平台 | 架构 | npm 子包 | 发布归档 |
|---|---|---|---:|
| Windows | x64、arm64 | `@shotkit/win32-x64`、`@shotkit/win32-arm64` | 11.5 / 10.6 MB |
| Linux | x64、arm64 | `@shotkit/linux-x64`、`@shotkit/linux-arm64` | 9.1 / 8.2 MB |
| macOS | x64、arm64 | `@shotkit/darwin-x64`、`@shotkit/darwin-arm64` | 9.6 / 8.1 MB |

体积为压缩后的 `tar.xz` 归档，MinSizeRel + full LTO 构建。

## 性能

在一台 32 线程桌面机上实测，单张 p50，引擎常驻。这些数字用来说明量级，不构成对你的硬件的承诺。

| | Linux（WSL2） | Windows 11 |
|---|---:|---:|
| 冷启动（进程 + 首张） | 37 ms | 87 ms |
| 400×200 PNG | 14 ms | 16 ms |
| 900×620 PNG | 34 ms | 35 ms |
| 900×620 WebP q80 | 39 ms | 54 ms |
| 1920×1080 PNG | 78 ms | 63 ms |
| 900×620 @2×（HiDPI） | 96 ms | 83 ms |
| 单实例吞吐 | 29 张/秒 | 30 张/秒 |

做容量规划前有两件事值得知道：

- **预热在第二张就结束了。** 第一张渲染背着一次性初始化开销（Linux 约 10 ms、Windows 约 21 ms），
  之后曲线就是平的。所以让进程常驻。
- **对单个实例加并发没有收益。** 引擎在它自己的渲染线程上串行化请求，`Promise.all` 省下的只是
  IPC 往返（实测 1.02–1.06×）。**要扩吞吐就起一个 ShotKit 进程池**，大致按核数来，
  而不是往一个实例里堆并发。

## Node.js SDK

[`@shotkit/node`](https://www.npmjs.com/package/@shotkit/node) 封装了 JSONL 常驻协议。
ESM 与 CommonJS 都支持，零运行时依赖，要求 Node.js 18.18 及以上。

```js
import { launch } from '@shotkit/node';

const shot = await launch();
try {
  // 抓 URL
  await shot.screenshotURL('https://example.com/', { outputPath: 'url.png' });

  // HTML 字符串，直接拿 Buffer 不落盘
  const { data, bytes, durationMs } = await shot.screenshotHTML(
    '<h1>Hello</h1>',
    { width: 800, height: 400, format: 'webp', quality: 82 },
  );

  // 本地文件，2 倍像素整页截图
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

选项：`outputPath`、`format`（`png` | `webp` | `webp-lossless`）、`quality`、`width`、`height`、
`scale`、`fullPage`、`timeoutMs`、`baseURL`、`userAgent`、`mimeType`、`allowFileURLs`。
返回：`{ data: Buffer, bytes, durationMs, elapsedMs, outputPath? }`。

完整 SDK 文档见 [`bindings/node/README.md`](Source/WebKitShot/bindings/node/README.md)。

## CLI

最快的方式是走 npm，它把同一份预编译运行时包装成 `sk` 命令：

```bash
# 什么都不装,跑一次
npx @shotkit/node --url https://example.com/ --out example.png --full-page

# 或者装成全局命令
npm install -g @shotkit/node
sk --html ./page.html --out page.png --width 1280 --height 800
```

全局安装会同时提供 `sk` 和更长的 `shotkit`，两者完全等价。

也可以完全不碰 Node.js：下载 [release 归档](https://github.com/sj817/shotkit/releases)，
**完整解压**后直接运行 `shotcli`。ShotKit 不会在运行时解压自身，也不写内核缓存。

```bash
./bin/shotcli --url https://example.com/ --out example.png --full-page
./bin/shotcli --html ./page.html --out page.webp --format webp --quality 82
cat page.html | ./bin/shotcli --stdin --out stdin.png
```

`sk` 是对 `shotcli` 的直接透传，所以两者参数完全一致，而且**工作目录会被保留**——
相对路径就按你敲的那样解析。

```text
shotcli (--html <file> | --stdin | --url <url>) --out <image>
        [--width W] [--height H] [--scale S] [--full-page]
        [--format png|webp|webp-lossless] [--quality 0..100]
        [--mime-type TYPE] [--timeout MS] [--base-url URL]
        [--ua STRING] [--allow-file-urls]
```

`file://` 默认禁用。只有在信任页面及其本地资源时才传 `--allow-file-urls`。

## JSONL 常驻协议

高频调用不必为每张图重启进程。`shotcli --serve` 保持内核常驻，从 stdin 逐行读 JSON 请求，
把结果逐行写到 stdout。

```text
> shotcli --serve
< {"ready":true,"protocol":1}
> {"id":1,"url":"https://example.com/","out":"example.png","full_page":true}
< {"id":1,"ok":true,"status":0,"bytes":12345,"duration_ms":92.5}
> {"id":2,"op":"shutdown"}
```

请求在单个渲染线程上顺序执行，需要并行就起多个进程。协议细节与 Python 示例见
[跨语言调用文档](Source/WebKitShot/docs/language-bindings.md)。

## C ABI

公开头文件是 [`Source/WebKitShot/capi/shot.h`](Source/WebKitShot/capi/shot.h)。`shot.dll`、
`libshot.so`、`libshot.dylib` 各自只导出 10 个 `shot_*` 符号，小到可以直接用 Python ctypes/cffi、
Go cgo、Rust FFI 或 C# 绑定。

```c
shot_init();                        /* 绑定当前线程 */
shot_renderer_create(&renderer);
shot_render_options_default(&options);
shot_render_html(renderer, html, &options, &image);
shot_image_free(&image);
shot_renderer_destroy(renderer);
shot_shutdown();
```

所有 C ABI 调用都必须发生在调用 `shot_init()` 的那个线程上。renderer 非线程安全：
进程内串行使用，靠多进程扩展并行度。

## 内核结构

```text
HTML / XML / URL
       │
       ├── Windows/Linux: curl + OpenSSL
       └── macOS: CFNetwork
       ▼
WebCore 排版与绘制
       │
       ├── Windows/Linux: Skia CPU
       └── macOS: CoreGraphics / CoreText
       ▼
PNG / WebP
```

- WebCore 直接嵌在单进程里，WebKit 的 UI/Web/Network 多进程层根本不构建；
- JavaScriptCore 只作为 DOM、GC 和正则的基础设施保留，且只构建 C-loop LLInt，JIT 与 WebAssembly 全关；
- 页面脚本在设置、解析预加载、最终网络调度多层被拒绝，既不执行也不下载；
- bmalloc、WTF、JavaScriptCore、PAL、WebCore 以 OBJECT 库汇入同一个共享库，对外只暴露 C ABI。

设计取舍、裁剪依据和体积账本见 [`AGENTS.md`](AGENTS.md)。

## 从源码构建

WebKit 规模不小，普通机器上大概要花掉近一个小时。只想用的话，每个
[release](https://github.com/sj817/shotkit/releases) 都附了预编译归档。

```powershell
# Windows：VS C++ Build Tools、LLVM/clang-cl、CMake、Ninja、Ruby、Perl、gperf、Bison/Flex、vcpkg
pwsh Source/WebKitShot/build-shot.ps1 -Configure -Build
```

```bash
# Linux：Ubuntu 24.04、clang-18、lld-18 与系统开发包
cmake -S . -B WebKitBuild/shot-linux -G Ninja \
  -DPORT=Shot -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DCMAKE_C_COMPILER=clang-18 -DCMAKE_CXX_COMPILER=clang++-18 \
  -DLTO_MODE=full
ninja -C WebKitBuild/shot-linux shotcli
```

```bash
# macOS：Xcode、CMake、Ninja、ICU、WebP
brew install bison cmake gperf icu4c ninja webp
export CMAKE_PREFIX_PATH="$(brew --prefix icu4c);$(brew --prefix webp)"
cmake -S . -B WebKitBuild/shot-macos -G Ninja \
  -DPORT=Shot -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DCMAKE_PREFIX_PATH="$CMAKE_PREFIX_PATH" -DLTO_MODE=OFF
ninja -C WebKitBuild/shot-macos shotcli
```

归档布局、平台依赖等更多细节见[入门指南](Source/WebKitShot/docs/getting-started.md)。

## 已知限制与安全边界

- **只适用静态页面**：CSR/SPA 若服务器不返回可渲染内容，截图会是空白；
- **iframe 尚未支持**：主文档里的 iframe 目前不会完成独立导航；
- **不是安全沙箱**：ShotKit 是单进程的解析渲染内核，没有浏览器级的进程隔离。渲染不可信的远程内容时，
  调用方应把它放进受限账户、容器或独立进程，并设置资源与时间限制；
- **单线程 API**：同一实例不能被多线程并发调用，并行请用多进程；
- **平台像素差异**：Windows/Linux 走 Skia，macOS 走 CoreGraphics/CoreText，字体回退、抗锯齿和
  色彩管理都不同，所以视觉回归基线必须按平台分开存；
- `extra_font_dir` 与 `background_rgba` 已在 ABI 中保留，但尚未接线。

## 路线图

- [x] Windows、Linux、macOS —— x64 与 arm64 六个目标全部构建并发布
- [x] HTML/URL → PNG/WebP、网络子资源、XML/XSLT、C ABI、CLI、Node.js SDK
- [x] 体积 DCE、ICU 数据裁剪、无脚本网络闭包、重复渲染压力测试
- [x] 公开 CI、可复现产物、基于 OIDC 的免 token npm 发布
- [ ] iframe 支持
- [ ] Python、Go、Rust 的正式绑定

## 项目目录

| 路径 | 内容 |
|---|---|
| [`Source/WebKitShot/`](Source/WebKitShot/) | 内核、C ABI、CLI、SDK、测试与发布工具 |
| [`Source/WebKitShot/bindings/node/`](Source/WebKitShot/bindings/node/) | `@shotkit/node` SDK |
| [`Source/cmake/OptionsShot.cmake`](Source/cmake/OptionsShot.cmake) | Shot 端口特性与依赖矩阵 |
| [`Source/WebCore/ShotPruning.cmake`](Source/WebCore/ShotPruning.cmake) | WebCore IDL/绑定裁剪入口 |
| [`demo/browser-benchmark/`](demo/browser-benchmark/) | 跨引擎基准工具与结果 |
| [`AGENTS.md`](AGENTS.md) | 架构决策、风险、体积账本与路线图 |

仓库维持两条线：`main` 是无上游历史的精简发布快照，只保留 ShotKit 的构建闭包；`shotkit` 保留完整
WebKit 历史，供上游对照。日常开发、Issue 与 PR 都以 `main` 为准。

## 贡献

欢迎提 Issue 和 PR。提交裁剪类改动时，请一并说明：对静态截图能力的影响、共享库与发布归档的实测
体积变化，以及你跑过的 PNG/WebP、网络、XML/XSLT 或多语言回归。

本仓库是 WebKit 的 snapshot fork，不以持续 rebase 上游为目标。工作约定见 [`AGENTS.md`](AGENTS.md)。

## 许可证

本仓库基于 WebKit，原有源码继续适用各文件和目录中的上游许可证与版权声明，分发时必须保留相应 notices。

> **ShotKit 自有代码及其捆绑的第三方二进制依赖的顶层许可证 / NOTICE 清单尚未完成。**
> 在补齐之前，请勿把本仓库描述为已完成许可证审查的正式发行版。

ShotKit 是独立的 WebKit fork，不是浏览器，也不代表 WebKit 上游项目。
