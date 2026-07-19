# AGENTS.md — ShotKit：WebKit 纯静态截图内核

> 本文件是本仓库的最高优先级工作指导。任何会话开始实施前必须通读本文件。
> 方案定稿日期：2026-07-13。基线：WebKit 上游快照（约 WPE 2.53.3，2026-07）。

## 1. 项目定位

本仓库是 WebKit 的 fork。目标产物 **ShotKit**：一个裁切到极限的纯静态截图内核——

- **输入**：HTML 字符串 / 本地 HTML 文件 / 远程 URL
- **输出**：PNG / WebP（有损或无损）字节
- **形态**：无头（headless）、单进程、跨平台（Windows / Linux / macOS）
- **交付**：C ABI 动态库 `libshot` + 命令行工具 `shotcli`，供 Node / Python / Go 绑定
- **体积是一等目标**：产物追求极致小。任何新增依赖/特性都要回答"值多少 KB"；体积化清单见第 4.5 节，每个里程碑都要记录体积基线（第 7 节）

**这不是一个浏览器。** 明确不做：JS 执行（页面脚本永不运行）、视频/音频、WebGL/WebGPU、Web Inspector、双进程架构、窗口系统、用户交互。它是一个"HTML/CSS → 像素"的确定性渲染器。

**工作模式：快照裁切（snapshot fork），不再跟进上游。** 项目已决定放弃 rebase 上游同步，只对准两个目标：**能截图** + **二进制极致小**。因此：
- 允许直接编辑上游源码来减小体积（删 `Sources.txt` 行、桩化文件、裁 IDL 清单等），不再要求改动全落在新增文件里。
- 但**仍优先把逻辑集中在新端口 + `Source/WebKitShot/`**——不是为了 rebase，而是为了改动可追踪、可回滚、心智负担低。对上游源文件的每一处删改，登记到本文件末尾的"上游偏离清单"（现在它是"改了什么"的账本，不再是"待还的债"）。
- 端口机制（`PORT=Shot`）依然是最干净的组织方式，保留。

## 2. 核心架构决策（已拍板，不要重新讨论）

| 决策点 | 结论 | 一句话理由 |
|---|---|---|
| JS 引擎 | **保留 JSC 但裁到最小**：`ENABLE_C_LOOP=ON` 纯 LLInt 解释器（自动关掉全部 JIT/DFG/FTL/WASM）+ 设置层禁死脚本执行 | 完全移除不可行，见下方证据链 |
| 图形后端 | Windows/Linux = **Skia 纯 CPU 软光栅**（vendored，`Source/ThirdParty/skia`）；macOS = **CoreGraphics/CoreText** | WebKit 树内不存在 macOS+Skia 接线；接受平台间像素差异 |
| 网络栈 | Windows/Linux = **curl + OpenSSL**；macOS = **CFNetwork** | curl 后端本质跨平台（Win/PlayStation 端口先例）；macOS 换 curl 会迫使修改上游几十个 .mm |
| 代码组织 | **新自定义端口 `PORT=Shot`**，蓝本 = PlayStation 端口；允许直接改上游源码（快照模式） | 端口机制按文件名自动挂载；不再追求 rebase，改动登记到偏离清单即可 |
| 进程模型 | **单进程直嵌 WebCore**，不编译 `Source/WebKit` 双进程层 | WebCore 内部的 SVGImage 就是现成的单进程自嵌入模板 |
| 事件循环 | 各平台用 WTF 默认（Win 消息泵 / mac CFRunLoop / Linux Generic） | 都是官方走过的组合；mac 的 CFNetwork/CoreText 需要 CFRunLoop |
| 链接形态 | bmalloc/WTF/JSC/PAL/WebCore 全部 **OBJECT 库**静态汇入 `libshot`（SHARED，只导出 C ABI） | 仿 `OptionsPlayStation.cmake:353-367` + `ENABLE_STATIC_JSC` |
| 体积策略 | **MinSizeRel + LTO + section GC + 符号全隐藏 + 特性最小集 + 依赖裁剪**，体积回归纳入 CI | 用户要求极致体积；静态汇入 + 只导出 C ABI 让链接器能做全程序死代码消除 |

### 为什么不能移除 JavaScriptCore（证据链，防止后续会话重新尝试）

以下事实已在源码中逐一核实，**不要再试图"拆掉 JSC"**：

1. 构建系统级联：`Source/cmake/WebKitCommon.cmake:56-58` —— `ENABLE_JAVASCRIPTCORE=OFF` 会强制 `ENABLE_WEBCORE=OFF`。`Source/WebCore/CMakeLists.txt` 中 `WebCore_FRAMEWORKS` 无条件包含 JavaScriptCore。
2. DOM 对象模型地基：每个 DOM 节点的基类链 `Node → EventTarget → ScriptWrappable`，而 `Source/WebCore/bindings/js/ScriptWrappable.h:57` 内嵌成员 `JSC::Weak<JSC::JSObject> m_wrapper`。`EventListener.h` 依赖 JSC GC 遍历类型。
3. `LocalFrame` 强持有 `ScriptController`（`Source/WebCore/page/LocalFrame.h:401`，`UniqueRef` 非空成员），85 个文件引用它；23 个非绑定文件直接使用 `commonVM()`（Document/Page 的 GC 调度）。
4. 正则引擎 Yarr 物理上在 `Source/JavaScriptCore/yarr/`，被纯渲染功能依赖：`<input type=email>` 校验、`pattern` 属性、URLPattern 等 17 个文件。
5. 量化：WebCore 共 921 个文件 include JSC 头文件；约 1800 对 IDL 生成绑定。完全移除 = 重写数百个核心文件 + 与上游永久分叉，人年级工程。

**达成"页面 JS 永不执行"的正确方式（零源码改动）**：
- 编译期：`ENABLE_C_LOOP=ON`（`WebKitFeatures.cmake` 的 CONFLICT 机制自动强制 JIT/SAMPLING_PROFILER/WEBASSEMBLY=OFF）。
- 运行期：`Settings::setScriptEnabled(false)`——注意 WebCore 层默认值本来就是 false（`Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml` 中 `JavaScriptEnabled` 的 `WebCore: { default: false }`）。所有脚本入口都被 `ScriptController::canExecuteScripts`（`Source/WebCore/bindings/js/ScriptController.cpp:842-862`）短路：`<script>`、内联事件、`javascript:` URL、定时器回调全部不执行。
- 保留下来的 JSC 只是：LLInt 解释器 + JSObject/GC 对象模型（DOM 包装器底座）+ Yarr 正则。

## 3. 代码地图

### 3.1 待新建的文件（全部是新增，实施顺序见第 7 节路线图）

```
Source/cmake/OptionsShot.cmake              # 端口选项（开关矩阵见第 4 节）
Source/PlatformShot.cmake                   # 被 Source/CMakeLists.txt 自动 include，挂 WebKitShot 子目录
Source/bmalloc/PlatformShot.cmake           # 各层平台文件，仿对应 PlatformPlayStation.cmake / PlatformWin.cmake
Source/WTF/wtf/PlatformShot.cmake
Source/JavaScriptCore/PlatformShot.cmake
Source/WebCore/PAL/pal/PlatformShot.cmake
Source/WebCore/PlatformShot.cmake
Source/WebKitShot/
├── ShotKit/                                # C++ 内核（类设计见第 5 节）
│   ├── ShotGlobal.{h,cpp}                  # 进程级一次性初始化、主线程绑定
│   ├── ShotPage.{h,cpp}                    # Page 生命周期 + 渲染状态机
│   ├── ShotFrameLoaderClient.{h,cpp}       # 继承 EmptyFrameLoaderClient，覆写策略/网络虚函数
│   ├── ShotChromeClient.h                  # 继承 EmptyChromeClient，极薄
│   ├── ShotProgressTrackerClient.{h,cpp}   # 加载进度 → 完成状态机
│   ├── ShotPlatformStrategies.{h,cpp}      # PlatformStrategies + ShotLoaderStrategy
│   ├── ShotCurlResourceLoader.{h,cpp}      # [Win/Linux] CurlRequestClient → ResourceLoader 数据泵
│   ├── ShotNetworkingContext.h             # FrameNetworkingContext 实现
│   └── ShotSession.{h,cpp}                 # ephemeral NetworkStorageSession + 内存 CookieJar
├── capi/
│   ├── shot.h                              # C ABI 公开头（草案见第 6 节）
│   └── shot.cpp
└── cli/
    └── main.cpp                            # shotcli
```

最小上游修改：`Source/cmake/WebKitCommon.cmake` 的 `ALL_PORTS`（约 75-83 行）加 `Shot`。M0 只需这一处；二期的激进裁切（4.6）会另有对 `Sources.txt`/IDL 清单/accessibility 的删改，均登记在偏离清单。

### 3.2 上游关键文件索引（只读参考，实施时照着抄）

| 文件 | 用途 |
|---|---|
| `Source/WebCore/svg/graphics/SVGImage.cpp:528-592`（`dataChanged`） | **单进程自嵌入 Page 的主模板**：创建 Page → 直喂数据 → 布局。析构收尾也参考它 |
| `Source/WebCore/loader/EmptyClients.cpp:1253`（`pageConfigurationWithEmptyClients`） | 空客户端全家桶装配；我们替换其中 3 个（FrameLoaderClient / ProgressTrackerClient / CookieJar） |
| `Source/WebCore/page/FrameSnapshotting.cpp:73-151`（`snapshotFrameRect`） | 布局 → ImageBuffer 的快照实现（内部处理 deviceScaleFactor） |
| `Source/WebCore/platform/graphics/ImageUtilities.h`（`encodeData`） | ImageBuffer → PNG 字节（Skia 端 `ImageUtilitiesSkia.cpp`，mac 端 CG 版本） |
| `Source/WebKitLegacy/WebCoreSupport/WebResourceLoadScheduler.cpp` | **ShotLoaderStrategy 的单进程调度蓝本**（该文件不参与我们的编译，纯抄写参考） |
| `Source/WebKit/NetworkProcess/curl/NetworkDataTaskCurl.cpp` | **CurlRequest 驱动模板**：重定向、cookie 回写、TLS 错误映射逐段移植 |
| `Source/cmake/OptionsPlayStation.cmake` | **端口蓝本**：OBJECT 库（353-367）、ENABLE_STATIC_JSC（167）、JIT 全关（170-172）、特性硬关（219-227）、curl/OpenSSL/HarfBuzz（265-275） |
| `Source/cmake/OptionsWin.cmake` | Windows 依赖 find_package 清单（44-54）、Skia（91）、curl（122） |
| `Source/cmake/OptionsMac.cmake` + `Source/WebCore/PlatformMac.cmake` | macOS CMake 构建现役路径（CG/CoreText 栈），M4 阶段参照 |
| `Source/WebCore/platform/graphics/skia/FontCacheSkia.cpp:44-70` | 字体管理器选择：Linux=SkFontMgr_New_FontConfig（Fontconfig+FreeType） |
| `Source/WebCore/platform/graphics/win/FontCacheSkiaWin.cpp` | Windows+Skia 字体 = DirectWrite |
| `Source/WebCore/platform/network/ResourceHandle.cpp:312-376` | **警示**：`USE(CURL)` 下 start/cancel 全是 `ASSERT_NOT_REACHED()` 桩——curl 的 ResourceHandle 后端已从 trunk 删除，**不要走 ResourceHandle 路线**（macOS 的 `ResourceHandleCocoa.mm` 是唯一真实现） |
| `Source/WebCore/loader/LoaderStrategy.h` / `platform/PlatformStrategies.h` | 我们的网络接入缝：`CachedResource::load()` 统一走 `loaderStrategy()->loadResource(...)` |
| `Source/WebCore/platform/network/curl/CurlRequest.h` / `CurlRequestClient.h` | Win/Linux 实际驱网的类（curlDidReceiveResponse/Data/Complete/FailWithError） |
| `Tools/WebKitTestRunner/skia/TestInvocationSkia.cpp` | 像素 dump 参考（SkPngEncoder 用法） |

## 4. OptionsShot.cmake 开关矩阵

骨架照抄 `OptionsPlayStation.cmake` 结构（`WEBKIT_OPTION_BEGIN/END` + 库类型段）。

### 构建形态
| 开关 | 值 | 理由 |
|---|---|---|
| `ENABLE_WEBKIT` | OFF | 不编双进程层 |
| `ENABLE_WEBKIT_LEGACY` | OFF | 不编旧 API 层（源码留作抄写蓝本） |
| `ENABLE_WEBINSPECTORUI` | OFF | 无检查器 |
| `ENABLE_STATIC_JSC`（自定义 option） | ON | 仿 PlayStation:167 |
| `bmalloc/WTF/JavaScriptCore/PAL/WebCore_LIBRARY_TYPE` | OBJECT | 全静态汇入 libshot，无中间 dll/so 边界 |

### JSC 最小化
| 开关 | 值 | 备注 |
|---|---|---|
| `ENABLE_C_LOOP` | PRIVATE ON | 纯 LLInt；CONFLICT 机制自动关 JIT/WASM/SAMPLING_PROFILER |
| `ENABLE_JIT` / `ENABLE_DFG_JIT` / `ENABLE_FTL_JIT` | PRIVATE OFF | 显式双保险 |
| CSS Selector JIT | `add_definitions(-DENABLE_CSS_SELECTOR_JIT=0)` | **无 CMake 变量**，只能编译定义覆盖 `wtf/PlatformEnable.h` 默认；选择器回退解释执行 |

### 特性关断（均为 WebKitFeatures.cmake 已有选项）
```
ENABLE_VIDEO=OFF  ENABLE_WEB_AUDIO=OFF  ENABLE_WEBGL=OFF（连带不再编 ANGLE）
ENABLE_WEBXR=OFF  ENABLE_MEDIA_STREAM=OFF  ENABLE_WEB_RTC=OFF  ENABLE_MEDIA_SOURCE=OFF
ENABLE_MEDIA_RECORDER=OFF  ENABLE_REMOTE_INSPECTOR=OFF  ENABLE_WEBDRIVER=OFF
ENABLE_NOTIFICATIONS=OFF  ENABLE_GEOLOCATION=OFF  ENABLE_FULLSCREEN_API=OFF
ENABLE_CONTEXT_MENUS=OFF  ENABLE_GAMEPAD=OFF  ENABLE_DRAG_SUPPORT=OFF
ENABLE_SPEECH_SYNTHESIS=OFF  ENABLE_OFFSCREEN_CANVAS=OFF  ENABLE_XSLT=ON（静态 XML/XSLT 截图必须）
ENABLE_SMOOTH_SCROLLING=OFF  ENABLE_ASYNC_SCROLLING=OFF  ENABLE_GPU_PROCESS=OFF
ENABLE_PERIODIC_MEMORY_MONITOR=OFF
ENABLE_MATHML=ON   # 纯渲染特性、零额外依赖，留下增强还原度；可随时关
```

### Windows / Linux 段（`if (WIN32)` / Linux）
| 项 | 值 | 备注 |
|---|---|---|
| `USE_SKIA` | ON | `Source/CMakeLists.txt` 自动挂 vendored `ThirdParty/skia` |
| `USE_SKIA_ENCODERS` | ON | `encodeData` 走 SkPngEncoder（M1 验证；备选 libpng 编码器路径） |
| `USE_CURL` + `USE_OPENSSL` | ON | `find_package(CURL/OpenSSL)`，仿 OptionsWin.cmake:44-53 |
| `USE_HARFBUZZ` | ON | Skia 文字整形必需 |
| `USE_TEXTURE_MAPPER` + `USE_COORDINATED_GRAPHICS` | ON | **编译期需要 GraphicsLayer 实现存在**（运行期 AC 已关）；仿 PlayStation 非-GPU-process 分支（310-324） |
| Linux 额外 | `find_package(Fontconfig, Freetype)` | FontCacheSkia 需要 |
| Windows 字体 | 无额外开关 | FontCacheSkiaWin.cpp（DirectWrite）随源列表进入 |
| 系统依赖 | ICU / PNG / JPEG / WebP / LibXml2 / SQLite3 / ZLIB / LibPSL / Brotli+WOFF2 | 照抄 OptionsWin.cmake；Windows 用 WebKitRequirements 预构建包 |
| `USE_LIBWPE / USE_GLIB / USE_AVIF / USE_LCMS / USE_JPEGXL` | OFF | 减依赖 |

### macOS 段（`if (APPLE)`，M4 阶段实施）
- 不设 USE_SKIA / USE_CURL。图形 = CG/CoreText，网络 = `platform/network/cf + cocoa`（CFNetwork，`ResourceHandleCocoa.mm` 可用）。
- 以 `OptionsMac.cmake` 为参照抄取必要的 `SET_AND_EXPOSE_TO_BUILD(HAVE_*/USE_CF/USE_CG)` 与框架 find；WebCore 源列表复用 `PlatformMac.cmake` 后做裁剪。
- 这是工作量最大的平台段，排在最后（见风险 R3）。

### WebCore/PlatformShot.cmake 组织（Win/Linux）
```cmake
include(platform/Curl.cmake)
include(platform/OpenSSL.cmake)
include(platform/Skia.cmake)
include(platform/ImageDecoders.cmake)
include(platform/TextureMapper.cmake)
# Linux: include(platform/FreeType.cmake)
# 再从 PlatformWin.cmake 摘 Windows 专属源（FontCacheSkiaWin 等）
```

### 4.5 体积极致化清单（一等目标）

体积优化分四层，从零成本到高成本排列。实施顺序：M0 就把编译/链接层全部打开（此时改代价最低），依赖裁剪随对应里程碑做，度量制度从 M1 起执行。

**① 编译/链接层（零功能代价，M0 全部落实）**
| 项 | 做法 | 备注 |
|---|---|---|
| 构建类型 | `CMAKE_BUILD_TYPE=MinSizeRel`（-Os / MSVC /O1） | 上游已识别（WebKitCommon.cmake:502 与 Release 同路径处理） |
| LTO | `-DLTO_MODE=full`（clang / clang-cl） | **上游现成钩子**：WebKitCompilerFlags.cmake:354-365 自动加 `-flto=<mode>`；Windows 建议 clang-cl 工具链以吃到 LTO |
| 死代码消除 | GCC/Clang：`-ffunction-sections -fdata-sections` + `--gc-sections`；MSVC：`/Gy /Gw` + `/OPT:REF /OPT:ICF` | 在 OptionsShot.cmake 追加；OBJECT 汇入 + 只导出 C ABI 使 GC 效果最大化 |
| 符号可见性 | `-fvisibility=hidden -fvisibility-inlines-hidden`；libshot 仅导出 `shot_*`（.def / version script / exported_symbols_list） | 隐藏符号同时是 gc-sections/ICF 的前提 |
| strip | 发布产物 `strip` / `/DEBUG:NONE`，调试符号分离存档 | |
| RTTI/异常 | WebKit 上游本就 `-fno-exceptions -fno-rtti`，确认 Shot 端口未意外打开 | |

**② 特性层（OptionsShot 开关，M0 落实）**
- 第 4 节矩阵是底线；此外**确保默认 OFF 的选项绝不打开**：`ENCRYPTED_MEDIA`、`WEB_AUTHN`、`WEB_CODECS`、`PDFJS`、`MHTML`、`TOUCH_EVENTS`、`SPELLCHECK`、`CONTENT_EXTENSIONS`、`APPLICATION_MANIFEST`、`SERVICE_CONTROLS`、`RESOURCE_USAGE` 等（WebKitFeatures.cmake 中默认即 OFF）。
- `ENABLE_MATHML=ON` 是唯一"奢侈品"：若体积压力大，第一个关它（纯减法，无依赖牵连）。

**③ 依赖裁剪层（随里程碑做）**
| 依赖 | 做法 | 预期收益 |
|---|---|---|
| 图像解码器/编码器 | 保留网站常用 PNG/JPEG/GIF/BMP/ICO/WebP 解码；截图输出保留 PNG、WebP 有损和 WebP 无损；AVIF/JXL/LCMS 关闭 | WebP 是产品必需能力，不作为可选裁点 |
| Skia / GPU 胶水 | 截图默认 CPU 软光栅；Windows 暂保留 ANGLE/EGL/TextureMapper 编译路径以兼容本地 GPU 环境，WebGL 仍关闭 | ANGLE 是现有 Win 图形层的编译依赖；后续若拆成 CPU-only/GPU 两种 profile 再分别计量 |
| ICU | 自定义 data filter 构建（`ICU_DATA_FILTER_FILE`）：只留 UTF-8/16 转换、常用 locale、断行/BiDi 必需数据；Windows 的 WebKitRequirements 预构建 ICU 换成自构建 | ICU 完整 data ≈ 30MB，裁剪后可到 5MB 以下，是**单项最大的体积杠杆**（自分发场景） |
| SQLite | 编译期去可选模块（`SQLITE_OMIT_*`、FTS/JSON/RTREE 不需要）；仅 curl 的 CookieJarDB 和少量存储路径用到 | 中等 |
| curl | 自构建：`--disable-ftp --disable-ldap --disable-smtp ...` 只留 HTTP(S)；TLS 只链 OpenSSL | 中等 |
| libxml2/libxslt | XML、XHTML、XSLT 为产品必需能力，保留解析与变换所需部分；仅裁 CLI、调试、插件等外围 | 小 |
| Brotli/WOFF2 | webfont 解码需要，保留；PSL 保留（cookie 安全必需） | — |

**④ 度量制度（从 M1 起强制）**
- 每个里程碑完成时记录：`libshot` + `shotcli` 的 strip 后体积（三平台各自），写入第 7 节表格的"体积基线"列。
- 用 `bloaty`（或 MSVC 下 `link /MAP` + 分析）出 per-section/per-symbol 报告，任何一次体积跳涨 >5% 必须归因。
- M5 CI 加体积预算门槛：超预算即红灯。预算数值在 M1 实测后定（先定基线，再谈目标；不预设拍脑袋数字）。

**明确不做的"负优化"**：不要为省体积换 `USE_SYSTEM_MALLOC`（bmalloc/libpas 很小且是 WebKit 性能/安全基座）；不要删 Yarr/LLInt（第 2 节证据链——删了 WebCore 无法链接）；不要动 `editing/`（`Editor` 是 `LocalFrame` 强成员，与 ScriptController 同款结构耦合，砍不动）；不要砍 SVG（截图保真度明显受损）。

### 4.6 激进裁切（快照模式专属，放弃上游同步后新解锁）

> 前提：已放弃 rebase（见第 1 节）。以下手段都要**直接编辑上游源码**，收益不再"归零于下次同步"。每一处删改登记到"上游偏离清单"。
> 铁则：**先量化再动刀**。这些改动的收益是 KB～MB 级，不是数量级级；优先级排在 4.5 的编译/链接层和 ICU/Skia 两大杠杆之后。等 M1 的 bloaty 报告出来，按实测占比决定动哪些。

**A. 已"免费"的模块（特性开关已排除，无需额外动手）** —— 这些 `Modules/` 子目录内部有 `#if ENABLE(...)` 门控（已核实：webaudio 有 `#if ENABLE(WEB_AUDIO)`），第 4 节把开关关掉后它们已编译为空壳：`webaudio`(57 文件)、`webxr`(52)、`mediastream`(52)、`webauthn`(22)、`mediasource`(13)、`webcodecs`(12)、`encryptedmedia`、`notifications`(7)、`geolocation`(5) 等。**不用碰，收益已计入特性层。**

**B. 无门控、纯 JS-facing 的死代码模块（需手工摘除）** —— 这些模块在 `Sources.txt` 中**无条件列出、无 `#if ENABLE` 门控**（已核实 indexeddb/websockets/webdatabase 均无门控，始终参与编译），但在"JS 永不执行"前提下运行期是纯死代码。LTO/gc-sections **消不掉**它们（被 JS binding 的 wrapper 注册表静态引用），必须手工摘：

| 模块 | Sources.txt 文件数 | 核心耦合 | 摘除性价比 |
|---|---|---|---|
| `Modules/indexeddb` | **61** | 被 dom/page/loader 引用 **0 次**（已核实），最松 | **最高**，先动它 |
| `Modules/webdatabase` | 17 | 纯 JS-facing，独立 | 高 |
| `Modules/websockets` | 12 | 纯 JS-facing，独立 | 高 |
| `Modules/push-api` | 12 | 依赖 service worker | 中 |
| `Modules/streams` | 15 | **⚠ 有内部使用**（fetch/response body 走 ReadableStream），不是纯死代码，谨慎 | 低 |
| `Modules/fetch` | 11 | **⚠ Response/Request 可能被 loader 内部用**，需核实后再动 | 低 |

**摘除一个模块的标准动作**（以 indexeddb 为例，不是简单删 `Sources.txt` 行）：
1. 删 `Source/WebCore/Sources.txt`（及 `SourcesCocoa.txt` 等平台变体）中该模块的 `.cpp` 行；
2. 删对应 IDL：从 `Source/WebCore/DerivedSources.make` / CMake 的 IDL 清单移除该模块 `.idl`，否则 `CodeGeneratorJS.pm` 仍生成引用它的 `JS*.cpp`；
3. 摘 supplement 挂载点：`DOMWindow`/`Navigator`/`WorkerGlobalScope` 上的 `indexedDB()` 访问器与 partial interface（`Modules/indexeddb/*.idl` 里的 `partial interface`），以及对应的 `Supplement` 注册；
4. 处理少量 include 悬挂引用，编译器会直接报给你。
先用 indexeddb 打通这套流程（耦合最松、收益最大），再套用到 webdatabase/websockets。

**C. accessibility 桩化** —— ⚠**修正（2026-07-14 实测）**：原以为 PlayStation 把整个 AX 子系统桩空，**不成立**。`accessibility/playstation/*` 只提供**平台胶水**（`attachWrapper` 等，对应 Mac 的 AXObjectCacheMac.mm），PlayStation 仍全量编译 `AXObjectCache.cpp`+`AccessibilityObject.cpp`+~40 个 AX 文件；且**无 `ENABLE_ACCESSIBILITY` 开关**（只有 `ACCESSIBILITY_ISOLATED_TREE`）。真要砍需自行清空全部 AX 主体并桩化每个被 Document/Render 调用的 `AXObjectCache::` 符号（调用点很多），**爆炸半径大、仅省 0.5 MB（map 实测）—— 性价比差，已降级不做。**

**D. inspector 桩化** —— `inspector/`(106 文件)+`inspector/agents/`(约 30 个 Agent)。`ENABLE_REMOTE_INSPECTOR=OFF` 已省掉远程协议前端，但 `InspectorInstrumentation` 的插桩钩子仍编织在核心里、无独立开关。可把各 `Inspector*Agent` 桩空 + 让 `InspectorInstrumentation` 内联空实现，属**中等复杂度**（钩子点多），排在 B/C 之后。

**E. 终极杠杆——JS 绑定层（约 1800 对生成的 `JS*.cpp`）** —— 这是 WebCore 二进制**最大的单块**（估计占 30–40%）。JS 永不执行时它们理论上全是死代码，但被 wrapper 注册表静态引用，LTO 消不掉。彻底砍需要改 `bindings/scripts/CodeGeneratorJS.pm` 生成逻辑或大规模裁 IDL 清单，并桩化数十处核心 wrapper 引用——**数周工作量，列为二期专项**，不在"不复杂"范围内。B 类模块摘除其实就是这件事的小规模预演（每摘一个模块就顺带干掉它那批绑定）。

**执行顺序建议**：4.5 的①编译链接层 + ICU/Skia 两杠杆 → M1 出 bloaty → 4.6-A 免费确认 → 4.6-B indexeddb 打样 → webdatabase/websockets → 4.6-C accessibility → 视收益再决定 D/E。

## 5. 嵌入库设计要点

### 5.1 ShotPage 渲染调用链（九步）

1. `auto cfg = pageConfigurationWithEmptyClients(std::nullopt, PAL::SessionID::generateEphemeralSessionID())`
2. 替换三件：`cfg.progressTrackerClient = ShotProgressTrackerClient`；`cfg.mainFrameCreationParameters` 的 clientCreator 换成 `ShotFrameLoaderClient`（**注意把 `SandboxFlags::all()` 改为空**——SVGImage 的全沙箱会禁外部子资源）；`cfg.cookieJar = CookieJar::create(ShotSession)`（curl 的 `NetworkStorageSession` 在 ephemeral 时自动用 `:memory:` cookie 库）
3. `Page::create(WTFMove(cfg))` → settings：`setScriptEnabled(false)`、`setAcceleratedCompositingEnabled(false)`、`setShouldAllowUserInstalledFonts(false)`、`setLargeImageAsyncDecodingEnabled(false)`、`setAnimatedImageAsyncDecodingEnabled(false)`、`setLazyImageLoadingEnabled(false)`、`page->setDeviceScaleFactor(scale)`、关图片动画（确定性首帧）
4. `localMainFrame->setView(LocalFrameView::create(*frame))` → `view->resize(w, h)` → `frame->init()`
5. 加载：HTML 字符串模式走 `loader->activeDocumentLoader()->writer()` 的 `setMIMEType("text/html"_s)` / `begin(baseURL)` / `addData(buffer)` / `end()`；URL 模式走 `frame->loader().load(FrameLoadRequest{...})`
6. 泵 RunLoop 直到完成状态机达成或超时（见 5.4）
7. `document->updateLayoutIgnorePendingStylesheets()`；全页模式取 `view->contentsSize()` 先 `resize` 再重排一次（fixed 定位语义与 Playwright fullPage 一致）
8. `snapshotFrameRect(*frame, rect, SnapshotOptions{{}, PixelFormat::BGRA8, DestinationColorSpace::SRGB()})`
9. `encodeData(WTFMove(buffer), "image/png"_s)` → `Vector<uint8_t>`

析构顺序仿 `SVGImage::~SVGImage`（先 frame 收尾再放 Page），ephemeral session 随 ShotSession 销毁。

### 5.2 ShotFrameLoaderClient 必须覆写的虚函数（Empty 版缺陷已逐一核对）

| 虚函数 | Empty 行为（缺陷） | Shot 覆写 |
|---|---|---|
| `dispatchDecidePolicyForNavigationAction` | **吞掉 FramePolicyFunction → 主资源永久卡死** | `policyFunction(PolicyAction::Use)`（仅首个导航；meta-refresh 等后续导航按配置 Ignore） |
| `dispatchDecidePolicyForResponse` | 同上 | 可显示 MIME → Use，否则 Ignore |
| `dispatchDecidePolicyForNewWindowAction` | 同上 | 一律 Ignore（无弹窗） |
| `canHandleRequest` | 返回 false → cannotShowURL | true |
| `canShowMIMEType` / `canShowMIMETypeAsHTML` | 返回 false → commit 失败 | `MIMETypeRegistry::canShowMIMEType(mime)` / true |
| `createNetworkingContext` | 空 session → cookie 全废；mac 上 ResourceHandle 需要真实 context | 返回 `ShotNetworkingContext`（mac 还需 `localFileContentSniffingEnabled` 等，Win/Linux 需 `blockedError`） |
| `createFrame` | 返回 nullptr → iframe 全空白 | M2 实现（仿 WebKit 层 createSubframe + `frame->init()`）；M1 保留 nullptr |
| `dispatchDidFinishLoad` / `dispatchDidFailProvisionalLoad` / `dispatchDidFailLoad` | no-op | 通知 ShotPage 状态机 |
| `userAgent` | 空串 | 可配置 UA |

`createDocumentLoader` 沿用 Empty 版（已是真实 `DocumentLoader::create`）。

> **⚠ 架构修正（M2 实测，2026-07-13）**：本版 WebKit 里 `EmptyFrameLoaderClient` 把上表几乎所有关键方法都标了 `final`（`dispatchDecidePolicyForNavigationAction` 空体、`canHandleRequest`/`canShowMIMEType` 返回 false、`createFrame` 返回 nullptr、`createNetworkingContext` 返回 EmptyFrameNetworkingContext，均 `final`，见 `EmptyClients.cpp:678/906/967/972/713/1174`）。**故不能继承 `EmptyFrameLoaderClient` 覆写**——`ShotFrameLoaderClient` 必须**直接继承 `LocalFrameLoaderClient`**，把 `EmptyFrameLoaderClient.{h,cpp}` 的约 100 个 no-op 实现整体拷来（去掉 `final`），仅改上表那 7 个关键方法体。
>
> **M2 简化策略（优先走这条，绕开导航策略机制）**：主资源**不走** `FrameLoader::load` 导航，而是**用 curl 自己抓 URL 字节（跟随重定向、取最终 URL 作 base）→ 喂 `DocumentWriter`**（就是 M1 已跑通的 HTML 路径）。子资源（外链 CSS/图/webfont）走 `CachedResource::load → loaderStrategy()->loadResource` 的 `SubresourceLoader` 路径，**不经 FrameLoaderClient 策略**。这样非-iframe 页面根本不触发那 7 个坏方法，`ShotFrameLoaderClient` 可暂缓/最小化。**唯一仍需真 FrameLoaderClient 的是 iframe**（`createFrame` + 子框架导航）——排在最后，非核心可后置。待核实：`SubresourceLoader::init` 是否会查 `frameLoaderClient().canHandleRequest`（若查，因其 `final` 返回 false，子资源会失败，则仍须全量 `LocalFrameLoaderClient`）——此点由网络接入缝调研确认。

### 5.3 ShotLoaderStrategy（网络接入缝）

`ShotPlatformStrategies : PlatformStrategies` 提供 4 个工厂：LoaderStrategy=自研；Pasteboard/Media=no-op 桩；BlobRegistry=包装进程内 `BlobRegistryImpl`（blob: 子资源可用）。

`ShotLoaderStrategy : LoaderStrategy`，抄写蓝本 `WebResourceLoadScheduler.cpp`，差异只在"起飞"一步：
- **macOS**：`scheduleLoad` → `resourceLoader->start()`（ResourceHandleCocoa 真实现，WebKitLegacy Mac 现行路径）
- **Win/Linux**：`data:` 和 `blob:` 仍走 `loader->start()`（平台无关内置路径）；http(s) 创建 `ShotCurlResourceLoader`——实现 `CurlRequestClient`，构造 `CurlRequest` 驱网，把事件转译回灌 `ResourceLoader` 的公开虚函数（`willSendRequest` / `didReceiveResponse` / `didReceiveData` / `didFinishLoading` / `didFail`，与双进程模式下 `WebResourceLoader` 驱动 coreLoader 是同一套接口）。重定向 / cookie 读写（`NetworkStorageSession::cookieRequestHeaderFieldValue` / `setCookiesFromHTTPResponse`）/ TLS 错误映射逐段移植 `NetworkDataTaskCurl.cpp`。`file://` 受 C ABI 开关控制
- `loadResourceSynchronously`：JS 已禁无 sync XHR，直接返回错误；`startPingLoad`/`preconnectTo`：no-op；`isOnLine`：true；错误工厂用各平台 ResourceError 构造

### 5.4 加载完成状态机

信号：① `ShotProgressTrackerClient::progressFinished`（主资源+子资源字节完成）② `dispatchDidFinishLoad`（load 事件）③ **安静窗口**：进入候稳态后继续泵 RunLoop，若 200ms 内无新 `progressStarted`、无 in-flight 请求、且 `document->fonts()` 的 FontFaceSet 为 loaded，判定完成 ④ 硬超时：`FrameLoader::stopAllLoaders()` 后按配置返回错误或尽力截图。
图片解码：软光栅下快照绘制是同步解码（且 async decoding settings 已关），无需额外等待。

### 5.5 线程模型

WebCore 是进程级单主线程（`isMainThread()`）。`shot_init` 把**当前调用线程**绑定为主线程（`WTF::initializeMainThread()` → `JSC::initialize()` → `setPlatformStrategies`），此后所有 API 必须同线程调用，违者返回 `SHOT_ERR_WRONG_THREAD`。**不支持进程内并行渲染**；并行用多进程。绑定方文档要求：Node 用单一 worker_thread 串行、Python 用专属线程、Go 用 `runtime.LockOSThread` 专用 goroutine。

## 6. C ABI 草案（capi/shot.h）

```c
typedef enum {
    SHOT_OK = 0,
    SHOT_ERR_INIT_FAILED = 1,
    SHOT_ERR_WRONG_THREAD = 2,
    SHOT_ERR_INVALID_ARG = 3,
    SHOT_ERR_NAVIGATION_FAILED = 4,   /* DNS/TLS/HTTP>=400 */
    SHOT_ERR_TIMEOUT = 5,
    SHOT_ERR_RENDER_FAILED = 6,
    SHOT_ERR_FILE_ACCESS_DENIED = 7,
} shot_status;

typedef struct shot_renderer shot_renderer;  /* 不透明，非线程安全 */

typedef struct {
    const char* ca_bundle_path;   /* NULL=平台默认；Linux 建议显式 */
    const char* extra_font_dir;   /* 可选私有字体目录 */
} shot_init_options;

shot_status shot_init(const shot_init_options*);   /* 绑定当前线程为主线程，进程内仅一次 */
void        shot_shutdown(void);

typedef struct {
    int width, height;            /* 视口 CSS px，默认 1280x800 */
    double device_scale;          /* dpr，默认 1.0 */
    int full_page;                /* 1=contentsSize 全页 */
    int timeout_ms;               /* 默认 30000 */
    int best_effort_on_timeout;   /* 超时仍出图 */
    const char* user_agent;
    const char* base_url;         /* 仅 HTML 字符串模式 */
    int allow_file_urls;
    uint32_t background_rgba;     /* 0 = 透明 */
} shot_render_options;

typedef struct { uint8_t* data; size_t size; } shot_png;

shot_renderer* shot_renderer_create(void);
void           shot_renderer_destroy(shot_renderer*);
shot_status shot_render_html(shot_renderer*, const char* html_utf8, size_t len,
                             const shot_render_options*, shot_png* out);
shot_status shot_render_url (shot_renderer*, const char* url,
                             const shot_render_options*, shot_png* out);
void        shot_png_free(shot_png*);
const char* shot_last_error(shot_renderer*);
```

CLI（`shotcli`）是 ABI 的薄封装：一次性模式为 `shotcli --url <u> | --html <f> | --stdin`，参数 `--out --format --quality --mime-type --width --height --scale --full-page --timeout --ua --ca-bundle --allow-file-urls --base-url`，退出码映射 shot_status；`shotcli --serve` 提供 stdin/stdout JSONL 常驻协议，单次初始化后复用 renderer，逐请求返回 status/bytes/duration_ms。CLI 同时是三平台 CI 的验收载体。

## 7. 路线图与当前状态

**当前进度：M0 + M1 + M2 + libshot C ABI + 体积 DCE 层 + 硬化 + 无脚本网络闭包/JSC 地址空间收缩 + 传统压缩分发 + Windows 托管 CI 已完成。Linux Shot 端口已于 2026-07-17 在 Ubuntu 24.04/clang-18 非 LTO 构建并通过本地/网络/无脚本/XML-XSLT/WebP 冒烟；Linux full-LTO CI 与 macOS 端口仍在实施。**
- **M1**：本地 HTML/XHTML/XML → PNG 或 WebP（有损/无损）；CJK/emoji/渐变/MathML 正常，退出码 0。
- **M2 网络栈**：curl 直驱 LoaderStrategy 跑通 —— 外链 CSS / 外链图 / 302 子资源重定向 / cookie 写-读往返，全部 fixture 验证通过（`shotcli --url http://…`）。`ShotSession`(ephemeral 内存 cookie) + `ShotLoaderStrategy` + `ShotCurlResourceLoader`(CurlRequestClient 泵 ResourceLoader) + `ShotURLFetcher`(主资源抓取) + RunLoop 泵送完成状态机（安静窗口 + 硬超时）。
- **libshot C ABI**：`bin/shot.dll` 只导出 10 个 `shot_*` 函数；`shotcli` 改为其薄封装。CLI 全参数：`--html/--stdin/--url/--out/--format/--quality/--mime-type/--width/--height/--scale/--full-page/--timeout/--base-url/--ua/--allow-file-urls`，另有 `--serve` JSONL 常驻多请求模式。
- **体积 DCE 层**（2026-07-14）：`SHOT_NO_DLLEXPORT`（清空 WTF/bmalloc dllexport）+ `JS_NO_EXPORT`（清空 JSC C API 导出）+ `/Gy /Gw /OPT:REF /OPT:ICF` + `/O2→/O1`（MSVC 体积优化）。**导出符号 13000→10（仅 shot_*），shot.dll 67.4→46.9 MB（−30%）**，`.text` 50.7→39.3 MB。截图/网络回归全绿。
- **硬化**（2026-07-14）：**泄漏/速度** = MinSizeRel+full LTO 产物单进程连续 1000 次 480×320 PNG render，14.97 秒（66.8 张/秒，14.97 ms/张），预热后 RSS 28.2→峰值 30.3 MB、增长 2.1 MB（抖动量级）PASS，无 teardown 崩溃；**鲁棒性** = 重定向环（20 次上限，主/子资源两路都有）→干净失败、慢服务器→精确按 timeout_ms 退出、坏主机→干净失败，均无挂起/崩溃。测试载体 `tests/leak_harness.cpp` + `tests/fixture_server.py`（含 WebP、XML/XSLT、JS 禁用、/redirect-loop、/slow、/loop-page）。
- **无脚本网络闭包**（2026-07-15）：新增 `SHOT_NO_SCRIPT` 编译策略，在 `ScriptElement`、HTML 预扫描器、`LinkLoader` 和最终 `ShotLoaderStrategy` 四层拒绝 classic/module/worker/worklet/speculationrules/JSON-module 脚本资源；外部 `<script>`、module、`preload as=script`、`modulepreload`、HTTP `Link` 头组合 fixture 实测只请求主 HTML，脚本请求为 **0**。回归入口：`tests/verify_no_script_network.ps1`。
- **JSC 地址空间/内存收缩**（2026-07-15）：`JSC::initialize` 前设置 32 MiB structure heap、mini VM mode、16 MiB GC 周期并关闭并发 GC。Windows 实测 Shot/JSC 相对进程启动基线新增的 `MEM_RESERVE` 从约 4–8 GiB 降为 **32.6 MiB**；16 MiB structure heap 会在首张图触发 JSC allocator exhaustion，故 32 MiB 是通过 1000 次渲染压力测试的下限。进程启动时仍可见约 4 GiB reserve，经不链接 `shot.dll` 的空程序复核为 Windows 运行时在 `main` 前就存在的基线，不属于 JSC。最终 RSS 30.3 MiB，1000 次峰值增长 2.1 MiB。
- **WASM 物理构建闭包裁剪**（2026-07-15）：虽然 `ENABLE_C_LOOP`/`ENABLE_WEBASSEMBLY=OFF` 已禁用 WASM，上游仍把 135 个 `wasm/` 与 B3 WASM 专用源送入统一源和 LTO。Shot 端口现已在统一源生成前排除全部 135 项，仅回加 `WasmIndexOrName.cpp` 维持 `StackVisitor` 所需的最小格式化 ABI；WASM LUT 也只在功能开启时生成。构建图从 15 个 `UnifiedSource-wasm-*` + 独立对象降为 **0 个 unified WASM + 1 个最小对象**，减少约 0.88 MiB bitcode/LTO 输入。最终 `shot.dll` **净变化 0 bytes**（仍为 39,542,272），证明 full LTO 原本已把这些实现全部 DCE；残留的 WASM 字符串来自 JSC 公共 option/type/LLInt 元数据，继续删需侵入共享解释器地基，暂不为零体积收益冒险。
- **ICU 数据裁剪**（2026-07-16，4.5③ 单项最大杠杆）：icudt77.dll **30.4→7.8 MB（−74%）**。除 currency/timezone/region/lang/unit/collation/rbnf/transliteration 与 locale bundle 外，继续用 -PruneUnusedConverters 删除 147 个 ShotKit 不会打开的 converter，保留 TextCodecICU 与 CJK/ISO-2022 检测传递闭包所需 43 个。UTF-8、Shift_JIS、GBK、Big5、EUC-KR、Windows-1252、ISO-8859-2 精简前后 PNG SHA-256 全部一致；网络/WebP/外部与内嵌 XSLT/无脚本请求回归通过。工具 tools/slim-icu.ps1 会检查 icupkg/genccode/link 退出码；原始 DLL 备份不分发。
- **ANGLE 运行依赖移除**（2026-07-16）：shot.dll 对 libEGL.dll / libGLESv2.dll 改为 PE delay-load；ShotPage 始终关闭加速合成，PNG/WebP、网络、XSLT、Node 4/4 在完全删除两 DLL、隔离 PATH 后通过。collector 只在 delay-load 表中忽略这两个名字，若未来变成普通依赖会自动重新收集。未压缩运行闭包减少 3,759,104 bytes。
- **格式/网络/发布优化**（2026-07-14）：WebP 解码 + PNG/WebP 有损/WebP 无损输出；XML/XHTML/XSLT/MathML 保留；每次 render 使用独立内存 Cookie 状态。curl 从依赖层移除 HTTP/3（`nghttp3`/`ngtcp2`），保留 HTTP/2；SQLite 去 FTS/JSON/RTREE。发布构建固定 **MinSizeRel + full LTO + `/OPT:REF /OPT:ICF`**，实测 full LTO 链接峰值约 29.3 GB RSS。
- **体积裁剪第二轮 + 传统分发**（2026-07-16）：**direct shot.dll 37.7 MB（39,545,856 bytes）**；运行闭包 58.0 MiB / 24 文件，带 header/README/manifest 的解压目录 57.97 MiB / 27 文件。
  - **已做**：死重 DLL 不分发（`collect-dist.ps1` 递归 import 闭包自动排除 9 个未被 import 的 DLL，−3.2 MB）；JS 绑定 L2（`CodeGeneratorJS.pm` 切 window 构造器表，**实测仅 −0.85 MB**——见下"教训"）。
  - **关键教训（实测推翻调研预估）**：JS 绑定 8.1 MB 的真正锚**不是** window 构造器表，而是**兄弟绑定间稠密的 `toJS()` 交叉引用网**（JSDocument→JSElement→JSNode…）。切 window 表只释放真叶子（0.85 MB）；砍那 ~7 MB 必须切整个引用网 + 事件胶水（Level 3，数天、高风险，会伤基础对象模型）。规律:靠"删引用"无效,靠"**不编译**"(从 Sources.txt/IDL 移除)才有效。
  - **尚未物理摘除的高风险裁点**（运行能力已通过开关/设置禁用，留档供后续专项）：inspector 桩化；accessibility 主体；JSC Intl；StyleExtractorGenerated；IndexedDB/Push 等模块的完整 IDL+事件工厂+supplement 闭包。WebSQL 绑定已摘除；WebSocket 仅保留 core Event/EventTarget 工厂需要的 `WebSocket`/`CloseEvent` 内部闭包。IndexedDB 全摘实编译暴露 worker/structured-clone/inspector 的宽闭包，且 full LTO 下最终 DLL 没有可测收益，已回退，不再重复冒进。依赖侧已完成 curl 去 HTTP/3 与 SQLite 去 FTS/JSON/RTREE；libxml2/libxslt 因产品明确要求 XML/XSLT 不按 minimum 模式冒进。硬下限:icuin/sqlite/harfbuzz/crypto 删不掉。
  - **分发**：不采用 facade、运行时解压或 %LOCALAPPDATA% 缓存。package-release.ps1 把正常运行目录直接做 solid x86-BCJ + LZMA2(16 MiB) tar.xz；用户必须先完整解压，解压后的 shot.dll 就是 WebCore/JSC 核心。Windows x64 包 **17,299,500 bytes**（SHA-256 03825987ed9619e680ba9a39924f34f7ac1dd57c1f5042958f49796f4d4e3cf6），位于 WebKitBuild/releases/shotkit-0.1.0-windows-x64.tar.xz。空目录解压后隔离 PATH 实测新进程 176.6/79.0/87.7 ms，且不写 LOCALAPPDATA。相对严格 15,000,000 bytes 目标仍高 2,299,500 bytes；不以运行时解压、UPX 或高风险核心裁剪伪装达标。
- **Windows 托管 CI**（2026-07-16）：GitHub `windows-2022` 用 `-j2` + 单后端 ThinLTO 完成全量构建、PNG/WebP、无脚本网络闭包、10 个 C ABI 导出和发布收集，首次成功 run 总计约 1h47m（构建 1h28m）。vcpkg 二进制和 ThinLTO backend 均缓存。CI 会从锁定且校验 SHA-512 的 ICU 77.1 源数据重建精简 `icudt77.dll`，并对 ICU DLL（15 MiB）和最终包（22,000,000 bytes）设硬上限。发布物必须走 `package-release.ps1 -LtoMode thin`，上传已经 solid x86-BCJ + LZMA2 压缩的 `tar.xz` 与 SHA-256；禁止把解压目录直接交给 GitHub ZIP，因为完整 ICU + Deflate artifact 会膨胀到约 33.6 MiB，不能与本地 17.3 MB `tar.xz` 比较。
- **Linux 本地端口**（2026-07-17）：Ubuntu 24.04 + clang-18 + system curl/OpenSSL/ICU/Skia 依赖成功链接 `libshot.so`/`shotcli`。PNG/WebP 输出、远程 CSS/PNG/302/Cookie、XML+外部 XSLT、WebP 解码均通过；`/script-network` fixture 仅请求主文档 1 次，所有脚本/preload 请求为 0。当前非 LTO `libshot.so` strip 后 **54,528,248 bytes**，xz 单文件 **12,114,536 bytes**；该数值只作为端口 bring-up 基线，full LTO CI 结果另行冻结。
- **跨浏览器基准**（2026-07-14）：`demo/browser-benchmark/` 已迁移为 TypeScript ESM + `tsx`，对比 Puppeteer Chrome/Firefox、Playwright Chromium/Firefox/WebKit 与 ShotKit 的进程冷启动和常驻热请求；场景为本机 HTTP 静态 fixture、真实公网 `https://example.com/`、本地 `file://` + 外链 CSS，均为 1280×800 DPR1 full-page PNG，每次隔离页面/网络状态。每个“引擎×场景×冷/热”截图 3 次并取最快，108 个正式样本全部成功。Windows i9-14900KF 上 ShotKit 三场景冷/热最快值分别为 HTTP 186.4/91.1 ms、example.com 345.9/128.1 ms、file 158.1/66.4 ms；常驻 RSS 45.0 MB、完整分发 64.1 MB。原始样本与表格见 demo 的 `results/latest.json` / `results/latest.md`。
- **Node.js SDK**（2026-07-14）：`Source/WebKitShot/bindings/node/` 提供 `@shotkit/node@0.1.0`，用 JSONL 封装 `shotcli --serve` 常驻进程，支持 ESM + CommonJS、Promise、并发安全串行、PNG/WebP Buffer、URL/HTML/file 输入，无 node-gyp/N-API 编译且生产依赖为 0。源码测试 4/4、严格类型检查与 npm audit 全绿；带完整 Windows x64 runtime 的 tgz 为 28.9 MB（解压 67.3 MB），已在全新 npm 项目中安装并实测公网 URL/HTML 的 PNG/WebP 与 CJS。构建与 SHA-256 见 `bindings/node/RELEASE.md`；Python/Go 等语言可直接使用 `docs/language-bindings.md` 的同一 JSONL 协议或 C ABI。
- **待办（非核心，可后置）**：iframe（本版 `EmptyFrameLoaderClient` 方法全 `final`，需从零手写约 100 个方法的 `LocalFrameLoaderClient`，**列为已知限制**，见风险 R6 同级）；上面尚未物理摘除的高风险裁点；Linux/macOS 端口（M3/M4）。

| 里程碑 | 内容 | 验证标准 | 体积基线（strip 后，实测填写） |
|---|---|---|---|
| **M0** Windows 端口骨架 | ALL_PORTS 注册、OptionsShot.cmake（Win 段）、各 PlatformShot.cmake，编译到 WebCore OBJECT 汇总；**体积化编译/链接层全部打开**（MinSizeRel/LTO/gc-sections/visibility，见 4.5①） | 链接出空 main 可执行文件；`jsc` shell（CLoop）能算 `1+1` | — |
| **M1** Win 最小 HTML→PNG ✅ | ShotGlobal/ShotPage + EmptyClients 替换件 + writer 直喂 + snapshotFrameRect + encodeData；子资源仅 data:；Skia 裁到纯 CPU（4.5③） | ✅ `shotcli --html` 截出 640×400 RGBA PNG，退出码 0，CJK/emoji 正常 | 67.4 MB（未优化 Release） |
| **M2** Win 网络化 + 体积 DCE + 硬化 ✅ | Strategies/CurlResourceLoader/NetworkingContext/Session、完成状态机、超时；DCE 三件套 + /O1；ICU 数据与 converter 裁剪；无脚本网络闭包；JSC 地址空间收缩；ANGLE 仅 delay-load 且不分发 | ✅ 网络/WebP/XML/XSLT/7 编码像素/无脚本请求；仅 10 个导出；1000×render RSS 基线 27.1→峰值 29.2 MB、增长 2.1 MB；Shot/JSC reserve 增量 32.6 MiB | **shot.dll 39,545,856 bytes**；**shotcli 48,640 bytes**；direct tar.xz **17,299,500 bytes**，解压 57.97 MiB / 27 文件；无运行时解压或缓存 |
| **M3** Linux ✅ | OptionsShot Linux 段（Fontconfig/FreeType/Generic RunLoop）；Ubuntu CI 固定字体包；full LTO 构建与发布闭包 | ✅ Ubuntu 24.04 hosted CI：PNG/WebP/网络/无脚本/ABI/RPATH/发布包通过（run 29567755576） | 非 LTO strip **54,528,248 bytes**；xz **12,114,536 bytes**（临时基线；full LTO hosted 产物待下载登记） |
| **M4** macOS 🚧 | mac 段（CG/CT/CFNetwork/ResourceHandle 路径）；LoaderStrategy 的 mac 分支 | hosted macOS CI 接入中 | 待填 |
| **M5** 交付硬化 | ABI 冻结、Node/Python/Go smoke 绑定、三平台 CI、鲁棒性（大页面/循环重定向）、泄漏（重复 render 1000 次 RSS 平稳）、**CI 体积预算门槛**（4.5④） | CI 全绿，体积不超预算 | 预算冻结 |

**为什么从 Windows 起步**：开发机是 Windows；Win 官方端口本就是 curl+OpenSSL+Skia+HarfBuzz+DirectWrite 的活跃 CI 组合，OptionsShot 的 Win 段基本是 OptionsWin.cmake 的减法；WebKitRequirements 预构建包一次解决全部系统依赖。

## 8. 构建速查（Windows，M0 起步）

- 依赖：安装 [WebKitRequirements](https://github.com/WebKitForWindows/WebKitRequirements) 预构建包（提供 ICU/PNG/JPEG/curl/OpenSSL 等），设 `WEBKIT_LIBRARIES` 环境变量；工具链需 MSVC 或 clang-cl + CMake + Ninja + perl + gperf + bison（参照 Win 端口现行构建文档）。
- 预期命令形态（体积优先，clang-cl 以启用 LTO）：
  ```
  cmake -S . -B WebKitBuild/shot -G Ninja -DPORT=Shot ^
        -DCMAKE_BUILD_TYPE=MinSizeRel -DLTO_MODE=full ^
        -DCMAKE_C_COMPILER=clang-cl -DCMAKE_CXX_COMPILER=clang-cl
  ninja -C WebKitBuild/shot shotcli
  ```
  开发迭代期可先用 `Release` + 不开 LTO 换编译速度，但发布产物一律 MinSizeRel+LTO。
- 参考现有 preset 风格可在 `CMakePresets.json` 私有化（不改上游文件，用 `CMakeUserPresets.json`）。

## 9. 风险与规避（高优先级精选）

| # | 风险 | 规避 |
|---|---|---|
| R1 | curl 的 ResourceHandle 已从 trunk 删除（ResourceHandle.cpp:312 起全是桩） | 方案已内置：LoaderStrategy 直驱 CurlRequest。**不要**尝试复活 ResourceHandleCurl.cpp（牺牲 rebase 友好） |
| R2 | Win+Skia+CoordinatedGraphics（非 GPU-process）组合无官方 CI（Win 官方走 GraphicsLayerWC） | PlayStation 非-GPU 分支是近似先例；编不过时备选 `USE_GRAPHICS_LAYER_TEXTURE_MAPPER` |
| R3 | macOS 段工作量大（HAVE_* 矩阵、PlatformMac 源裁剪） | 排最后（M4）；降级 A：mac 段 include OptionsMac 可复用宏后覆盖；降级 B：首发仅 Win/Linux |
| R5 | curl CA 路径平台差异/自签证书 | ABI 暴露 `ca_bundle_path` → `CurlSSLHandle::setCACertPath`；Linux 默认探测 /etc/ssl/certs；CI 固定 ca-certificates |
| R6 | 无 JS → CSR/SPA 页面截出来是空白 | 产品定位就是"静态 HTML 渲染器"，文档明示；renderURL 可返回 DOM 元素数等诊断辅助调用方识别 |
| R7 | 懒加载/webfont 竞态导致截图缺资源 | 安静窗口状态机 + `setLazyImageLoadingEnabled(false)` + FontFaceSet 检查 + 全页先 resize 再重排 |
| R10 | OBJECT 汇总库巨大、MSVC 链接极限 | PlayStation 已验证 OBJECT 路线；libshot 用 .def/显式导出仅 C ABI 符号 |
| R11 | `ENABLE_CSS_SELECTOR_JIT` 无 CMake 开关 | `add_definitions(-DENABLE_CSS_SELECTOR_JIT=0)`；M0 用预处理检查验证生效 |
| R13 | 全量 LTO 内存/耗时巨大（WebCore 单 OBJECT 汇入是超大链接单元）；MSVC 原生工具链吃不到 `-flto` | 用 clang-cl（上游 LTO_MODE 钩子支持 clang+MSVC 组合，WebKitCompilerFlags.cmake:363）；内存不足时降级 `LTO_MODE=thin`；开发构建不开 LTO |
| R14 | ICU data filter 裁过头导致断行/BiDi/编码转换运行时错误 | 裁剪清单增量式推进（先只裁 locale/转换表，保住 brkitr/ubidi）；fixture 加多语言混排（CJK+RTL+emoji）golden 用例守护 |

## 10. 给未来会话的工作约定

1. **改动前先读本文件**；实施状态以第 7 节"当前进度"为准，完成一个里程碑就更新该行。
2. **允许改上游源码，但每一处都要登记**到下方"上游偏离清单"（文件、改了什么、为什么）。快照模式下这是"改了什么"的账本；优先仍把逻辑放进新端口/`Source/WebKitShot/`，纯粹为了可追踪、可回滚。
3. 删源码/桩化前先量化（bloaty 占比），收益 KB 级的不值当为它引入编译不稳定；本文件引用的行号仅为定位锚点，以符号名/函数名为准。
4. 新增代码风格遵循 WebKit 上游（WTF 智能指针、`_s` 字符串字面量、无异常）；`Source/WebKitShot/` 内部可用 C++ 标准库但边界处转换为 WTF 类型。
5. 测试 fixture 放 `Source/WebKitShot/tests/`，golden 图按平台分目录（Win/Linux 同 Skia 可共享，mac 独立）。
6. **体积纪律**：引入任何新依赖、打开任何 ENABLE_/USE_ 开关前，先回答"值多少 KB"；里程碑完成必须更新第 7 节体积基线列；体积跳涨 >5% 必须用 bloaty 归因后才能合入。

### 上游偏离清单（快照模式账本）

记录所有对上游源码的删改，方便回溯与调试回归。

| 文件 | 改动 | 原因 | 里程碑 |
|---|---|---|---|
| `Source/WebCore/PlatformShot.cmake` | macOS Shot 从直接源与 `SourcesCocoa.txt` 输入两路排除 `page/scrolling/cocoa`、`page/scrolling/mac` 异步滚动树 | Shot 关闭 async scrolling；基础 `ScrollingCoordinator` 已提供同步实现，Mac 异步树依赖未编译的 state/tree 类型且不参与无头截图 | M4/macOS 🚧 已改，CI 验证中 |
| `Source/WebCore/platform/PlatformWheelEvent.h` | wheel phase 的锁定、手势延续和动量辅助方法在 `ENABLE_KINETIC_SCROLLING` 下也提供 | Shot 保留 macOS 同步滚动 ABI 所需的 phase，但关闭 async scrolling；这些方法只读取 phase，Mac 的同步 EventHandler 与 delta filter 仍需要它们 | M4/macOS 🚧 已改，CI 验证中 |
| `Source/WebCore/{PlatformShot.cmake,loader/cocoa/SubresourceLoaderCocoa.mm}` | macOS Shot 排除 `DiskCacheMonitorCocoa`，并按 `ENABLE_SHAREABLE_RESOURCE` 门控子资源缓存回调中的监视器调用 | 磁盘映射监视器只为跨进程共享响应数据；Shot 是单进程且关闭 shareable resource，普通 CFNetwork 缓存策略与子资源加载继续保留 | M4/macOS 🚧 已改，CI 验证中 |
| `Source/cmake/OptionsShot.cmake` | macOS Shot 显式关闭 Apple Pay 及 Cocoa 默认开启的 AMS UI 支付处理器 | Shot 不提供支付交互；对应实现已从精简源闭包排除，继续编译 `Page` 的支付 session 分支会引用不完整的 handler 类型 | M4/macOS 🚧 已改，CI 验证中 |
| `Source/WebCore/PlatformShot.cmake` | macOS Shot 从直接源与 `SourcesCocoa.txt` 输入两路排除 `GPUCanvasContextCocoa.mm` | Shot 同时关闭 WebGPU 和 OffscreenCanvas；该实现只服务 GPU canvas，不影响 CoreGraphics 2D Canvas | M4/macOS 🚧 已改，CI 验证中 |
| `Source/WebCore/editing/cocoa/WebContentReaderCocoa.mm` | attachment-off 分支的 `UNUSED_PARAM(blob)` 改为函数实际未使用的 4 个参数 | 原分支引用不存在的局部变量，只在 `ENABLE_ATTACHMENT_ELEMENT=OFF` 时暴露 | M4/macOS 🚧 已改，CI 验证中 |
| `Source/WebCore/PlatformShot.cmake` | macOS Shot 从直接源与 `SourcesCocoa.txt` 输入两路排除 `DataTransferMac.mm` | Shot 关闭拖拽；该 Mac 实现只定义 drag image 方法，而方法与成员在 `ENABLE_DRAG_SUPPORT=OFF` 时不存在 | M4/macOS 🚧 已改，CI 验证中 |
| `Source/WebCore/editing/cocoa/EditingHTMLConverter.mm` | HTML attachment 头文件、辅助函数与转换分支增加 `ENABLE_ATTACHMENT_ELEMENT` 门控 | Shot 不启用 WebKit attachment element，但仍保留普通 HTML/图片的 Cocoa attributed-string 转换 | M4/macOS 🚧 已改，CI 验证中 |
| `Source/cmake/OptionsShot.cmake` | macOS Shot 显式关闭 Cocoa 根据 VisionKit 自动开启的 image analysis 及派生能力 | Shot 不提供 OCR/Live Text/机器可读码分析；该分支还会在视频关闭后引用不完整的 `HTMLMediaElement` | M4/macOS 🚧 已改，CI 验证中 |
| `Source/cmake/OptionsShot.cmake` | macOS Shot 对齐 Mac 默认开启 accessibility isolated tree，并关闭脱离 `MODEL_ELEMENT` 被 Cocoa 头强开的 model accessibility | `PlatformMac.cmake` 的 AX wrapper 需要 isolated-tree API；Shot 不启用 model element，不应编译其 AX 分支 | M4/macOS 🚧 已改，CI 验证中 |
| `Source/WebCore/bindings/js/BindingsJSTZoneImpls.cpp` | WebAssembly provider 的头文件和 TZone allocator 实现增加 `ENABLE_WEBASSEMBLY` 门控 | 对应类型只在 WebAssembly 开启时声明；Shot 关闭 WASM，原无条件实例化会引用不存在的类型 | M4/macOS 🚧 已改，CI 验证中 |
| `Source/WebCore/PlatformShot.cmake` | macOS Shot 从直接源与 `SourcesCocoa.txt` 输入两路排除 `WebCoreNSURLSession`、`RangeResponseGenerator` | 两者只服务 `PlatformMediaResource`；Shot 关闭视频后类型不存在，静态文档网络继续使用 `ResourceHandleCocoa` | M4/macOS 🚧 已改，CI 验证中 |
| `Source/WebCore/PlatformShot.cmake` | macOS Shot 排除两个 ScreenCaptureKit 采集实现 | Shot 关闭媒体流；这两个实现未用 `ENABLE_MEDIA_STREAM` 包住，却依赖只在媒体流开启时存在的采集类型 | M4/macOS 🚧 已改，CI 验证中 |
| `Source/{cmake/OptionsShot.cmake,WTF/wtf/PlatformHave.h,WebCore/platform/mac/PlatformScreenMac.mm}` | Shot 显式关闭 `HAVE_AVPLAYER_VIDEORANGEOVERRIDE`，平台默认值允许端口覆盖，并按该能力门控 AVFoundation 头 | Shot 不提供视频或 HDR 播放策略；无条件包含 AVFoundation SPI 会在精简 PAL 闭包中引用不存在的 `AVOutputContext` | M4/macOS 🚧 已改，CI 验证中 |
| `Source/WebCore/platform/mac/ScrollingEffectsController.mm` | 直接用 wheel phase 判断动量事件与动量滚动结束 | Shot 关闭异步滚动，而原便捷方法只在 `ENABLE_ASYNC_SCROLLING` 下声明；直接判断与便捷方法语义一致 | M4/macOS 🚧 已改，CI 验证中 |
| `Source/WebCore/platform/mediacapabilities/PlatformMediaEngineConfigurationFactory.cpp` | `PLATFORM(SHOT)` 不注册 Cocoa 媒体解码能力工厂 | Shot 不提供音视频，Cocoa 实现依赖已裁掉的 `MediaPlayer` 类型；保留空工厂集合可让任何残余查询按「不支持」返回 | M4/macOS 🚧 已改，CI 验证中 |
| `Source/WebCore/platform/graphics/ca/GraphicsLayerCA.cpp` | 视频关闭时把 `setContentsToVideoElement` 保留为空 ABI 实现，并门控 `HTMLVideoElement.h` | CoreAnimation 图层类型仍需满足 `GraphicsLayer` 虚接口，但 `HTMLVideoElement` 的完整定义只在 `ENABLE_VIDEO` 下存在 | M4/macOS 🚧 已改，CI 验证中 |
| `Source/WTF/wtf/PlatformHave.h` | Cocoa 的 `HAVE_AVASSETREADER` 默认值改为仅在端口未显式定义时启用 | Shot 关闭视频并排除 AVFoundation 解码链，只保留 CoreGraphics/ImageIO；原无条件宏使端口无法关闭该能力并继续引用已裁实现 | M4/macOS 🚧 已改，CI 验证中 |
| `Source/WebCore/platform/audio/PlatformMediaSessionManager.cpp` | `PLATFORM(SHOT)` 在 Cocoa 上也启用通用空 media-session manager 工厂 | Shot 关闭视频/WebAudio/媒体流并排除 Cocoa CoreAudio manager，但 Page 配置仍需要进程内 manager 对象 | M4/macOS 🚧 已改，CI 验证中 |
| `Source/WebCore/platform/mac/ScrollAnimatorMac.mm` | 直接用 wheel phase 判断动量滚动结束，不调用仅随完整异步滚动声明的便捷方法 | Shot 只保留 Mac animator ABI 所需的 kinetic phase 类型，仍关闭异步滚动；直接判断与该便捷方法语义一致 | M4/macOS 🚧 已改，CI 验证中 |
| `Source/WebCore/platform/MediaStrategy.cpp` | `AudioVideoRendererAVFObjC.h` 的 include 增加 `ENABLE_VIDEO` 门控 | 创建 AVFoundation renderer 的函数本就只在视频开启时存在；仅按 `USE_AVFOUNDATION` 包含头会在 Shot 关闭视频后引用被裁媒体类型 | M4/macOS 🚧 已改，CI 验证中 |
| `Source/JavaScriptCore/API/JSRemoteInspector.cpp` | `ENABLE_REMOTE_INSPECTOR=OFF` 时默认检查状态查询直接返回 false | Cocoa 源清单始终编译兼容 C API，但原实现无条件引用仅在远程检查器开启时声明的 `RemoteInspector` | M4/macOS 🚧 已改，CI 验证中 |
| `Source/WTF/wtf/PlatformEnableCocoa.h` | 给 `ENABLE_VIDEO_PRESENTATION_MODE` 的平台析取补括号 | 原条件受 `&&`/`||` 优先级影响，在 macOS 上即使 cmakeconfig 已定义为 0 仍强制重定义为 1；Shot 已关闭视频 | M4/macOS 🚧 已改，CI 验证中 |
| `Source/cmake/WebKitMacros.cmake` | framework 链接宏比较 `LINKED_INTO` 时给可能为空的展开值加引号 | Cocoa OBJECT WebCore 没有 `LINKED_INTO` 属性，未加引号会生成语法不完整的 `if(... STREQUAL )` 并阻断配置；不改变非空值语义 | M4/macOS 🚧 已改，CI 验证中 |
| `Source/cmake/WebKitXcodeSDK.cmake` | Apple host 上把 `PORT=Shot` 加入 macOS SDK 自动解析分支 | SDK 解析早于 `OptionsShot.cmake`，未登记时 CMake 会在读取端口选项前直接拒绝 Shot | M4/macOS 🚧 已改，CI 验证中 |
| `Source/WebCore/loader/EmptyClients.{h,cpp}` | 仅在 `PLATFORM(SHOT) && PLATFORM(COCOA)` 下给空 Frame 网络上下文注入私有 `NetworkStorageSession` 并使上下文有效 | Cocoa `ResourceHandle` 会拒绝无 frame/无 session 的默认空上下文；Shot 单进程子资源需复用同一个内存 CFNetwork session | M4/macOS 🚧 已改，CI 验证中 |
| `Source/cmake/WebKitCommon.cmake` | `ALL_PORTS` 加 `Shot` | 端口注册 | M0 ✅ 已改 |
| `Source/WebCore/CMakeLists.txt` | GL 库块的 `else()` 改为 `elseif (USE_TEXTURE_MAPPER OR USE_EGL)` | 纯软件光栅端口无 GPU 后端，原逻辑无条件要求不存在的 `OpenGL::GLES` 目标 | M0 ✅ 已改 |
| `Source/WebCore/bindings/scripts/CodeGenerator.pm` | `IDLFileForInterface` 的 `chomp` 改为 `s/[\r\n]+$//`（CRLF 容错） | Windows 上生成的 IDL 列表 .tmp 是 CRLF，Git 自带 perl 的 chomp 只去 `\n`，残留 `\r` 使接口名映射键损坏，报 "Could NOT find IDL file for interface"。此为通用健壮性修复 | M0 ✅ 已改 |
| （新增）`Source/{WTF/wtf,JavaScriptCore,WebCore/PAL/pal,ThirdParty/ANGLE}/PlatformShot.cmake` | `include(PlatformWin.cmake)` | Shot 是 Windows 二进制，复用 Win 各模块平台层（ANGLE 需其 PlatformWin 提供 `ANGLE_ENABLE_D3D11` 定义等） | M0 ✅ 新增 |
| （新增）`Source/WebCore/PlatformShot.cmake` | PlatformWin 裁剪版（去 TextureMapper/ANGLE/EGL，保留 Skia/Curl/Win 平台源） | 纯软件光栅，无 GPU 合成 | M0 ✅ 新增 |
| `Source/ThirdParty/skia/CMakeLists.txt` | EGL 原生接口工厂源改为仅在 `USE_ANGLE_EGL OR EGL_LIBRARIES` 时编译 | 健壮性：无 EGL 时不编译 EGL glue（当前启用 ANGLE 故走 ANGLE 分支） | M0 ✅ 已改 |
| `Source/cmake/WebKitCommon.cmake` | 顶部加"身份变量戳"守卫（`WEBKIT_IDENTITY_VARS` = BUILD_TYPE/PORT/… 写入 `.webkit-config-stamp`，重配时若这些变量从缓存消失/改变就 FATAL_ERROR） | **防御 cache-wipe 陷阱**：编辑 `OptionsShot.cmake` 触发 ninja 自动重配时，CMake 因编译器缓存项是短名 `clang-cl` 判定"编译器变了"→**擦掉整个 CMake 缓存**（PORT/vcpkg 前缀/Ruby/全部编译链接 flag 尽失），静默继续会编出错误的无断言/无 flag 产物。此守卫让其显式失败，提示用 `build-shot.ps1 -Reconfigure` 补齐全部 `-D` 重建 | M1 ✅ 已改 |
| `Source/WTF/wtf/ExportMacros.h` | 在 `WTF_EXPORT_DECLARATION` 定义前加 `#if defined(SHOT_NO_DLLEXPORT)` 分支，把 `WTF_EXPORT_DECLARATION`/`WTF_IMPORT_DECLARATION` 清空 | **体积头号杠杆（DCE 使能）**：所有 `WEBCORE_EXPORT`/`JS_EXPORT_PRIVATE`/`PAL_EXPORT` 都经 `WTF_EXPORT_DECLARATION` 展开为 `__declspec(dllexport)`。OBJECT 库层间无 DLL 边界却带 dllexport，会把上万内部符号钉进 libshot 导出表，链接器 `/OPT:REF` 无法当死代码删除。清空后仅 libshot 的 `shot_*`（SHOT_API）导出。改前 shot.dll=67.4MB | M2/体积 ✅ 已改 |
| `Source/bmalloc/bmalloc/BExport.h` | 同上，加 `#if defined(SHOT_NO_DLLEXPORT)` 分支清空 `BEXPORT_DECLARATION`/`BIMPORT_DECLARATION` | bmalloc 也是 OBJECT 静态汇入，同款 dllexport 泄漏 | M2/体积 ✅ 已改 |
| `Source/WebCore/bindings/scripts/CodeGeneratorJS.pm` | `$isConstructor` 分支:全局对象(window/worker)的构造器属性 getter 改为 `UNUSED_PARAM+return jsUndefined()` 且不 `AddToImplIncludes("JSX.h")`（原为 `return JSX::getConstructor(...)`） | 体积:切断 window 构造器静态表→全部 wrapper 的引用边。JS 永不执行,window.HTMLDivElement 变 undefined 无副作用。**实测只省 0.85MB**(wrapper 主要被兄弟绑定 toJS 交叉引用锚定,非 window 表;full 8MB 需 Level 3 数周) | 体积/推荐档 ✅ 已改 |
| `Source/WebCore/bindings/scripts/preprocess-idls.pl` | 快速预处理路径改为实际调用 `applyPreprocessor` | 让 Shot 条件能可靠过滤 WebSQL IDL，而不是只扫描未预处理文本 | 体积/静态绑定 ✅ 已改 |
| `Source/WebCore/{PlatformShot.cmake,ShotPruning.cmake,bindings/js/JSDOMWindowCustom.cpp,page/DOMWindow.idl}` | Shot 端口移除 WebSQL IDL/生成绑定并守卫对应 Window 自定义入口 | JS 永不执行；先用最低耦合模块打通可逆的 IDL+绑定裁剪流程 | 体积/静态绑定 ✅ 已改 |
| `Source/cmake/OptionsShot.cmake` | 加 `add_definitions(-DSHOT_NO_DLLEXPORT=1 -DJS_NO_EXPORT=1)` + C/C++ 专用 section 编译选项（MSVC `/Gy /Gw`，Clang `-ffunction-sections -fdata-sections`）+ 对应链接器 DCE 选项 | 全局点亮 SHOT_NO_DLLEXPORT 分支（清空 WTF/bmalloc dllexport）；`JS_NO_EXPORT` 用上游 JSBase.h:82 钩子清空 JSC C API 的 `JS_EXPORT`（去 165 个 JS* 导出锚点）；函数/数据分段与链接期回收组成 DCE 三件套；用 `COMPILE_LANGUAGE` 避免把 Clang 参数误传给 Swift | M2/体积 ✅ 已改 |
| `Source/cmake/OptionsShot.cmake` | Shot 端口固定关闭 `ENABLE_SWIFT_DEMO_URI_SCHEME` 与 `ENABLE_BACK_FORWARD_LIST_SWIFT` | hosted Ubuntu 自带 Swift 时上游自动探测会打开原型特性并把 PAL Cocoa/CryptoKit Swift 源加入 Linux 构建；Shot 不需要这些 JS/UI 原型，关闭后同时消除 Swift/CryptoKit 依赖和无用体积 | M3/Linux CI ✅ 已改 |
| `Source/cmake/OptionsShot.cmake` + `Source/WebCore/{dom/ScriptElement.cpp,html/parser/HTMLPreloadScanner.cpp,loader/LinkLoader.cpp}` | 定义 `SHOT_NO_SCRIPT`；在脚本准备、HTML speculative preload、link/preload 三个入口编译期拒绝脚本 | 页面脚本既不执行也不下载，避免无用 DNS/TLS/下载/缓存/解析和对应峰值内存 | M2/无脚本网络 ✅ 已改 |
| `Source/JavaScriptCore/{PlatformShot.cmake,CMakeLists.txt}` | Shot 构建排除 135 个 WASM/B3-WASM 实现源；只回加 `WasmIndexOrName.cpp` 最小 ABI；WASM LUT 生成受 `ENABLE_WEBASSEMBLY` 门控 | 功能已禁用时不再生成 15 个统一源或把无用 WASM 实现送进 LTO；实测 DLL 0 bytes 变化，收益为构建闭包与 LTO 输入收缩 | M2/WASM 物理裁剪 ✅ 已改 |
| `Source/WebCore/{ShotPruning.cmake,Sources.txt}` | WebSQL 与非必要 WebSocket IDL/生成绑定不参与 Shot 构建；保留 WebSocket/CloseEvent 内部 ABI 闭包 | 物理减少纯 JS-facing 生成输入；保证干净/增量构建一致 | M2/静态绑定 ✅ 已改 |
| （新增）`Source/WebKitShot/ShotKit/{ShotLoaderStrategy.cpp,ShotGlobal.cpp}` | LoaderStrategy 最终接缝拒绝所有 script-like destination；JSC 初始化前设置 32 MiB structure heap、mini VM、16 MiB GC 周期、同步 GC | 防止遗漏入口发出脚本请求；把 JSC 默认多 GiB 虚拟地址预留压到 32.6 MiB 实测增量并减少并发 GC 线程/提交 | M2/内存 ✅ 已改 |
| `Source/WTF/wtf/PlatformUse.h`、`Source/WebCore/{page/Page.cpp,accessibility/AXCoreObject.h,page/ChromeClient.h,loader/EmptyClients.h,platform/PlatformKeyboardEvent.cpp}` | 增加 `PLATFORM(SHOT)` 分支；Shot 禁用 Adwaita 异步滚动条和仅 GTK/WPE 存在的硬件加速设置；仅 Linux Shot 复用通用 modifier 状态 | Linux Shot 是无 UI、同步滚动、软件光栅端口；避免引入 GTK/WPE 或异步滚动树；Windows/macOS 保留各自键盘实现，避免重复符号 | M3/Linux ✅ 已改 |
| `Source/WebCore/crypto/openssl/CryptoKeyRSAOpenSSL.cpp` | `EVP_PKEY_get0_RSA` 返回值与辅助函数改为 `const RSA*` | 兼容 OpenSSL 3 的 const-correct API | M3/Linux ✅ 已改 |
| `Source/WebCore/platform/graphics/{skia/SkiaBackingStore.cpp,texmap/coordinated/CoordinatedPlatformLayerBuffer*.cpp}` | 显式包含 GLES3 头；P010 的 `GL_R16/GL_RG16` 使用规范枚举值 | Linux GLES 头不再靠 UI 端口的传递 include；兼容 GLES3 中未声明的桌面 GL 名称 | M3/Linux ✅ 已改 |
| `Source/cmake/OptionsMSVC.cmake` | Shot 端口不用全局 `/DEBUG /OPT:NOICF`，改为 `/OPT:REF /OPT:ICF`；MinSizeRel 不再为所有编译单元添加未分发的 `/Zi` | 上游默认标志在命令行后部覆盖 Shot 的 ICF；无用调试信息还会放大 CI 磁盘占用和 LTO 输入 | 发布体积/CI ✅ 已改 |
| （新增）`Source/WebKitShot/ShotKit/ShotPage.cpp` | 主 frame 从 `SandboxFlags::all()` 改为空；截图前显式收敛待处理 XSLT 变换 | 保持 JS 设置层禁用，同时恢复同源外部 XSLT；避免短安静窗口早于替换文档 | XML/XSLT ✅ 已改 |

> **图形栈决策修正（M0）**：最初尝试彻底切掉 GPU/GL（USE_TEXTURE_MAPPER OFF、无 ANGLE），但 WinCairo 的 WebCore 把 `PlatformDisplay→GLDisplay→EGL` 硬编码进图形栈（`PlatformDisplay.h` 无条件 `#include "GLDisplay.h"`），彻底解耦是大手术且级联报错。为"先能截图",改为**沿用 WinCairo 图形栈**：`USE_ANGLE_EGL/USE_TEXTURE_MAPPER ON`,ANGLE 在 `Source/ThirdParty/ANGLE` 内建仅作 EGL 显示抽象;运行期 ShotPage 关闭加速合成、ImageBuffer 走 Skia CPU 后端,GPU 从不实际使用。**移除 ANGLE/TextureMapper 以减体积 = 二期专项**(4.6)。`OptionsShot.cmake` / `WebCore/PlatformShot.cmake` 已相应改回复用 PlatformWin。
| `accessibility/` 主体 | PlatformShot 排除 + `accessibility/shot/` 桩替换 | 4.6-C 桩化无障碍子系统 | 二期（待登记） |

> 上一行是**计划中**的偏离；其余条目均已落地。IndexedDB 全摘已实测回退，原因见第 7 节。

### 实施进度（M0/M1，2026-07-13 起）

**已完成**：
- 工具链：ninja / LLVM(clang-cl) 22 / Ruby 3.3 / gperf / win_bison+win_flex（`WebKitBuild/toolshims` 提供 `bison.exe`/`flex.exe` 兼容名）。
- 依赖：vcpkg（`WebKitLibraries/windows/vcpkg`）用 **`x64-windows-webkit` overlay triplet**（关键：它设 `ZLIB_COMPAT ON`，否则 curl 找不到 zlib）构建了 web/skia/woff2 全部 37 个库到 `WebKitBuild/vcpkg_installed`。
- 端口：`OptionsShot.cmake` + `Source/PlatformShot.cmake`（挂 WebKitShot）+ `ALL_PORTS` 注册。**cmake 配置已通过**（`WebKitBuild/shot`）。
- 嵌入库：`Source/WebKitShot/`（ShotGlobal / ShotPage / ShotPlatformStrategies / cli），单 `shotcli` 目标静态链接 WebCore OBJECT。
- 构建脚本：`Source/WebKitShot/build-shot.ps1`（`-Configure`/`-Build`/`-Clean`）。

**构建命令**（须在 VS x64 环境 + 上述工具链 PATH 下；clang-cl 需要 VS 的 Windows SDK/CRT）：
```
cmd /c '"…\VC\Auxiliary\Build\vcvarsall.bat" x64 && ninja -C WebKitBuild\shot shotcli'
```
配置命令见 `build-shot.ps1`（关键参数：`-DPORT=Shot`、vcpkg 工具链、`VCPKG_TARGET_TRIPLET=x64-windows-webkit`、overlay-triplets）。

**M1 完成（能截图）**：`shotcli --html test.html --out out.png --width 640 --height 400` → 640×400 RGBA PNG，退出码 0。渐变卡片/圆角/绿点/CJK/emoji 全部正确渲染。

**M1 打通过程中踩到并已解决的关键坑（未来会话必读）**：
1. **主题符号缺失**：`RenderTheme/Theme/ScrollbarTheme::singleton` 的定义整体包在 `#if USE(THEME_ADWAITA)` 内。Win 端口用 Adwaita 主题，故 `OptionsShot.cmake` 必须 `SET_AND_EXPOSE_TO_BUILD(USE_THEME_ADWAITA ON)`，否则链接期缺三个 singleton。
2. **dwrite 系统库**：`FontCacheSkiaWin` 用 `DWriteCreateFactory`。WebCore 是 OBJECT 库，其 PRIVATE 系统库依赖**不传递**给消费者，须在 `Source/WebKitShot/CMakeLists.txt` 的 `shotcli_LIBRARIES` 显式加 `dwrite`。
3. **RunLoop 双初始化崩溃**：`WTF::initializeMainThread()` 内部已调 `RunLoop::initializeMain()`；`ShotGlobal::initialize` 不可再调，否则 `RELEASE_ASSERT(!s_mainRunLoop)` 崩。
4. **LoaderStrategy 不能为 nullptr**：`Page::firstTimeInitialization()` 会解引用 `platformStrategies()->loaderStrategy()`（调 `addOnlineStateChangeListener`）。已在 `ShotPlatformStrategies.cpp` 提供最小 `ShotLoaderStrategy` 桩（29 个纯虚全实现；带 `CompletionHandler` 的方法必须回调否则析构断言）。M2 用 curl 直驱替换。
5. **进程退出 teardown 崩溃**：正常退出时 `ThreadGlobalData::~ThreadGlobalData`→`FontCache`→`Font::~Font` 再度访问 `threadGlobalData()`→重建→`MainThreadSharedTimer` 断言崩。WebCore 线程级单例被设计为**进程退出时泄漏**，不支持干净静态析构。`cli/main.cpp` 在写完 PNG（已 flush 落盘）后 `std::_Exit(0)` 硬退出，跳过一切静态析构/atexit。**M2 起 C ABI/libshot 场景（同进程多次 render、不能硬退出）需另找干净收尾方案**（如每次 render 后不销毁线程全局、复用 Page，或显式 leak）。

**构建/重配（务必用脚本 `Source/WebKitShot/build-shot.ps1`，避免 cache-wipe 后手工补参数）**：
- 增量编译（只改了 `Source/WebKitShot/` 源）：`build-shot.ps1 -Build`。
- 改了任何 `*.cmake` 或 ninja 自动重配擦了缓存后：`build-shot.ps1 -Configure -Build`（内含全部 `-D`：PORT、MinSizeRel+full LTO、vcpkg 工具链+triplet+overlay、`CMAKE_PREFIX_PATH` 指向 vcpkg installed、以及 `CMAKE_C/CXX_FLAGS_MINSIZEREL=/MD /O1 /DNDEBUG`；**缺 `/DNDEBUG` 会开断言，触发 C_LOOP 下 `JSDOMGlobalObject` 编译中断**）。脚本自动 vcvarsall + 把 LLVM+Ruby 塞进 PATH。
- 运行需把 `WebKitBuild/vcpkg_installed/x64-windows-webkit/bin`（ICU/Skia/curl 等 DLL）加进 PATH。

**已补齐**：发布构建已启用 MinSizeRel/full LTO/REF+ICF；远程 URL、外链资源、Cookie、超时状态机、WebP、XML/XSLT/MathML 回归均通过。当前基线见第 7 节 M2 行。
