# ShotKit 入门指南

本页说明如何使用 npm 原生 SDK、CI 构建归档、运行 `shotcli`，以及在 Windows、Linux 和 macOS 上从源码构建 ShotKit。C ABI 与 JSONL 集成方式见 [跨语言调用](language-bindings.md)。

## Node.js

```bash
npm install @shotkit/node
```

```js
import { launch } from '@shotkit/node';

const shot = await launch();
const result = await shot.screenshotHTML('<h1>Hello</h1>', { outputPath: 'shot.png' });
console.log(result.bytes, result.durationMs, result.elapsedMs);
await shot.close();
```

npm 包按平台安装预编译的 `shot.node`，不启动 CLI、不写临时截图文件。要求 Node 18.18+
并使用同一 N-API v8 构建；当前版本只支持主 Node 环境，不支持 `worker_threads` isolate。

## 平台支持

| 平台 | CI 架构 | 图形与字体 | 网络 | 动态库 |
|---|---|---|---|---|
| Windows | x64、arm64 | Skia CPU + DirectWrite | curl + OpenSSL | `shot.dll` |
| Linux | x64、arm64 | Skia CPU + Fontconfig/FreeType | curl + OpenSSL | `libshot.so` |
| macOS | arm64、x64 | CoreGraphics + CoreText | CFNetwork | `libshot.dylib` |

三个端口使用相同的 C ABI、CLI 参数和加载规则。Windows/Linux 与 macOS 使用不同的图形后端，字体回退、抗锯齿和颜色管理可能产生细微像素差异。

CI 架构对应的 hosted runner：Windows `windows-2022` / `windows-11-arm`，Linux `ubuntu-24.04` / `ubuntu-24.04-arm`，macOS `macos-15`（arm64）/ `macos-15-intel`（x64）。六个作业均为必过作业。macOS Intel 作业按镜像可用性自动选择 Xcode（26.3 → 26.x → 16.4）。

## 获取构建归档

Windows、Linux 和 macOS 工作流会在回归通过后上传 `tar.xz` 与 SHA-256 文件。CI artifact 保留 7 天，只用于验证对应提交，不属于稳定版本发布，也不承诺跨提交的 ABI 或行为兼容性。

下载与当前平台匹配的归档并校验摘要：

```bash
sha256sum -c shotkit-*.tar.xz.sha256
tar -xf shotkit-*.tar.xz
```

macOS 使用以下命令校验：

```bash
shasum -a 256 -c shotkit-*.tar.xz.sha256
tar -xf shotkit-*.tar.xz
```

Windows 归档采用扁平运行目录，CLI、核心库和依赖 DLL 位于同一级：

```text
shotkit-<version>-windows-x64/
├── shotcli.exe
├── shot.dll
├── *.dll
├── include/
│   └── shot.h
└── README.txt
```

Linux 和 macOS 归档采用分层目录：

```text
shotkit-<version>-<platform>-<arch>/
├── bin/
│   └── shotcli
├── include/
│   └── shot.h
├── lib/
│   └── libshot.so | libshot.dylib
├── DEPENDENCIES.txt
└── README.md
```

Windows 归档包含运行时依赖 DLL。Linux 归档依赖 `DEPENDENCIES.txt` 中记录的系统共享库。macOS 归档使用系统框架，WebP 编码器已静态链接。

## 运行 CLI

Windows：

```powershell
.\shotcli.exe --url https://example.com/ --out example.png --full-page
.\shotcli.exe --html .\page.html --out page.webp --format webp --quality 82
Get-Content .\page.html -Raw | .\shotcli.exe --stdin --out stdin.png
```

Linux 和 macOS：

```bash
./bin/shotcli --url https://example.com/ --out example.png --full-page
./bin/shotcli --html ./page.html --out page.webp --format webp --quality 82
./bin/shotcli --html ./page.html --out page-lossless.webp --format webp-lossless
cat ./page.html | ./bin/shotcli --stdin --out stdin.png
```

完整参数形式：

```text
shotcli (--html <file> | --stdin | --url <url>) --out <image>
        [--width W] [--height H] [--scale S] [--full-page]
        [--format png|webp|webp-lossless] [--quality 0..100]
        [--mime-type TYPE] [--timeout MS] [--base-url URL]
        [--ua STRING] [--allow-file-urls]
```

`file://` 默认关闭。只有在输入页面及本地资源可信时才应启用 `--allow-file-urls`。

## 从源码构建

仓库规模接近 WebKit。首次构建需要较长时间和较多内存；日常修改应复用同一构建目录进行增量构建。

### Windows

所需工具包括 Visual Studio C++ Build Tools、Windows SDK、LLVM/clang-cl、CMake、Ninja、Ruby、Perl、gperf、Bison/Flex 和 vcpkg 依赖。

```powershell
pwsh scripts/build-shot.ps1 -Configure -Build
```

脚本自动发现 Visual Studio、LLVM 和 vcpkg。可通过 `-Root`、`-LlvmBin`、`-VcpkgRoot` 与 `-VcpkgInstalledDir` 指定路径。完整 full LTO 链接的内存峰值较高；普通开发可复用已有 `WebKitBuild/shot` 做增量构建。

### Linux

CI 基线为 Ubuntu 24.04、clang-18、lld-18、CMake 和 Ninja。依赖包括 ICU、curl、OpenSSL、Fontconfig、FreeType、HarfBuzz、PNG、JPEG、WebP、libxml2/libxslt、SQLite、PSL、Brotli 与 WOFF2。

```bash
cmake -S . -B WebKitBuild/shot-linux -G Ninja \
  -DPORT=Shot \
  -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DCMAKE_C_COMPILER=clang-18 \
  -DCMAKE_CXX_COMPILER=clang++-18 \
  -DCMAKE_AR="$(command -v llvm-ar-18)" \
  -DCMAKE_RANLIB="$(command -v llvm-ranlib-18)" \
  -DCMAKE_EXE_LINKER_FLAGS="-fuse-ld=lld -Wl,--threads=1" \
  -DCMAKE_SHARED_LINKER_FLAGS="-fuse-ld=lld -Wl,--threads=1" \
  -DLTO_MODE=full
ninja -C WebKitBuild/shot-linux -j2 shotcli
```

开发阶段可将 `-DLTO_MODE=full` 改为 `-DLTO_MODE=OFF`，减少链接时间和内存占用。发布体积基线以 full LTO CI 为准。

### macOS

CI 基线为 macOS 15、Xcode 26.3、CMake、Ninja、ICU 和 WebP。CoreGraphics、CoreText 与 CFNetwork 来自系统 SDK。

```bash
brew install bison cmake gperf icu4c ninja webp
export PATH="$(brew --prefix bison)/bin:$(brew --prefix icu4c)/bin:$PATH"
export CMAKE_PREFIX_PATH="$(brew --prefix icu4c);$(brew --prefix webp)"

cmake -S . -B WebKitBuild/shot-macos -G Ninja \
  -DPORT=Shot \
  -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DCMAKE_PREFIX_PATH="$CMAKE_PREFIX_PATH" \
  -DLTO_MODE=OFF
ninja -C WebKitBuild/shot-macos -j3 shotcli
```

当前 macOS CI 关闭 LTO，优先验证端口功能和链接完整性。正式体积基线需要在发布配置确定后重新记录。

## 本地验证

构建完成后至少验证 PNG、WebP 与脚本零请求：

```bash
./WebKitBuild/shot-linux/bin/shotcli --html page.html --out smoke.png
./WebKitBuild/shot-linux/bin/shotcli --html page.html --out smoke.webp --format webp --quality 82
```

将路径替换为当前平台的构建目录和可执行文件。CI 还执行以下检查：

- PNG 与 WebP 文件生成且大小有效；
- 页面 JavaScript 不执行，脚本和 preload 请求计数为 0；
- 动态库只导出 10 个 `shot_*` C ABI 符号；
- CLI 使用相对 RPATH 或同目录 DLL，可随归档移动；
- Linux 使用 full LTO 并检查压缩包体积上限；
- macOS 检查 WebCore 内部链接完整性、CFNetwork、XML/XSLT 与 arm64 发布归档；
- Windows 检查精简 ICU、full LTO、发布依赖收集与压缩包体积上限。

## 运行边界

- 页面 JavaScript、WebAssembly、音视频、WebGL、WebGPU 与 WebRTC 不受支持；
- CSR/SPA 页面如果服务端不返回可渲染内容，截图可能为空；
- iframe 导航尚未实现；
- C ABI 绑定初始化线程，renderer 不能跨线程并发调用；
- Node SDK 在进程内运行，原生崩溃会终止 Node；需要隔离时使用独立 `shotcli` 进程；
- ShotKit 是单进程渲染内核，不提供浏览器级进程隔离。处理不可信内容时，应在受限账户、容器或独立进程中运行，并设置资源和时间限制。
