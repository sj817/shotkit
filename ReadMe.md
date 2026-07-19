# ShotKit

> A compact, script-free WebKit screenshot kernel.

ShotKit 是一个从 WebKit 裁切而来的纯静态截图内核：输入 HTML 字符串、本地文件或远程 URL，输出 PNG / WebP 字节。它不是浏览器，不创建窗口，不执行页面 JavaScript，也不包含多进程浏览器外壳。

项目面向服务端截图、报告生成、邮件与模板预览、静态页面测试，以及需要通过 C ABI 嵌入原生程序的场景。

当前状态：**Windows x64、Linux x64 与 macOS arm64 端口均已接入构建和运行回归。** 三个平台使用同一套 C ABI 与 CLI；图形和网络后端按平台选择，因此像素结果可能存在细微差异。

仓库使用两条代码线：`main` 是无上游历史的精简发布快照，只保留 ShotKit 的构建闭包；`shotkit` 保留完整 WebKit 历史，供上游对照和必要的同步工作使用。日常开发、Issue 与 Pull Request 均以 `main` 为准。

## 为什么是 ShotKit

| | ShotKit | 通用无头浏览器 |
|---|---|---|
| 目标 | HTML/CSS → 像素 | 完整网页运行环境 |
| 页面 JavaScript / WebAssembly | 永不执行 | 通常启用 |
| 进程模型 | 单进程、单渲染线程 | 通常为多进程 |
| 图形路径 | Skia CPU 软光栅 | 常包含 GPU 与合成进程 |
| 嵌入接口 | C ABI、CLI、JSONL、Node.js | 通常通过自动化协议 |
| 当前 Windows 发布包 | 17.3 MB 压缩包 | 取决于浏览器发行版 |

ShotKit 的取舍很明确：牺牲客户端应用和交互网页能力，换取更小的分发、更低的常驻开销，以及更可控的静态渲染结果。

## 能做什么

- 输入 HTML 字符串、HTML/XML/XHTML 文件或 HTTP(S) URL；
- 加载外链 CSS、图片、WebP、Web 字体和同源 XSLT；
- 渲染现代 CSS、SVG、MathML、CJK、RTL 文本和 emoji；
- 输出 PNG、WebP 有损或 WebP 无损图片；
- 支持视口截图、device scale 和 full-page 截图；
- 支持重定向、TLS、HTTP/2、内存 Cookie 与加载超时；
- 通过 `shot.dll` C ABI、`shotcli`、JSONL 常驻协议或 Node.js SDK 调用。

以下能力不在项目范围内：

- 页面 JavaScript、WebAssembly、Service Worker；
- 音视频、WebGL、WebGPU、WebRTC；
- 窗口、用户输入、DevTools 与浏览器扩展；
- 依赖客户端渲染的 SPA/CSR 页面。

iframe 目前也尚未支持，详见「已知限制」。

## 快速开始

GitHub Actions 会为通过回归的提交生成 Windows x64、Linux x64 和 macOS arm64 归档。CI artifact 只保留 7 天，用于验证当前提交，不属于稳定版本发布。取得归档后应先完整解压；ShotKit 不会在运行时解压自身，也不会写入内核缓存。

```powershell
tar.exe -xf shotkit-0.1.0-windows-x64.tar.xz
cd shotkit-0.1.0-windows-x64

# 远程页面
.\shotcli.exe --url https://example.com/ --out example.png --full-page

# 本地 HTML
.\shotcli.exe --html .\page.html --out page.png --width 1280 --height 800

# WebP 有损 / 无损
.\shotcli.exe --html .\page.html --out page.webp --format webp --quality 82
.\shotcli.exe --html .\page.html --out page.webp --format webp-lossless

# stdin
Get-Content .\page.html -Raw | .\shotcli.exe --stdin --out stdin.png
```

Linux 和 macOS 归档使用相同参数，CLI 位于 `bin/`：

```bash
./bin/shotcli --url https://example.com/ --out example.png --full-page
./bin/shotcli --html ./page.html --out page.webp --format webp --quality 82
```

归档布局、平台依赖和源码构建命令见 [入门指南](Source/WebKitShot/docs/getting-started.md)。

完整 CLI 形式：

```text
shotcli (--html <file> | --stdin | --url <url>) --out <image>
        [--width W] [--height H] [--scale S] [--full-page]
        [--format png|webp|webp-lossless] [--quality 0..100]
        [--mime-type TYPE] [--timeout MS] [--base-url URL]
        [--ua STRING] [--allow-file-urls]
```

`file://` 默认禁用；只有在信任输入页面及其本地资源时才应使用 `--allow-file-urls`。

## 常驻 JSONL 协议

高频调用不必为每张图重新启动进程。`shotcli --serve` 会保持内核常驻，从 stdin 逐行读取 JSON，并把结果逐行写到 stdout。

```text
> shotcli --serve
< {"ready":true,"protocol":1}
> {"id":1,"url":"https://example.com/","out":"example.png","full_page":true}
< {"id":1,"ok":true,"status":0,"bytes":12345,"duration_ms":92.5}
> {"id":2,"op":"shutdown"}
```

请求在单个渲染线程上顺序执行。需要并行时，请启动多个 ShotKit 进程。协议细节和 Python 示例见 [跨语言调用文档](Source/WebKitShot/docs/language-bindings.md)。

## Node.js

[`@shotkit/node`](Source/WebKitShot/bindings/node/) 封装了 JSONL 常驻协议，支持 ESM、CommonJS、Promise 和 `Buffer`，生产依赖为 0。当前源码包要求 Node.js 18.18 或更高版本。

```js
import { launch } from '@shotkit/node';

const shot = await launch();

try {
  const result = await shot.screenshotURL('https://example.com/', {
    width: 1280,
    height: 800,
    fullPage: true,
    outputPath: 'example.png',
  });

  console.log(result.bytes, result.durationMs);
} finally {
  await shot.close();
}
```

SDK 尚未发布到公共 npm registry。可以从源码测试并构建携带 Windows runtime 的本地包：

```powershell
cd Source\WebKitShot\bindings\node
npm install
npm test
npm run pack:win
```

更多用法见 [Node.js SDK 文档](Source/WebKitShot/bindings/node/README.md)。

## C ABI

公开头文件位于 [`Source/WebKitShot/capi/shot.h`](Source/WebKitShot/capi/shot.h)。`shot.dll`、`libshot.so` 和 `libshot.dylib` 均只导出 10 个 `shot_*` 符号，适合通过 Python ctypes/cffi、Go cgo、Rust FFI 等方式嵌入。

典型调用顺序：

1. `shot_init()` 绑定当前线程；
2. `shot_renderer_create()` 创建 renderer；
3. `shot_render_options_default()` 初始化选项；
4. 调用 `shot_render_html()` 或 `shot_render_url()`；
5. 用 `shot_image_free()` 释放输出字节；
6. 销毁 renderer，最后调用 `shot_shutdown()`。

所有 C ABI 调用都必须发生在调用 `shot_init()` 的同一线程。renderer 非线程安全；进程内请串行使用，并通过多进程扩展并行度。

## 内核结构

```text
HTML / XML / URL
       │
       ├── Windows/Linux: curl + OpenSSL
       └── macOS: CFNetwork
       │
       ▼
WebCore layout and painting
       │
       ├── Windows/Linux: Skia CPU
       └── macOS: CoreGraphics/CoreText
       │
       ▼
PNG / WebP
```

- ShotKit 直接在单进程中嵌入 WebCore，不构建 WebKit 的 UI/Web/Network 多进程层；
- JavaScriptCore 保留为 WebCore DOM、GC 与正则基础设施，但只构建 C-loop LLInt，JIT 与 WebAssembly 均关闭；
- 页面脚本在设置、解析预加载和最终网络调度等多层被拒绝，不执行也不下载；
- bmalloc、WTF、JavaScriptCore、PAL 和 WebCore 作为 OBJECT 库汇入 `shot.dll`，仅 C ABI 对外可见；
- Windows 使用 Skia CPU、DirectWrite、curl 与 OpenSSL；默认截图路径不需要 GPU 或 ANGLE 运行库；
- Linux 使用 Skia CPU、Fontconfig/FreeType、curl 与 OpenSSL；
- macOS 使用 CoreGraphics/CoreText 与 CFNetwork，WebP 输出由静态链接的 libwebp 编码。

更完整的设计、裁剪依据与里程碑记录见 [`AGENTS.md`](AGENTS.md)。网络接入点见 [network-integration-map.md](Source/WebKitShot/docs/network-integration-map.md)。

## 当前体积与性能

Windows x64、MinSizeRel、full LTO 的当前基线：

| 项目 | 实测值 |
|---|---:|
| `shot.dll` | 39,421,440 bytes |
| 完整解压目录 | 57.77 MiB / 27 files |
| `tar.xz` 发布包 | 17,260,888 bytes |
| 1000 次 480×320 PNG 连续渲染 | 66.8 images/s |
| 压力测试峰值 RSS | 30.3 MiB |

上述压力测试运行于 Windows、Intel Core i9-14900KF，仅用于记录当前版本回归基线，不代表所有机器上的性能承诺。

仓库还包含与 Puppeteer / Playwright 多引擎的可复现对比工具和原始结果，见 [`demo/browser-benchmark`](demo/browser-benchmark/)。ShotKit 与完整浏览器的能力边界不同，基准数据应结合页面类型与测试口径理解。

## 从源码构建

Windows 构建使用以下工具链：

- Visual Studio C++ Build Tools 与 Windows SDK；
- LLVM/clang-cl、CMake、Ninja；
- Ruby、Perl、gperf、Bison/Flex；
- vcpkg 提供的 ICU、Skia、curl、OpenSSL、HarfBuzz、libxml2/libxslt 等依赖。

本地发布构建默认使用 MinSizeRel + full LTO + `/OPT:REF /OPT:ICF`：

```powershell
pwsh Source/WebKitShot/build-shot.ps1 -Configure -Build
```

[`build-shot.ps1`](Source/WebKitShot/build-shot.ps1) 会从脚本位置解析仓库根目录，并自动发现 Visual Studio、LLVM 与 vcpkg；也可通过 `-Root`、`-LlvmBin`、`-VcpkgRoot`、`-VcpkgInstalledDir` 显式指定。Windows hosted CI 使用受限并行和单线程 full LTO 链接，降低标准 runner 的内存峰值。

三个平台的 CI 都上传 `tar.xz` 与 SHA-256，不把解压目录交给 GitHub ZIP 再次压缩。这些归档是当前提交的验证产物，不等同于稳定版本发布。

Linux 使用 Ubuntu 24.04、clang-18、lld-18 和系统开发包构建：

```bash
cmake -S . -B WebKitBuild/shot-linux -G Ninja \
  -DPORT=Shot -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DCMAKE_C_COMPILER=clang-18 -DCMAKE_CXX_COMPILER=clang++-18 \
  -DLTO_MODE=full
ninja -C WebKitBuild/shot-linux -j2 shotcli
```

macOS 使用 Xcode 26.3、CMake、Ninja、ICU 与 WebP 构建：

```bash
brew install bison cmake gperf icu4c ninja webp
export CMAKE_PREFIX_PATH="$(brew --prefix icu4c);$(brew --prefix webp)"
cmake -S . -B WebKitBuild/shot-macos -G Ninja \
  -DPORT=Shot -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DCMAKE_PREFIX_PATH="$CMAKE_PREFIX_PATH" -DLTO_MODE=OFF
ninja -C WebKitBuild/shot-macos -j3 shotcli
```

Windows、Linux 与 macOS CI 均检查 PNG/WebP、脚本零请求、10 个 C ABI 导出、可重定位 CLI 和发布归档。macOS 还检查内部链接完整性、CFNetwork 与 XML/XSLT；Linux hosted 构建使用 full LTO，Windows hosted 构建使用受限并行和单线程链接。

生成传统解压即用的 Windows 发布包：

```powershell
pwsh Source/WebKitShot/tools/package-release.ps1 -Version 0.1.0
```

构建 WebKit 规模较大，full LTO 链接在当前基线上峰值约需 29 GB 内存。日常开发可使用增量构建，最终发布时再启用完整配置。

## 项目目录

| 路径 | 内容 |
|---|---|
| [`Source/WebKitShot/`](Source/WebKitShot/) | ShotKit 内核、C ABI、CLI、SDK、测试与发布工具 |
| [`Source/cmake/OptionsShot.cmake`](Source/cmake/OptionsShot.cmake) | Shot 端口特性与依赖矩阵 |
| [`Source/WebCore/ShotPruning.cmake`](Source/WebCore/ShotPruning.cmake) | WebCore IDL/绑定裁剪入口 |
| [`demo/browser-benchmark/`](demo/browser-benchmark/) | 跨引擎基准工具与结果 |
| [`AGENTS.md`](AGENTS.md) | 完整架构决策、风险、体积账本与路线图 |

## 已知限制与安全边界

- **静态页面限定**：CSR/SPA 若服务器不返回可渲染内容，截图可能为空；
- **iframe 尚未支持**：主文档中的 iframe 当前不会完成独立导航；
- **不是安全沙箱**：ShotKit 为单进程解析与渲染内核，不提供浏览器级进程隔离。处理不可信远程内容时，应由调用方放入受限账户、容器或独立进程，并设置资源与时间限制；
- **单线程 API**：同一实例不能从多个线程并发调用；并行任务使用多进程；
- **平台差异**：Windows/Linux 使用 Skia，macOS 使用 CoreGraphics/CoreText；字体回退、抗锯齿与颜色管理可能产生像素差异；
- **产物状态**：GitHub Actions artifact 是当前提交的短期构建快照，不提供稳定版本兼容性承诺；macOS hosted artifact 当前为 arm64；
- `extra_font_dir` 与 `background_rgba` 已保留在 ABI 中，但目前尚未接线。

## 路线图

- [x] Windows：HTML/URL → PNG/WebP、网络子资源、XML/XSLT、C ABI、CLI、Node.js；
- [x] 体积 DCE、ICU 数据裁剪、无脚本网络闭包、重复渲染压力测试；
- [x] 参数化 Windows bootstrap，并建立公开 CI 与可复现构建产物；
- [x] Linux：Fontconfig/FreeType + Generic RunLoop；
- [x] macOS：CoreGraphics/CoreText + CFNetwork；
- [ ] iframe；
- [ ] Python / Go / Rust 的正式绑定与示例。

## 贡献

Issue 和 Pull Request 都欢迎。提交裁剪改动时，请同时说明：

- 对静态截图能力的影响；
- 对 `shot.dll` 和完整发布包的实测体积变化；
- 覆盖的 PNG/WebP、网络、XML/XSLT 或多语言回归结果。

仓库是 WebKit 的 snapshot fork，不以持续 rebase 上游为目标。具体工作约定见 [`AGENTS.md`](AGENTS.md)。

## 许可证

本仓库基于 WebKit，原有源码继续适用各文件和目录中的上游许可证与版权声明，分发时必须保留相应 notices。ShotKit 新增代码及二进制第三方依赖的顶层许可证/NOTICE 清单尚未完成；在第一次公开发布前需要补齐，当前请勿把本仓库描述为已完成许可证审查的正式发行版。

ShotKit 是独立的 WebKit fork，不是完整浏览器，也不代表 WebKit 上游项目。
