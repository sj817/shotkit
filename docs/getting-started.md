# ShotKit 入门指南

本页说明如何使用 npm 原生 SDK、CI 构建归档、运行 `shotcli`，以及在 Windows、Linux 和 macOS 上从源码构建 ShotKit。C ABI 与 JSONL 集成方式见 [跨语言调用](language-bindings.md)。

## Node.js

```bash
npm install @pixel.js/shotkit
```

```js
import { launch } from '@pixel.js/shotkit';

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

CI 架构对应的 hosted runner：Windows `windows-2022` / `windows-11-arm`，Linux `ubuntu-24.04` / `ubuntu-24.04-arm`，macOS `macos-15`（arm64）/ `macos-15-intel`（x64）。macOS Intel 作业按镜像可用性自动选择 Xcode（26.3 → 26.x → 16.4）。

CI 的入口是 `build.yml`（push 到 `main`、`workflow_dispatch`，以及被 `preview.yml` / `publish.yml` 调用）：`resolve` 先算**引擎指纹**——`scripts/ci/fingerprint.mjs` 对构建闭包（`Source/ shot/ Tools/ WebKitLibraries/`、CMake/vcpkg 清单、`tests/capi_thread_test.cpp`、打包脚本、三份 `build-*.yml`）做 `git ls-tree` 的内容哈希，加上 `node-api-headers` 的锁定版本与 LTO 模式——再查 `engine-<os>-<arch>-<fp>` / `engine-node-<os>-<arch>-<fp>` 两个制品是否已由本仓库的构建 run 上传，只把缺的架构交给 `build-<os>.yml`；改 SDK、文档、benchmark、发布脚本不会触发任何编译。随后 `verify` 在六个 runner 上用 `scripts/ci/verify-runtime.mjs` 对**发布形态**的归档与 addon 跑冒烟、SDK 套件、parity、soak、无脚本网络断言（macOS 再加 XML/XSLT），Linux x64 另在 Node 18.18/20/22/24 上加载同一 addon。六个 verify 作业均为必过作业；`build-<os>.yml` 自身只做二进制级检查（C ABI 线程归属、导出面、闭包与体积预算）。

编译缓存是 ccache（direct + depend 模式），缓存目录与 Windows 的 vcpkg 二进制一起打成 artifact（`ccache-<os>-<arch>`、`vcpkg-<triplet>`）跨 run 复用，不走 Actions cache——后者 7 天不用就整体驱逐、PR 写的条目 main 读不到。`refresh.yml` 每月把各家族最新制品重传一遍防过期（90 天）。强制重建：`gh workflow run build.yml -f force=true`。

## 获取构建归档

`build-<os>.yml` 上传 `engine-<os>-<arch>-<fp>`（`tar.xz` 与 SHA-256）和 `engine-node-<os>-<arch>-<fp>`（addon 闭包）。CI artifact 保留 90 天，按指纹跨提交复用，但不属于稳定版本发布，也不承诺跨发布的 ABI 或行为兼容性。

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

Windows 归档包含运行时依赖 DLL。Linux 归档依赖 `DEPENDENCIES.txt` 中记录的系统共享库，Ubuntu 24.04 上对应下面这组包（CI 的 verify 作业就是在只装了它们的干净 runner 上跑归档里的二进制）：

```bash
sudo apt-get install -y --no-install-recommends \
  libatomic1 libbrotli1 libcurl4t64 libegl1 libfontconfig1 libfreetype6 \
  libgles2 libharfbuzz-icu0 libharfbuzz0b libicu74 libjpeg-turbo8 \
  libpng16-16t64 libpsl5t64 libsqlite3-0 libssl3t64 libwebp7 libwebpdemux2 \
  libwebpmux3 libwoff1 libxml2 libxslt1.1 zlib1g
```

macOS 归档使用系统框架，WebP 编码器已静态链接。

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

macOS CI 与其它平台一样以 full LTO 构建（`-DLTO_MODE=full`），发布归档同受 18,000,000 字节上限约束。

## 本地验证

构建完成后至少验证 PNG、WebP 与脚本零请求：

```bash
./WebKitBuild/shot-linux/bin/shotcli --html page.html --out smoke.png
./WebKitBuild/shot-linux/bin/shotcli --html page.html --out smoke.webp --format webp --quality 82
```

将路径替换为当前平台的构建目录和可执行文件。同一套检查可以在本地对构建树一次跑完：

```bash
node scripts/ci/verify-runtime.mjs --os linux --arch x64 --build-dir WebKitBuild/shot-linux
# Windows 需要把 vcpkg 的 bin 目录放进 PATH：
node scripts/ci/verify-runtime.mjs --os windows --arch x64 --build-dir WebKitBuild/shot --vcpkg-bin WebKitBuild/vcpkg_installed/x64-windows-webkit/bin
```

CI 的 `verify` 作业对发布归档与 addon 制品执行同一脚本，构建作业另做：

- 动态库只导出 10 个 `shot_*` C ABI 符号，`shot.node` 只导出 Node-API 注册符号；
- CLI 使用相对 RPATH 或同目录 DLL，可随归档移动；
- 三个平台都以 full LTO 构建并检查压缩包体积上限；
- macOS 检查 WebCore 内部链接完整性；
- Windows 检查精简 ICU 与发布依赖收集。

## 运行边界

- 页面 JavaScript、WebAssembly、音视频、WebGL、WebGPU 与 WebRTC 不受支持；
- CSR/SPA 页面如果服务端不返回可渲染内容，截图可能为空；
- iframe 导航尚未实现；
- C ABI 绑定初始化线程，renderer 不能跨线程并发调用；
- Node SDK 在进程内运行，原生崩溃会终止 Node；需要隔离时使用独立 `shotcli` 进程；
- ShotKit 是单进程渲染内核，不提供浏览器级进程隔离。处理不可信内容时，应在受限账户、容器或独立进程中运行，并设置资源和时间限制。
