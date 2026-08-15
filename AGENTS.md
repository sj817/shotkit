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
- 但**仍优先把逻辑集中在新端口 + `shot/`**——不是为了 rebase，而是为了改动可追踪、可回滚、心智负担低。对上游源文件的每一处删改，登记到本文件末尾的"上游偏离清单"（现在它是"改了什么"的账本，不再是"待还的债"）。
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
Source/PlatformShot.cmake                   # 被 Source/CMakeLists.txt 自动 include，挂 shot/ 子目录
Source/bmalloc/PlatformShot.cmake           # 各层平台文件，仿对应 PlatformPlayStation.cmake / PlatformWin.cmake
Source/WTF/wtf/PlatformShot.cmake
Source/JavaScriptCore/PlatformShot.cmake
Source/WebCore/PAL/pal/PlatformShot.cmake
Source/WebCore/PlatformShot.cmake
shot/
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

**E. 终极杠杆——JS 绑定层（约 1800 对生成的 `JS*.cpp`）** —— ✅ **已于 2026-07-24 用"生成器退化"路线落地**（见第 7 节进度"JS 绑定退化 Level 3"）：不删引用、不裁 IDL，而是让 `CodeGeneratorJS.pm` 按清单把接口生成为保留 toJS ABI 的空壳，1612 个无 Custom 接口实测 −4.29 MB。剩余可挖：94 个带 Custom 文件的接口（DOMWindow/Document/Element 等，8.0 MB 生成源码）为二期。

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

**当前进度：M0 + M1 + M2 + M3 + M4 已完成。Windows x64、Linux x64 与 macOS arm64 在同一 HEAD `5beb4b8830f3` 上通过 hosted CI：PNG/WebP、无脚本网络、C ABI、可重定位 CLI 与发布归档全部成功；macOS 另通过内部链接完整性、CFNetwork 与 XML/XSLT 回归。**
- **M1**：本地 HTML/XHTML/XML → PNG 或 WebP（有损/无损）；CJK/emoji/渐变/MathML 正常，退出码 0。
- **M2 网络栈**：curl 直驱 LoaderStrategy 跑通 —— 外链 CSS / 外链图 / 302 子资源重定向 / cookie 写-读往返，全部 fixture 验证通过（`shotcli --url http://…`）。`ShotSession`(ephemeral 内存 cookie) + `ShotLoaderStrategy` + `ShotCurlResourceLoader`(CurlRequestClient 泵 ResourceLoader) + `ShotURLFetcher`(主资源抓取) + RunLoop 泵送完成状态机（安静窗口 + 硬超时）。
- **libshot C ABI**：`bin/shot.dll` 只导出 10 个 `shot_*` 函数；`shotcli` 改为其薄封装。CLI 全参数：`--html/--stdin/--url/--out/--format/--quality/--mime-type/--width/--height/--scale/--full-page/--timeout/--base-url/--ua/--allow-file-urls`，另有 `--serve` JSONL 常驻多请求模式。
- **体积 DCE 层**（2026-07-14）：`SHOT_NO_DLLEXPORT`（清空 WTF/bmalloc dllexport）+ `JS_NO_EXPORT`（清空 JSC C API 导出）+ `/Gy /Gw /OPT:REF /OPT:ICF` + `/O2→/O1`（MSVC 体积优化）。**导出符号 13000→10（仅 shot_*），shot.dll 67.4→46.9 MB（−30%）**，`.text` 50.7→39.3 MB。截图/网络回归全绿。
- **硬化**（2026-07-14）：**泄漏/速度** = MinSizeRel+full LTO 产物单进程连续 1000 次 480×320 PNG render，14.97 秒（66.8 张/秒，14.97 ms/张），预热后 RSS 28.2→峰值 30.3 MB、增长 2.1 MB（抖动量级）PASS，无 teardown 崩溃；**鲁棒性** = 重定向环（20 次上限，主/子资源两路都有）→干净失败、慢服务器→精确按 timeout_ms 退出、坏主机→干净失败，均无挂起/崩溃。测试载体 `tests/leak_harness.cpp` + `tests/fixture_server.py`（含 WebP、XML/XSLT、JS 禁用、/redirect-loop、/slow、/loop-page）。
- **无脚本网络闭包**（2026-07-15）：新增 `SHOT_NO_SCRIPT` 编译策略，在 `ScriptElement`、HTML 预扫描器、`LinkLoader` 和最终 `ShotLoaderStrategy` 四层拒绝 classic/module/worker/worklet/speculationrules/JSON-module 脚本资源；外部 `<script>`、module、`preload as=script`、`modulepreload`、HTTP `Link` 头组合 fixture 实测只请求主 HTML，脚本请求为 **0**。回归入口：`tests/verify_no_script_network.ps1`。
- **JSC 地址空间/内存收缩**（2026-07-15）：`JSC::initialize` 前设置 32 MiB structure heap、mini VM mode、16 MiB GC 周期并关闭并发 GC。Windows 实测 Shot/JSC 相对进程启动基线新增的 `MEM_RESERVE` 从约 4–8 GiB 降为 **32.6 MiB**；16 MiB structure heap 会在首张图触发 JSC allocator exhaustion，故 32 MiB 是通过 1000 次渲染压力测试的下限。进程启动时仍可见约 4 GiB reserve，经不链接 `shot.dll` 的空程序复核为 Windows 运行时在 `main` 前就存在的基线，不属于 JSC。最终 RSS 30.3 MiB，1000 次峰值增长 2.1 MiB。
- **WASM 物理构建闭包裁剪**（2026-07-15）：虽然 `ENABLE_C_LOOP`/`ENABLE_WEBASSEMBLY=OFF` 已禁用 WASM，上游仍把 135 个 `wasm/` 与 B3 WASM 专用源送入统一源和 LTO。Shot 端口现已在统一源生成前排除全部 135 项，仅回加 `WasmIndexOrName.cpp` 维持 `StackVisitor` 所需的最小格式化 ABI；WASM LUT 也只在功能开启时生成。构建图从 15 个 `UnifiedSource-wasm-*` + 独立对象降为 **0 个 unified WASM + 1 个最小对象**，减少约 0.88 MiB bitcode/LTO 输入。最终 `shot.dll` **净变化 0 bytes**（仍为 39,542,272），证明 full LTO 原本已把这些实现全部 DCE；残留的 WASM 字符串来自 JSC 公共 option/type/LLInt 元数据，继续删需侵入共享解释器地基，暂不为零体积收益冒险。
- **ICU 数据裁剪**（2026-07-16，4.5③ 单项最大杠杆）：icudt77.dll **30.4→7.8 MB（−74%）**。除 currency/timezone/region/lang/unit/collation/rbnf/transliteration 与 locale bundle 外，继续用 -PruneUnusedConverters 删除 147 个 ShotKit 不会打开的 converter，保留 TextCodecICU 与 CJK/ISO-2022 检测传递闭包所需 43 个。UTF-8、Shift_JIS、GBK、Big5、EUC-KR、Windows-1252、ISO-8859-2 精简前后 PNG SHA-256 全部一致；网络/WebP/外部与内嵌 XSLT/无脚本请求回归通过。工具 tools/slim-icu.ps1 会检查 icupkg/genccode/link 退出码；原始 DLL 备份不分发。**追加裁剪（2026-08-01）**：在上述基础上再删四类 —— `brkitr/cjdict.dict`（2.0 MB 中日分词词典，CJK 行断是规则式的、词典只服务双击选词等截图不可达接口；它被 `brkitr/root.res` 声明为依赖不能直接删，改用 gendict 生成 70 字节近空词典原地替换）、`unames.icu`（337 KB 字符名表）、`zoneinfo64/metaZones/timezoneTypes/windowsZones`（约 200 KB 时区数据，只服务 ucal/Intl）、`euc-tw-2014.cnv` + 13 个 `icu-internal-compound-*.cnv`（EUC-TW / ISO-2022-CN 不在 WHATWG Encoding Standard 内）。converter 白名单 45→31、删除 159 个 .cnv，共移除 4099/4203 items，**icudt77.dll 8,181,248 → 4,231,680 bytes（−3.77 MB，累计 30.4 MB → 4.03 MB / −87%）**。验证：多语言（中/日/泰/阿拉伯 RTL/emoji）+ GBK/Shift_JIS 编码页像素完全一致（**2026-08-02 统一验证**：i18n 压力页在“旧二进制 + 原始 31.9 MB icudt”与“新二进制 + 精简 4.2 MB icudt”下 PNG SHA-256 逐字节相同）。CI 的 ICU DLL 硬上限同步收紧到 5,000,000 bytes。
- **ANGLE 运行依赖移除**（2026-07-16）：shot.dll 对 libEGL.dll / libGLESv2.dll 改为 PE delay-load；ShotPage 始终关闭加速合成，PNG/WebP、网络、XSLT、Node 4/4 在完全删除两 DLL、隔离 PATH 后通过。collector 只在 delay-load 表中忽略这两个名字，若未来变成普通依赖会自动重新收集。未压缩运行闭包减少 3,759,104 bytes。
- **格式/网络/发布优化**（2026-07-14）：WebP 解码 + PNG/WebP 有损/WebP 无损输出；XML/XHTML/XSLT/MathML 保留；每次 render 使用独立内存 Cookie 状态。curl 从依赖层移除 HTTP/3（`nghttp3`/`ngtcp2`），保留 HTTP/2；SQLite 去 FTS/JSON/RTREE。发布构建固定 **MinSizeRel + full LTO + `/OPT:REF /OPT:ICF`**，实测 full LTO 链接峰值约 29.3 GB RSS。
- **体积裁剪第二轮 + 传统分发**（2026-07-16）：**direct shot.dll 37.7 MB（39,545,856 bytes）**；运行闭包 58.0 MiB / 24 文件，带 header/README/manifest 的解压目录 57.97 MiB / 27 文件。
  - **已做**：死重 DLL 不分发（`collect-dist.ps1` 递归 import 闭包自动排除 9 个未被 import 的 DLL，−3.2 MB）；JS 绑定 L2（`CodeGeneratorJS.pm` 切 window 构造器表，**实测仅 −0.85 MB**——见下"教训"）。
  - **关键教训（实测推翻调研预估）**：JS 绑定 8.1 MB 的真正锚**不是** window 构造器表，而是**兄弟绑定间稠密的 `toJS()` 交叉引用网**（JSDocument→JSElement→JSNode…）。切 window 表只释放真叶子（0.85 MB）；砍那 ~7 MB 必须切整个引用网 + 事件胶水（Level 3，数天、高风险，会伤基础对象模型）。规律:靠"删引用"无效,靠"**不编译**"(从 Sources.txt/IDL 移除)才有效。
  - **尚未物理摘除的高风险裁点**（运行能力已通过开关/设置禁用，留档供后续专项）：inspector 桩化；accessibility 主体；JSC Intl；StyleExtractorGenerated；IndexedDB/Push 等模块的完整 IDL+事件工厂+supplement 闭包。WebSQL 绑定已摘除；WebSocket 仅保留 core Event/EventTarget 工厂需要的 `WebSocket`/`CloseEvent` 内部闭包。IndexedDB 全摘实编译暴露 worker/structured-clone/inspector 的宽闭包，且 full LTO 下最终 DLL 没有可测收益，已回退，不再重复冒进。依赖侧已完成 curl 去 HTTP/3 与 SQLite 去 FTS/JSON/RTREE；libxml2/libxslt 因产品明确要求 XML/XSLT 不按 minimum 模式冒进。硬下限:icuin/sqlite/harfbuzz/crypto 删不掉。
  - **分发**：不采用 facade、运行时解压或 %LOCALAPPDATA% 缓存。package-release.ps1 把正常运行目录直接做 solid x86-BCJ + LZMA2(16 MiB) tar.xz；用户必须先完整解压，解压后的 shot.dll 就是 WebCore/JSC 核心。Windows x64 包 **17,299,500 bytes**（SHA-256 03825987ed9619e680ba9a39924f34f7ac1dd57c1f5042958f49796f4d4e3cf6），位于 WebKitBuild/releases/shotkit-0.1.0-windows-x64.tar.xz。空目录解压后隔离 PATH 实测新进程 176.6/79.0/87.7 ms，且不写 LOCALAPPDATA。相对严格 15,000,000 bytes 目标仍高 2,299,500 bytes；不以运行时解压、UPX 或高风险核心裁剪伪装达标。
- **Windows 托管 CI**（2026-07-19）：GitHub `windows-2022` 用 `-j2` + 单线程 full LTO 完成全量构建、PNG/WebP、无脚本网络闭包、10 个 C ABI 导出和发布收集。vcpkg 二进制包使用缓存；CI 从锁定且校验 SHA-512 的 ICU 77.1 源数据重建精简 `icudt77.dll`，并对 ICU DLL（5,000,000 bytes，2026-08-01 随追加裁剪由 15 MiB 收紧）和最终包（22,000,000 bytes）设硬上限。run `29687395037`：`shot.dll` **39,421,440 bytes**，`shotcli.exe` **49,152 bytes**，`tar.xz` **17,260,888 bytes**。
- **Linux 托管 CI**（2026-07-19）：Ubuntu 24.04 + clang-18/lld-18 + full LTO 完成 PNG/WebP、无脚本网络、10 个 C ABI 导出、RPATH 和 18,000,000 bytes 包上限检查。run `29687395019`：strip 后 `libshot.so` **48,999,400 bytes**，`shotcli` **35,296 bytes**，`tar.xz` **12,217,272 bytes**。
- **macOS 托管 CI**（2026-07-19）：macOS 15 arm64 + Xcode 26.3 非 LTO 构建完成内部链接完整性、PNG/WebP、CFNetwork、无脚本网络、XML/XSLT、10 个 C ABI 导出、RPATH 和发布归档检查。run `29687395027`：strip 后 `libshot.dylib` **41,069,504 bytes**，`shotcli` **57,192 bytes**，`tar.xz` **9,540,040 bytes**。WebP 由静态链接 libwebp 编码，发布包不依赖 Homebrew dylib。
- **跨浏览器基准**（2026-07-14）：`apps/benchmark/` 已迁移为 TypeScript ESM + `tsx`，对比 Puppeteer Chrome/Firefox、Playwright Chromium/Firefox/WebKit 与 ShotKit 的进程冷启动和常驻热请求；场景为本机 HTTP 静态 fixture、真实公网 `https://example.com/`、本地 `file://` + 外链 CSS，均为 1280×800 DPR1 full-page PNG，每次隔离页面/网络状态。每个“引擎×场景×冷/热”截图 3 次并取最快，108 个正式样本全部成功。Windows i9-14900KF 上 ShotKit 三场景冷/热最快值分别为 HTTP 186.4/91.1 ms、example.com 345.9/128.1 ms、file 158.1/66.4 ms；常驻 RSS 45.0 MB、完整分发 64.1 MB。原始样本与表格见 apps/benchmark 的 `results/latest.json` / `results/latest.md`。
- **Node.js SDK**（2026-07-14）：`apps/node/` 提供 `@shotkit/node@0.1.0`，用 JSONL 封装 `shotcli --serve` 常驻进程，支持 ESM + CommonJS、Promise、并发安全串行、PNG/WebP Buffer、URL/HTML/file 输入，无 node-gyp/N-API 编译且生产依赖为 0。源码测试 4/4、严格类型检查与 npm audit 全绿；带完整 Windows x64 runtime 的 tgz 为 28.9 MB（解压 67.3 MB），已在全新 npm 项目中安装并实测公网 URL/HTML 的 PNG/WebP 与 CJS。构建与 SHA-256 见 `bindings/node/RELEASE.md`；Python/Go 等语言可直接使用 `docs/language-bindings.md` 的同一 JSONL 协议或 C ABI。
- **CI 平台矩阵扩展**（2026-07-23，**六作业全绿** @ `3f6092953214`）：Linux 增加 arm64（`ubuntu-24.04-arm`）、macOS 增加 x64/Intel（`macos-15-intel`，Xcode 选择自适应 26.3→26.x→16.4）、Windows 增加 arm64（`windows-11-arm`，首轮通过后已转**必过作业**；arm64 镜像预装工具链不全，workflow 内含 choco/vcpkg 兜底安装）。`build-shot.ps1`（-Arch）、`package-release.ps1`（-Architecture，arm64 不用 x86-BCJ 滤镜）、`collect-dist.ps1`/`verify_no_script_network.ps1`（-VcpkgTriplet）、dumpbin 按 host 架构选择均已参数化。首轮 Windows arm64 失败于 WebKitRequirements ICU 端口给数据 DLL 硬编码 `-base:0x4ad00000`（ARM64 禁止 4GB 以下基址，LNK1355）；已在 `WebKitLibraries/ports/icu` 建 overlay port 追加补丁 0005（ARM64 下跳过全部固定基址，port-version 4），`vcpkg-configuration.json` 增加 overlay-ports，arm64 triplet 原生构建改为 release-only 提速。**新架构体积基线（strip 后，CI 实测）**：Linux arm64（full LTO）`libshot.so` **48,884,616 bytes**、`shotcli` 34,640、xz **10,703,564**；macOS x64/Intel（非 LTO）`libshot.dylib` **43,427,944 bytes**、`shotcli` 40,232、xz **11,474,804**；Windows arm64（full LTO）`shot.dll` **37,958,144 bytes**（比 x64 的 39,421,440 更小）、`shotcli.exe` 46,592、精简 `icudt77.dll` 8,181,248、xz **15,819,004**。
- **JS 绑定退化 Level 3——生成器路线**（2026-07-24）：不走"手工切 toJS 引用网"（此前评估数天高风险的方案），改为 `CodeGeneratorJS.pm` 单点退化——清单内接口生成为纯 wrapper 空壳（保留类/toJS/GC 底座，兄弟绑定交叉引用照常满足；不生成属性表/属性/操作/构造器胶水，胶水对 impl 的调用即引用锚随之消失，full LTO 自动清扫）。试点 12 接口 −416 KB 验证机制与密度（≈0.21 B/生成源码 B）后推全量：**1612 个无 Custom 文件接口，shot.dll 39,545,856 → 35,257,856（−4.29 MB，−10.8%）**。回归：像素级与基线一致（rich fixture SHA-256 相同；首测 8 像素差异确认为 DirectWrite 首跑抖动，基线自复现）、无脚本网络、重定向 CSS/cookie 往返/WebP/XSLT/重定向环干净失败、导出面 10 个不变。安全论证：wrapper 只在 JS 触碰 DOM 时创建，本内核 JS 永不执行（SHOT_NO_SCRIPT 四层拦截），退化体运行期不可达。保守排除清单：streams/fetch/核心对象模型（WebCore 内部 JS 机器可能触达）、`[LegacyFactoryFunction]` 接口保留构造器（JSDOMWindow 引用）。接线跨平台（WebCoreMacros.cmake + OptionsShot.cmake），Linux/macOS 由 CI 验证。**二期 2a（2026-07-24 已做）**：审计 94 个 Custom 文件后发现约 60 个只含 GC 钩子（`visitAdditionalChildren[InGCThread]` 等，由接口级扩展属性驱动、退化不影响其声明），可零管道退化——含 **CSSStyleDeclaration（StyleExtractor 锚）、CanvasRenderingContext2D 系 + HTMLCanvasElement（Canvas 2D API 实现锚）**、Range/HTMLCollection/NodeList/StyleSheet/CSSRule 等 59 个。实测 **34,315,264（再 −0.92 MB；较原基线 39,545,856 累计 −5.23 MB / −13.2%）**，全套回归再绿。附带修复：退化文件保留 `JSDOMPromiseDeferred.h` 包含（unified 捆内兄弟文件与 `Ref<DeferredPromise>` 成员的 impl 头历史上依赖该传递包含）。**二期 2b 第一批（2026-07-24 已做）**：清单新增 `Name strip-custom` 语法——退化之余剥掉接口级 `Custom*` 扩展属性，使生成代码不再引用手写 `JS*Custom.cpp`，后者由 `ShotPruning.cmake` 排除编译（两处清单同步维护；排除正则不加 `$` 锚，Sources.txt 条目可能带 `@cost` 注记）。本批 14 个接口：**Document、Element**、History、MessageEvent、PopStateEvent、Navigator、XMLHttpRequest、KeyframeEffect、ShadowRoot、IDBCursor/WithValue/Request/Record、WorkerGlobalScope。Document 家族 toJS 依赖的两个自由函数（`cachedDocumentWrapper`/`reportMemoryForDocumentIfFrameless`）原样迁入新文件 `bindings/js/JSDocumentWrapperCacheShot.cpp`。实测 **33,072,128（再 −1.19 MB；较原基线累计 −6.47 MB / −16.4%）**，全套回归（像素/全页/WebP/网络/无脚本/导出面 10）再绿。**审计教训**：外部引用除 `JSX::member` 语法外还要扫 `jsCast<JSX*>` 成员调用（ErrorEvent 因 `JSErrorHandler.cpp` 调 `->error()` 被剔除）。**2b 剩余（已审计、暂缓）**：DOMWindow（1.68 MB 生成源码，`getOwnPropertySlotDelegate` 被树内引用+全局对象/跨源机制）、Location（同族）、HTMLElement（`eventHandlerScope` 被 `JSLazyEventListener.cpp` 引用）、HTMLAllCollection（getCallData）、EventTarget/Node/Event（核心对象模型）；其余带成员 Custom 的接口多为已关特性（WebXR/Payment/MediaControls 等），退化收益近零。**三平台 CI 终局基线（HEAD `26668ab73193`，六作业全绿，strip 后 / tar.xz）**：Windows x64 `shot.dll` **33,022,464**（39,421,440 → −16.2%）/ xz 15,830,996；Windows arm64 **31,632,384**（−16.7%）/ xz 14,566,176；Linux x64 `libshot.so` **40,782,688**（48,999,400 → −16.8%）/ xz 10,479,464；Linux arm64 **40,430,344**（−17.3%）/ xz 9,155,496；macOS arm64 `libshot.dylib` **35,260,480**（41,069,504 → −14.1%，非 LTO）/ xz 8,324,252；macOS x64 **37,368,832**（−14.0%）/ xz 10,064,288。
- **CookieJarDB 去 SQLite**（2026-08-01；**2026-08-02 统一编译验证：编译零错误，cookie 往返语义回归通过；shot.dll 的 sqlite3 导入 27→1 个符号，但 sqlite3.dll 仍在分发闭包内——最后一个 `sqlite3_close` 不来自本文件，见本条末尾**）：`Source/WebCore/platform/network/curl/CookieJarDB.{h,cpp}` 内部实现从 SQLite 表改写为纯内存 `Vector<CookieRecord>`（cpp 671→446 行），public 接口签名逐字不变，故 `NetworkStorageSessionCurl.cpp` / `NetworkStorageSession.h` / `platform/Curl.cmake` 零改动。该文件是 shot.dll 全部 27 个 sqlite3 import 的唯一活来源（webdatabase / indexeddb server / SWRegistrationDatabase / SearchPopupMenuDB 在 Shot 链接图中均无活锚），摘除后可不再分发 `sqlite3.dll`（分发 −1.04 MB）。语义逐项保持：`UNIQUE(name, domain, path)` upsert、`MAX_COOKIE_PER_DOMAIN`(80) 读取时截断、`ORDER BY length(path) DESC, lastupdated`（单调递增 stamp 复现）、`domain = ?` OR `domain GLOB '*.<registrable>'` 双模匹配后再过 `CookieUtil::domainMatch`、httpOnly/secure/session 三态可选过滤、查询时跳过过期 cookie（与原 SQL 一致，不做物理清除）、accept policy 与 `__Secure-`/`__Host-` 校验原样保留。`CookieUtil.{h,cpp}` 不涉及 SQLite，未改动。
- **编译期斩断 JSGlobalObject 创建链**（2026-08-01；**2026-08-02 实测 shot.dll 仅 −0.27 MB（JSC 段净 DCE），远低于 −6~8 MB 预期；根因见本条末尾“为什么没有兑现”**）：`WindowProxy::jsWindowProxy()` 在 SHOT_NO_SCRIPT 下直接返回 nullptr——该函数是 `JSDOMWindow`(`JSGlobalObject` 子类）**唯一**懒创建入口，JS 世界永不成型，`JSGlobalObject::init` 的 lazy-property 注册（存 lambda 地址）就不再锚住整张 JSC runtime builtin 图（lldmap 实测该桶约 7.1 MB `.text`），交给 full LTO 清扫。配套三处：`ScriptController::jsWindowProxy()` 的 `ASSERT_WITH_MESSAGE` 升级为 `RELEASE_ASSERT_WITH_MESSAGE`（Release 下原断言为空，遗漏调用方会静默空指针 UB；改后立即显式崩溃，作为统一验证阶段的 tripwire）；`ScriptController::executeJavaScriptURL` 早退（`javascript:` URL 由页面内容驱动、`FrameLoader` 侧只查 sandbox 不查 `canExecuteScripts`，会踩上述 tripwire，上游行为本就空转，早退语义等价）；`JSNodeCustom.h` 的 `willCreatePossiblyOrphanedTreeByRemoval()` 置空（**唯一实测到的非-JS 触达路径**：`ContainerNode` 的纯 C++ 删除路径 `Source::API` + `refCount()>1` 会走到它，慢路径经 `mainWorldGlobalObject()` 强制创建 JS 世界；其职责纯为模拟 JS 的 DOM 生命周期，无脚本时无 wrapper 可保，置空 100% 语义无损）。**核实结论**（4 个前期遗留点）：`LocalFrame::injectUserScriptImmediately`（user script 注入，ShotKit 从不注册 user script，`forEachUserScript` 回调体不执行；另一调用方 `Quirks.cpp` 需 click 事件）、`Document.cpp` 的 `toJSDOMWindow` 在 `#if ENABLE(PICTURE_IN_PICTURE_API)` 内（`WebKitFeatures.cmake:268` 默认 OFF，仅 iOS/Mac 打开，Shot 不编译）、`JSDOMWindowCustom.cpp` 的 `mainWorldGlobalObject(LocalFrame&)`（10 个调用方：7 个 inspector agent 需前端连接、`Document::didLogMessage` 需 `Document::logger()` 而它只被 media/WebRTC/EME 栈调用且这些特性全 OFF、`JSNodeCustom` 一处已处理）、`JSIDBSerializationGlobalObject::create`（唯一调用方 `IDBBindingUtilities.cpp:577` 的 `IDBSerializationContext::initializeVM`，只由 `callOnIDBSerializationThreadAndWait` 触发，而后者在全树**零调用方**）——四点均确认不可达。**预期内保留**：`commonVM()` 锚住的 VM/GC/Heap/`WebCoreBuiltinNames`/streams-builtins 与本项无关，仍在二进制内，属二期候选。同批防御性小改：`ShotPage` 显式 `setUsesBackForwardCache(false)`（BFCache 会让挂起的 Document/DOMWindow 越过导航存活，是少数能复活 JS 世界的路径，当前架构恰好不触发，显式声明防未来 iframe/导航工作绕过）；`ShotGlobal` 注册空 `ServiceWorkerProvider` 哨兵（`singleton()` 内是 `RELEASE_ASSERT(sharedProvider)`，而 `DocumentLoader::matchRegistration` 等只靠 `m_canUseServiceWorkers`（默认 true、仅由 `FrameLoader::init` 纠正）把关；哨兵让 `existingServiceWorkerConnection()` 返回 nullptr 而非崩溃）。
- **摘除 icuin77.dll（ICU i18n 库）依赖**（2026-08-01，T4；**2026-08-02 实测：本条列出的五处直接锚全部消失（icuin 导入符号 138→111），但 icuin77.dll 仍被 JSC 的 Intl 系锚住，分发未减，见本条末尾**）：斩链（上一条）预计清掉 Intl 系全部 icuin 符号（ucfpos/ulistfmt/unumf/unumrf/unumsys/uplrules/ureldatefmt/udtitvfmt/ufieldpositer/ufmtval 十族，以及 ucal/udat/udatpg/ucol/unum 里的 Intl 份额）。本条处理**斩链覆盖不到的残余锚**，逐件锚分析结论如下：
  - **① JSC DateCache（8 个 `ucal_*`）→ 有残锚，已改**。构造函数干净（只 `listenForTimeZoneChangeNotifications`），但**析构不干净**：`~VM → ~DateCache`（`= default`）→ `OpaqueICUTimeZoneDeleter::operator()`（JSDateMath.cpp:114）→ `delete OpaqueICUTimeZone` → `unique_ptr<UCalendar, ICUDeleter<ucal_close>>`，与 JS 无关地锚住 `ucal_close`；`VM::VM()`（VM.cpp:546-550）还无条件调 `initializeAvailableTimeZones()` + `dateCache.timeZoneDisplayName(false)`，前者经 `utcTimeZoneID → intlAvailableTimeZoneEntries`（IntlObject.cpp:2017+）拉 `ucal_openTimeZones/openTimeZoneIDEnumeration/getIanaTimeZoneID/getCanonicalTimeZoneID`，后者拉 `ucal_getTimeZoneDisplayName/open/getHostTimeZone`。处理：`DateCache` 在 `PLATFORM(SHOT)` 下退化为纯 UTC + VM 构造里那段加 `#if !PLATFORM(SHOT)`。非 JS 调用方核实为 0（`DateCache::parseDate` 只被 `DateConstructor.cpp` 与 `JSDOMConvertDate.cpp` 用，均随斩链死；WebCore/WTF 的 HTTP 日期解析走 `WTF::parseDate`，不经 `vm.dateCache`）。
  - **② LocaleICU（12 个 `udat_*`/`unum_*`/`udatpg_*`）→ Windows 也在编 LocaleICU，已改**。`PlatformWin.cmake:90` 与 `PlatformShot.cmake` Linux 段都列 `platform/text/LocaleICU.cpp`（不是 `LocaleWin.cpp`），且被 `Document::getCachedLocale`（Document.cpp:9949）真实锚住。两段都换成树内现成的 `platform/text/LocaleNone.cpp`（该文件此前无端口编译、已 bit-rot，顺手修好 Vector 构造与 TZone 分配器）。**保真影响**：date/time 表单控件退化为 ISO 格式 + 英文月份/AM-PM，number 控件不再本地化小数点/千分位。macOS 用 `LocaleCocoa`，未动。
  - **③ ucsdet 字符集探测（7 个符号）→ 唯一确认的非 JS 运行期锚，已改**。`PAL/pal/text/TextEncodingDetectorICU.cpp` 的 `detectTextEncoding` 在 `PLATFORM(SHOT)` 下直接 `return false`。选择"编译期改函数体"而不是"PAL 换源文件 + 新增桩文件"或"`shouldAutoDetect()` 恒 false 靠 LTO 折叠"：前者要动 `PAL_UNIFIED_SOURCE_EXCLUDES` + 新文件（爆炸半径更大），后者依赖 LTO 内联折叠（本条要的是确定性）。行为等价——`m_usesEncodingDetector` 默认 false 且 Shot 从不打开。
  - **④ usearch 字符串搜索（10 个 `usearch_*` + 2 个 `ucol_*`）→ 残锚比预期多，已改**。`LocalDOMWindow::find()` 确实随斩链死，但还有三个非 JS 锚：`EditorCommand.cpp:395` 的静态命令表（函数指针）、`AccessibilityObject::findTextRanges`（vtable `final` override）、以及**真正活着的** `LocalFrameView.cpp:3168` 的 scroll-to-text-fragment（`ScrollToTextFragmentEnabled` 的 WebCore 默认值为 true）。处理：`ICUSearcher` 在 `PLATFORM(SHOT)` 下退化为"永不匹配"。**保真影响**：`#:~:text=` 不再高亮/滚动；其余调用方本就不可达。
  - **⑤（新发现，不在原定四件内）`WTF::Collator` → `xsl:sort`**：剩余 `ucol_open/setAttribute/strcoll(Iter)/close` 来自 `wtf/unicode/icu/CollatorICU.cpp`，活消费者是 `XSLTUnicodeSort.cpp:115`（函数指针交给 libxslt，LTO 删不掉），而 `ENABLE_XSLT=ON` 是产品硬需求。已在 `PLATFORM(SHOT)` 下把 `Collator` 换成 code point 序实现。**保真影响**：`xsl:sort` 不再按 locale 排序。**若不做这一件，icuin 无法归零**。
  - **分发链路**：`scripts/collect-dist.ps1` 是纯递归 import 闭包（唯一显式追加的是按名加载的 `icudt*.dll` 数据包），**无需改动**——icuin 的 import 一消失就自动不收集。已用 dumpbin 复核依赖池：只有 `icuio77.dll` / `icutu77.dll` import icuin，而这两个本就在被排除的死重 DLL 里；`icuuc77.dll`、harfbuzz、libxml2/libxslt、sqlite、skia 均不 import icuin。
- **编译期桩化 WebCore inspector 子系统**（2026-08-01，T5；**2026-08-02 实测 −0.20 MB，落在预期区间下沿**）：新增 `SHOT_NO_INSPECTOR` 编译开关。inspector 是 4.6-D 里唯一还没动的中等裁点，它**没有 `ENABLE_*` 门控**：`PageInspectorController` 是 `Page` 的无门控 `UniqueRef` 成员（`Page.h:1498`、`Page.cpp:403`），`FrameInspectorController` 是 `LocalFrame` 的（`LocalFrame.cpp:208`），`WorkerInspectorController` 是 `WorkerOrWorkletGlobalScope` 的（`WorkerOrWorkletGlobalScope.cpp:53`）——每个 Page/Frame 都会**真实分配**一整套 inspector 对象（InstrumentingAgents / WebInjectedScriptManager+Host / FrontendRouter / BackendDispatcher / InspectorOverlay / LegacyIdentifierRegistry / 一个活的 ConsoleAgent），且静态钉住约 20 个重 agent。
  - **两条主刀口**。① `InspectorInstrumentationPublic::hasFrontends()` 在门控下变 `constexpr false`：`InspectorInstrumentation.h` 的约 187 个 inline 入口全部经 `FAST_RETURN_IF_NO_FRONTENDS` / `hasFrontends()` 走 fast-path，折叠后 `InspectorInstrumentation.cpp`（68 KB）的 `*Impl` 群体整体失锚；签名不变故**调用点零改动**。② 三个 controller 的 `createLazyAgents()` + 构造函数里的 ConsoleAgent 创建是全部 agent 的**唯一**静态命名点，掏空后 `InspectorDOMAgent`(128 KB)/`InspectorStyleSheet`(80 KB)/`FrameDOMAgent`(72 KB)/`InspectorNetworkAgent`(64 KB)/`InspectorCSSAgent`(56 KB)/`FrameCSSAgent`(44 KB)/`InspectorPageAgent`(40 KB)/`InspectorCanvas`(36 KB)/`InspectorIndexedDBAgent`(32 KB)/Timeline/Canvas/Animation/DOMDebugger/LayerTree/Debugger/Runtime/Heap/Audit/ScriptProfiler 等一并失锚；另把 overlay 九个入口掏空以杀 `InspectorOverlay.cpp`(108 KB)。
  - **保守空壳路线**：**保留全部类型与 public 方法签名**，只掏行为。`Page.cpp`/`FrameLoader.cpp`/`Node.cpp`/`LocalFrameView.cpp`/`JSDOMWindowBase.cpp` 五个外部调用点**零改动**。成员逐个取舍：`InspectorOverlay` 是非多态、构造函数平凡的 `UniqueRef`，**保留构造**（仅剩 ctor/dtor + 一个 Timer 回调），靠掏空九个入口杀掉它 108 KB 的本体；`InstrumentingAgents`/`FrontendRouter`/`BackendDispatcher`/`Stopwatch`/`LegacyIdentifierRegistry` 都是轻量对象，**保留**；`WebInjectedScriptManager` 是多态、**必须构造**的 `const Ref`，按"轻量空对象"原则改掏它自己的三个 override（切断 `CommandLineAPIHost` + `CommandLineAPIModule` + 注入 JS 源）；`PageDebugger`/`m_agents` 随 `createLazyAgents` 自然为空。
  - **顺带切断的 JS 引用边**：`canAccessInspectedScriptState`/`functionCallHandler`/`evaluateHandler` 是 `InspectorEnvironment` 虚函数、经 controller 的 vtable **恒被锚住**，掏空后切掉到 `JSDOMWindow`/`BindingSecurity` 与 `JSExecState` 的 `functionCallHandlerFromAnyThread`/`evaluateHandlerFromAnyThread` 蹦床的引用边——与斩链（T3）同向。
  - **运行期收益**：每个 Page / 每个 LocalFrame 不再分配 ConsoleAgent 与 CommandLineAPIHost，`InspectorInstrumentation` 的 187 个插桩点在每帧布局/绘制/资源加载路径上折叠为零指令。
  - **两处"不做"的结论**（已核实，留档）：① `InspectorNetworkAgent::errorDomain()`（`InspectorNetworkAgent.h:82`）是 `static constexpr ASCIILiteral`，**inline 常量不生成代码、不产生链接锚**，故 `SubresourceLoader.cpp:48/836` 与 `DocumentThreadableLoader.cpp:49/806` 的 `#include` 是免费的，**无需迁移常量、无需动这两个 loader 文件**。② `InspectorInstrumentation.cpp` 的第三个非 inline 旁路 `willDestroyWebGLProgram` 位于 `#if ENABLE(WEBGL)` 内，Shot 该开关为 OFF，**本就不编译**。
  - **自查结论**：`didClearWindowObjectInWorld` 掏空安全（`m_inspectorFrontendClient` 只由 `setInspectorFrontendClient` 设置，唯一调用方 `WebCore/testing/Internals.cpp` 不参与 Shot 编译，恒为 nullptr；injected script 恒为空）；`Node::inspect()` 在编译树内**零调用方**（唯一调用点 `ContextMenuController.cpp:644` 整文件在 `#if ENABLE(CONTEXT_MENUS)` 内、Shot 为 OFF）；console 链安全——`InspectorInstrumentation::addMessageToConsole` 没有 fast-path、会真的走到 `addMessageToConsoleImpl`，但它第一句就是 `if (!instrumentingAgents.developerExtrasEnabled()) return;`（ShotKit 恒 false），且再往后是 `if (auto* consoleAgent = ...webConsoleAgent())` 的空指针判断，**不建 ConsoleAgent 是干净 no-op 而非空指针**；`LocalFrameView.cpp:5017` 调用方自带 `hasFrontends()` 守卫、随之折叠；`inspectedPageDestroyed` 跳过 `InspectorBackendClient::inspectedPageDestroyed()` 安全（`EmptyClients.cpp:446` 该方法为 `final { }`，ShotKit 不装别的 client），仍置空 `m_inspectorBackendClient` 以满足析构函数的 `ASSERT(!m_inspectorBackendClient)`。
  - **残余锚（预期内保留）**：`InspectorFrontendHost`(28 KB) 由其自身 JS 绑定锚住（走 degenerate-bindings 而非本开关）；`WebInjectedScriptHost.cpp`(16 KB) 的三个虚函数经 vtable 保留（gate 它需连带 gate 两个 static helper 以免 unused-function，收益小、未做）；`InspectorIdentifierRegistry.cpp`(8 KB) 因 `LegacyIdentifierRegistry` 多态且被构造而保留。
- **JSC 目标单独降到 `-Oz`**（2026-08-02，T6；**实测 −1.49 MB，是本轮六项中最大的单项贡献，比预期高一个数量级**）：页面 JS 永不执行（`SHOT_NO_SCRIPT` 四层拦截 + T3 编译期斩断 `JSGlobalObject` 创建链）使 JSC 成为全项目**唯一没有热路径**的大目标——CLoop 解释器从不进入、GC 只在近空堆上跑、Yarr 仅由表单 `pattern` / `type=email` 校验低频调用，故把整个 JavaScriptCore target 从 MinSizeRel 全局的 `-Os` 降到 `-Oz`（clang-cl 用 `/clang:-Oz`，clang 用 `-Oz`），**性能零代价**；WebCore / WTF / bmalloc / Skia 是布局、光栅与分配热路径，**不动**。接线只改本项目自有的 `Source/JavaScriptCore/PlatformShot.cmake`（`list(APPEND JavaScriptCore_COMPILE_OPTIONS ...)`，随后被 `WebKitMacros.cmake` 的 `_WEBKIT_TARGET_SETUP` 转成 `target_compile_options(JavaScriptCore PRIVATE ...)`；写法对齐树内既有先例 `Source/bmalloc/PlatformIOS.cmake:11`），**无上游文件改动，故不入偏离清单**；子目标 `JavaScriptCoreJIT` 经 `WEBKIT_DEFINE_SUBTARGET` 的 `$<TARGET_PROPERTY:JavaScriptCore,COMPILE_OPTIONS>` 自动继承（Linux/macOS 路径），clang-cl 下该子目标根本不创建（守卫为 `COMPILER_IS_CLANG AND NOT MSVC`）、源文件全在主 target，两条路径都覆盖到；用 target 级而非 source 级还保证 `cmake_pch.cxx` 与普通源同 flag，不触发 clang PCH 不匹配。**生效顺序已实测**：CMake 把 `CMAKE_<LANG>_FLAGS_<CONFIG>`（MinSizeRel 的 `/O1`）排在 target `COMPILE_OPTIONS` **之前**，而 clang 驱动对 `-O` 组取 `getLastArg`（后出现者胜）——`clang-cl -###` 下 `/O1` 单独 → cc1 收到 `-Os`，`/O1 /clang:-Oz` → cc1 收到 `-Oz` 且 `-vectorize-loops` 消失；`/clang:` 参数还会被驱动追加到参数表末尾，故与命令行先后无关、恒胜。最小 CMake 工程实测生成的 ninja `FLAGS`：MinSizeRel = `-Os -DNDEBUG … -Oz`，Debug = `-O0 -g …`（无 `-Oz`，`$<NOT:$<CONFIG:Debug>>` 守卫生效）。**full LTO 兼容性已实测**：`-Oz` 把 `minsize` 写进 bitcode 的函数 attribute（`-Os` 只有 `optsize`），LTO 后端 codegen 按**函数属性**决策，故效果精确局限在 JSC 的函数上，不外溢到合并进同一模块的 WebCore。范围守卫：只作用于 C/C++（及 Apple 上 JSC 的 ObjC/ObjC++ 源），不碰 Swift 与 asm；仅 clang 系接线（`COMPILER_IS_CLANG_CL` / `COMPILER_IS_CLANG`），GCC 直到 12 才支持 `-Oz`，不冒进。**未做（留档）**：`LowLevelInterpreterLib`（`llint/LowLevelInterpreter.cpp`，CLoop 解释器本体）是 `JavaScriptCore/CMakeLists.txt` 里的独立 `add_library`，**不继承** `JavaScriptCore_COMPILE_OPTIONS`，故本条不覆盖它；它同样永不执行、理论上可再降 `-Oz`，但该目标已有 Windows arm64 `/clang:-fno-unwind-tables`（LLVM #47432）与 Debug 下 `-O` 的历史工具链兜底，改优化级别的爆炸半径未知，留待有实测预算时单独评估。
- **T1–T6 统一编译验证**（2026-08-02，Windows x64 / clang-cl / MinSizeRel + full LTO，基线 `3deb6821e1ef` + 未提交工作区）：**六项改动全部编译通过，零源码错误，无需任何修复**。唯一一次构建失败与改动无关——ninja 默认并发（本机 32 逻辑核 → `-j34`）让 34 个 clang-cl 同时编译 WebCore 统一源并发射 LTO bitcode，64 GB 物理内存被打穿，34 个目标齐报 `LLVM ERROR: out of memory`；改用 `build-shot.ps1 -Build -Jobs 10` 从缓存续编即通过。**构建须知：本机全量重编必须限并发（-Jobs 10 实测安全），否则必 OOM。**
  - **体积（strip 后实测）**：`shot.dll` 33,072,128 → **30,921,216 bytes**（−2,150,912 / −6.50%）；`shotcli.exe` 48,640 不变；导出面恒为 **10** 个 `shot_*`。Windows x64 运行闭包 54,301,184 → **48,200,704 bytes / 24 文件**（−6,100,480 / −11.2%），其中绝大部分来自 T1 的 `icudt77.dll` 8,181,248 → 4,231,680。
  - **逐项归因**（对前后两份 lld `/lldmap` 做符号级 diff；把 JSC 段拆成"函数被整体删除"(DCE) 与"同名函数变小"(codegen) 两类，工具 `attrib_diff.py` / `split_dce_vs_oz.py`）：**T6 `-Oz` = −1,562,928**（13,373 个两版都存在的 JSC 函数整体缩小，**本轮最大单项，比预期高一个数量级**）；**T3 斩链 ≈ −273,557**（JSC 净 DCE：删除 603,728 / 新增 330,171，后者是 -Oz 改变内联决策后重新外联的函数）；**T5 inspector = −198,093**；**T4 ICU 消费方 = −13,118**（LocaleICU→LocaleNone −6,279、DateCache −4,646、ICUSearcher −1,369、TextEncodingDetector −824）；**T2 SQLite 代码 = −5,408**（CookieJarDB 自身反而 +579，纯内存实现比 SQL 版略大）。分段净值：JSC −1,836,485、WebCore −107,253、WTF −85,314。
  - **功能回归 15/15 全绿**：本地 i18n（中文断行 / 日语禁则 / 泰文词典断行 / 阿拉伯 RTL / emoji / `text-transform:capitalize`）、外链 CSS + 外链图、302 子资源重定向、**cookie 下发-回读往返（T2 语义硬验收：cookiepix 命中绿 5120 px、红 0 px）**、WebP 编码输出、WebP 解码、外部 XSLT、内嵌 XSLT、主资源 302、重定向环干净失败(exit 6/0.4s)、坏子资源不阻塞整页、硬超时精确按 `timeout_ms` 退出(3.1s)、坏主机干净失败、脚本页正常渲染且零 `.js` 请求。另：`verify_no_script_network.ps1` PASS（全程仅 1 个请求）；`leak_harness` 300 次 render RSS 增长 0.4 MB、Shot/JSC VA reserve delta 32.5 MB、无 teardown 崩溃。**T3 斩链无遗漏调用方——全过程零 RELEASE_ASSERT 触发。**
  - **像素保真（端到端）**：i18n 压力页在"**旧二进制 + 原始 31.9 MB icudt**"与"**新二进制 + 精简 4.2 MB icudt**"两侧 PNG SHA-256 完全相同（`974EFF66…8A270DD2`，47,988 bytes）。即 T1 的数据裁剪叠加 T4 的 LocaleICU→LocaleNone / Collator 码点序 / ICUSearcher 退化，对渲染**零影响**。
  - **两项硬验收未达成（已用 map 定位到确切锚点，留给后续）** —— **两项均已在 2026-08-02 的 T8 中解决，见下一条；以下为当时的分析留档**：
    - **`sqlite3.dll` 仍在闭包**（1,038,336 bytes）。**T2 本身没有问题**：27 个 sqlite3 导入符号只剩 1 个 `sqlite3_close`，且它**不来自 CookieJarDB**。`/lldmap` 显示存活链是 `ScriptExecutionContext::m_databaseContext`（每个 Document 的 `RefPtr` 成员）→ `~DatabaseContext` → 其 `const RefPtr<DatabaseThread> m_databaseThread` 析构 → `~DatabaseThread` → `~Database` → `SQLiteDatabase::close`。同时 `SQLiteDatabase::open` 及另外 26 个符号已被 DCE，即**本二进制永远打不开数据库**，这条链是纯析构期死代码。它由成员 RefPtr 的析构锚住。（**T8 修正**：这里当时判断"加门控解不掉、必须物理摘除 `Modules/webdatabase`"是错的——把成员本身 `#if !PLATFORM(SHOT)` 掉、两个访问器退化为 nullptr/no-op，即可让 webdatabase 继续零改动编译且整条析构链失锚，`sqlite3.dll` 已退出闭包。）
    - **`icuin77.dll` 仍在闭包**（2,998,272 bytes），导入符号 138→111。**消失的 27 个正是 T4 直接处理的五处**（`ucsdet_*` 7 个、`usearch_*` 10 个、`ucol_strcollIter`，以及 `udat`/`udatpg`/`ucal`/`unum` 中属于 LocaleICU 与 DateCache 的份额）——**T4 每一处改动都生效了**。剩下 111 个**全部**属于 JSC 的 Intl/Temporal 系（`unumf`/`unumrf`/`ureldatefmt`/`ulistfmt`/`uplrules`/`unumsys`/`ucfpos`/`udtitvfmt`/`ufieldpositer`/`ufmtval` 十族，加 `ucal`/`udat`/`udatpg`/`ucol` 的 Intl 份额），统一被 `JSC::JSGlobalObject::init()` 的 lazy-property 注册表锚住；而 `init` 在新旧两份 map 中**符号数完全相同（482）**，说明 T3 根本没触及它。（**T8 已解决**：五家族一次性切断后 `init` 符号 482→0，icuin 导入 111→10，再退化 12 个 Intl cell 类的 `destroy()`（被 GC 的 `IsoHeapCellType` 单独钉住）后 10→0，`icuin77.dll` 已退出闭包。）
  - **T3 为什么没兑现 −6~8 MB（重要教训，后续勿重复踩）**：`WindowProxy::jsWindowProxy()` 确实是 `JSDOMWindow` 的唯一懒创建入口，但 **`JSDOMWindow` 只是 `JSDOMGlobalObject` 的五个子类之一**（另有 `JSWorkerGlobalScopeBase` / `JSWorkletGlobalScopeBase` / `JSShadowRealmGlobalScopeBase` / `JSIDBSerializationGlobalObject`），**任何一个的 `finishCreation()` 都会走到 `JSC::JSGlobalObject::finishCreation() → init()`**，而 `init()` 就是整张 JSC builtin 图（Intl*/Temporal/全部 prototype）的唯一锚。本轮**实测过两处补充门控（已回滚，不在工作区）**：① 门控 `WorkerOrWorkletScriptController::initScript()`（五个 worker/worklet 全局对象的唯一实例化点）确实让 `JSWorkerGlobalScopeBase::finishCreation` 从 map 消失，但**只减 28,160 bytes，`init` 仍在**；② 再门控 `WindowProxy::setDOMWindow()`（`JSWindowProxy::setWindow` 是 `JSDOMWindow` 最后的构造点，其循环遍历恒空的 `m_jsWindowProxies`，LTO 无法折叠）**又只减 1,536 bytes**。两次合计仅换来 29,696 bytes，故全部回滚。**结论：「斩断 JSGlobalObject 创建链」不是一两处门控能完成的，必须先用 `/lldmap` 把 `JSC::JSGlobalObject::finishCreation` 的全部调用方枚举干净、一次性全切，在那之前不要再零敲碎打。** 证据与工具留档：`attrib_diff.py`、`split_dce_vs_oz.py`，以及本轮前后两份 lldmap。
- **斩链二期 + sqlite 终结**（2026-08-02，T8；**两项硬验收全部达成**：`icuin77.dll` 与 `sqlite3.dll` 双双退出分发闭包）：接上条 T3/T2 的两个未兑现项，用 `/lldmap` 反查把锚点枚举干净后一次性全切。Windows x64 / clang-cl / MinSizeRel + full LTO，`-Jobs 10`，**两轮构建、零编译错误、零修复**。
  - **A. 斩链二期（五家族一次切断）**。用新 map 反查发现 T7 的判断错了一半：五个 `JSDOMGlobalObject` 子类的 `finishCreation` 在 map 里**全都查不到**，因为它们被 LTO **内联**进了各自的 `create()` 路径；真正存活并直连 `JSC::JSGlobalObject::finishCreation → init()` 的是 `WebCore::JSDOMWindow::finishCreation` 与 `WebCore::JSDOMGlobalObject::finishCreation` 两个符号。顺着它们回溯出**完整切断清单**（四刀，逐条见偏离清单）：① `JSWindowProxy::setWindow(DOMWindow&)`（`JSDOMWindow::create` 全树唯一调用点，被仍然存活的 `WindowProxy::setDOMWindow` 拉住）；② `WorkerOrWorkletScriptController::initScript()`（模板 `initScriptWithSubclass<>` 唯一实例化点，一次覆盖 worker/worklet 五个全局对象）；③ `JSDOMGlobalObject::deriveShadowRealmGlobalObject()`（函数指针挂在四个家族的静态 `GlobalObjectMethodTable`，取地址即链接锚）；④ `IDBSerializationContext::initializeVM()`。**验收：lldmap 中 `JSC::JSGlobalObject::init` 相关符号 482 → 0**，且全树再无任何 `*GlobalObject*::finishCreation`。连带 `JSC::Temporal* 327→0`、`JSC::Intl* 208→14`、`JSC::JSGlobalObject::* 656→49`、`DatePrototype`/`RegExpPrototype` 归零。
  - **B. icuin 归零的最后两道残锚**（斩链后 icuin 导入 111→10，全是 `u*_close`）。① `IntlCache` 是 `VM` 的成员，`~VM` 单独就锚住 `udatpg_close`（与 T4 的 `DateCache` 同款模式）。② 更隐蔽的一道在 **GC 基建**：`Heap::Heap()` 为 `FOR_EACH_JSC_DYNAMIC_ISO_SUBSPACE` 的**每个**类型无条件构造 `IsoHeapCellType` 成员，而 `IsoHeapCellType::Args<CellType>` 直接取 `&CellType::destroy` —— 与该类型能否被分配无关，于是 12 个 Intl cell 类的析构器（各自持 `unique_ptr<..., ICUDeleter<u*_close>>`）被 GC 单独钉住。把这 12 个 `destroy()` 在 `PLATFORM(SHOT)` 下退化即归零。**判定其可证不可达的依据**：斩链后 ICU 的全部 `*_open` 入口已从导入表消失，任何 Intl 对象都无法被构造，故用 `RELEASE_ASSERT_NOT_REACHED()` 而非静默 no-op。
  - **C. sqlite 终结**：`ScriptExecutionContext` 的 `RefPtr<DatabaseContext> m_databaseContext` 成员 + `FrameLoader::stopLoading` 里唯一的 `DatabaseManager::singleton()` 调用，两处切掉即可。**修正上一轮的结论**——当时判断"加门控解不掉、必须物理摘除 `Modules/webdatabase`"，实际上只要**去掉成员**（保留两个退化访问器让 webdatabase 继续零改动编译）就够了，无需摘模块。
  - **体积（strip 后实测）**：`shot.dll` 30,921,216 → **27,482,112 bytes**（−3,439,104 / −11.12%）；`shotcli.exe` 48,640 不变；导出面恒为 **10** 个 `shot_*`。**Windows x64 运行闭包 48,200,704 → 40,724,992 bytes / 24→22 文件**（−7,475,712 / −15.51%），精确构成 = shot.dll −3,439,104 + `icuin77.dll` −2,998,272 + `sqlite3.dll` −1,038,336。
  - **归因**（前后两份 lldmap 符号级 diff，`attrib_diff.py`）：JSC 段 9,100,170 → 6,086,763（**−3,013,407，占总量 87.6%**），其中 `JSGlobalObject/JSDOMGlobalObject/JSDOMWindow*` 桶 −2,644,401、JSC 各 prototype 函数族 −1,122,344（两桶有重叠）、`JSC::Intl*` −94,274、`DateCache/timezone` −6,884；WTF −83,003；WebCore −61,601；SQLite 代码本身仅 −317（**分发收益全在 DLL，不在 .text**）。
  - **回归 15/15 全绿，零 RELEASE_ASSERT 触发**（本轮新加的四处硬断言全部未被触碰，证明切断清单无遗漏调用方）：本地 i18n、外链 CSS+图、302 子资源、cookie 往返（绿 5120 px / 红 0 px）、WebP 编解码、外部与内嵌 XSLT、主资源 302、重定向环干净失败(exit 6/0.4s)、坏子资源不阻塞、硬超时(3.1s)、坏主机干净失败、脚本页零 `.js` 请求；另 `verify_no_script_network.ps1` PASS（全程 1 个请求）。**像素零变化**：i18n 压力页 PNG SHA-256 `974EFF66…8A270DD2`、47,988 bytes，与 T1–T6 基线**完全相同**。
  - **T7 的教训在本轮被证伪一半、坐实一半**：坐实的是"必须一次性全切"（单点门控只减 28 KB）；证伪的是"用 map 找 `finishCreation` 就能枚举家族"——LTO 内联会让子类 `finishCreation` 在 map 中**整体消失**，反查必须落到**仍然存活的那个符号**（这里是 `JSDOMWindow::finishCreation`）再回溯源码调用点，不能因为某家族符号查不到就判定它已死。
- **待办（非核心，可后置）**：iframe（本版 `EmptyFrameLoaderClient` 方法全 `final`，需从零手写约 100 个方法的 `LocalFrameLoaderClient`，**列为已知限制**，见风险 R6 同级）；上面尚未物理摘除的高风险裁点。

| 里程碑 | 内容 | 验证标准 | 体积基线（strip 后，实测填写） |
|---|---|---|---|
| **M0** Windows 端口骨架 | ALL_PORTS 注册、OptionsShot.cmake（Win 段）、各 PlatformShot.cmake，编译到 WebCore OBJECT 汇总；**体积化编译/链接层全部打开**（MinSizeRel/LTO/gc-sections/visibility，见 4.5①） | 链接出空 main 可执行文件；`jsc` shell（CLoop）能算 `1+1` | — |
| **M1** Win 最小 HTML→PNG ✅ | ShotGlobal/ShotPage + EmptyClients 替换件 + writer 直喂 + snapshotFrameRect + encodeData；子资源仅 data:；Skia 裁到纯 CPU（4.5③） | ✅ `shotcli --html` 截出 640×400 RGBA PNG，退出码 0，CJK/emoji 正常 | 67.4 MB（未优化 Release） |
| **M2** Win 网络化 + 体积 DCE + 硬化 ✅ | Strategies/CurlResourceLoader/NetworkingContext/Session、完成状态机、超时；DCE 三件套 + /O1；ICU 数据与 converter 裁剪；无脚本网络闭包；JSC 地址空间收缩；ANGLE 仅 delay-load 且不分发；斩链二期（JSGlobalObject 创建链五家族全切）+ icuin/sqlite3 双双摘除 | ✅ 网络/WebP/XML/XSLT/7 编码像素/无脚本请求；仅 10 个导出；1000×render RSS 基线 27.1→峰值 29.2 MB、增长 2.1 MB；Shot/JSC reserve 增量 32.6 MiB；**import 表中已无 `icuin77.dll` / `sqlite3.dll`，lldmap 中已无 `JSC::JSGlobalObject::init`** | **shot.dll 27,482,112 bytes**（2026-08-02 T8 实测；T1–T6 的 30,921,216 → −3,439,104 / −11.12%；更早 33,072,128 → 累计 −16.9%）；**shotcli 48,640 bytes**；导出面恒为 10；**Windows x64 运行闭包 40,724,992 bytes / 22 文件**（T1–T6 的 48,200,704 / 24 文件 → −7,475,712 / −15.51%；构成：shot.dll −3,439,104、icuin77.dll −2,998,272、sqlite3.dll −1,038,336）；无运行时解压或缓存 |
| **M3** Linux ✅ | OptionsShot Linux 段（Fontconfig/FreeType/Generic RunLoop）；Ubuntu CI 固定字体包；full LTO 构建与发布闭包 | ✅ Ubuntu 24.04 hosted CI：PNG/WebP/网络/无脚本/ABI/RPATH/发布包通过（run 29687395019） | full LTO strip：`libshot.so` **48,999,400 bytes**，`shotcli` **35,296 bytes**；xz **12,217,272 bytes** |
| **M4** macOS ✅ | mac 段（CG/CT/CFNetwork/ResourceHandle 路径）；LoaderStrategy 的 mac 分支；静态 libwebp 输出 | ✅ macOS 15 arm64 hosted CI：内部链接、PNG/WebP、CFNetwork、无脚本、XML/XSLT、ABI/RPATH/发布包通过（run 29687395027） | 非 LTO strip：`libshot.dylib` **41,069,504 bytes**，`shotcli` **57,192 bytes**；xz **9,540,040 bytes** |
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
2. **允许改上游源码，但每一处都要登记**到下方"上游偏离清单"（文件、改了什么、为什么）。快照模式下这是"改了什么"的账本；优先仍把逻辑放进新端口/`shot/`，纯粹为了可追踪、可回滚。
3. 删源码/桩化前先量化（bloaty 占比），收益 KB 级的不值当为它引入编译不稳定；本文件引用的行号仅为定位锚点，以符号名/函数名为准。
4. 新增代码风格遵循 WebKit 上游（WTF 智能指针、`_s` 字符串字面量、无异常）；`shot/` 内部可用 C++ 标准库但边界处转换为 WTF 类型。
5. 测试 fixture 放 `tests/`，golden 图按平台分目录（Win/Linux 同 Skia 可共享，mac 独立）。
6. **体积纪律**：引入任何新依赖、打开任何 ENABLE_/USE_ 开关前，先回答"值多少 KB"；里程碑完成必须更新第 7 节体积基线列；体积跳涨 >5% 必须用 bloaty 归因后才能合入。
7. **提交规范（强制）**：提交信息标题必须为 `<type>: <中文标题>`，type ∈ `feat|fix|perf|refactor|build|ci|docs|test|chore|revert`，可带作用域 `type(scope):`，冒号后一个空格；标题必须含中文、≤72 字符（建议 ≤50）、结尾不加句号；正文自由。git 自动生成的 `Merge `/`Revert `/`fixup! `/`squash! ` 标题豁免，历史英文提交不追溯。本地拦截：每个克隆执行一次 `git config core.hooksPath .githooks`（钩子在 `.githooks/commit-msg`）；远端由 `.github/workflows/commit-lint.yml` 强制，规则改动必须两处同步。示例：`fix(network): 修复子资源重定向后 cookie 丢失`。

### 上游偏离清单

已移出到 [`upstream-sync/deviations.md`](upstream-sync/deviations.md)。
它同时是同步上游时的冲突地图，和同步流程放在一起更顺手。

改动任何上游源文件后，务必在那里登记（文件、改了什么、为什么、里程碑）。

### 实施进度（M0/M1，2026-07-13 起）

**已完成**：
- 工具链：ninja / LLVM(clang-cl) 22 / Ruby 3.3 / gperf / win_bison+win_flex（`WebKitBuild/toolshims` 提供 `bison.exe`/`flex.exe` 兼容名）。
- 依赖：vcpkg（`WebKitLibraries/windows/vcpkg`）用 **`x64-windows-webkit` overlay triplet**（关键：它设 `ZLIB_COMPAT ON`，否则 curl 找不到 zlib）构建了 web/skia/woff2 全部 37 个库到 `WebKitBuild/vcpkg_installed`。
- 端口：`OptionsShot.cmake` + `Source/PlatformShot.cmake`（挂 shot/）+ `ALL_PORTS` 注册。**cmake 配置已通过**（`WebKitBuild/shot`）。
- 嵌入库：`shot/`（ShotGlobal / ShotPage / ShotPlatformStrategies / cli），单 `shotcli` 目标静态链接 WebCore OBJECT。
- 构建脚本：`scripts/build-shot.ps1`（`-Configure`/`-Build`/`-Clean`）。

**构建命令**（须在 VS x64 环境 + 上述工具链 PATH 下；clang-cl 需要 VS 的 Windows SDK/CRT）：
```
cmd /c '"…\VC\Auxiliary\Build\vcvarsall.bat" x64 && ninja -C WebKitBuild\shot shotcli'
```
配置命令见 `build-shot.ps1`（关键参数：`-DPORT=Shot`、vcpkg 工具链、`VCPKG_TARGET_TRIPLET=x64-windows-webkit`、overlay-triplets）。

**M1 完成（能截图）**：`shotcli --html test.html --out out.png --width 640 --height 400` → 640×400 RGBA PNG，退出码 0。渐变卡片/圆角/绿点/CJK/emoji 全部正确渲染。

**M1 打通过程中踩到并已解决的关键坑（未来会话必读）**：
1. **主题符号缺失**：`RenderTheme/Theme/ScrollbarTheme::singleton` 的定义整体包在 `#if USE(THEME_ADWAITA)` 内。Win 端口用 Adwaita 主题，故 `OptionsShot.cmake` 必须 `SET_AND_EXPOSE_TO_BUILD(USE_THEME_ADWAITA ON)`，否则链接期缺三个 singleton。
2. **dwrite 系统库**：`FontCacheSkiaWin` 用 `DWriteCreateFactory`。WebCore 是 OBJECT 库，其 PRIVATE 系统库依赖**不传递**给消费者，须在 `shot/CMakeLists.txt` 的 `shotcli_LIBRARIES` 显式加 `dwrite`。
3. **RunLoop 双初始化崩溃**：`WTF::initializeMainThread()` 内部已调 `RunLoop::initializeMain()`；`ShotGlobal::initialize` 不可再调，否则 `RELEASE_ASSERT(!s_mainRunLoop)` 崩。
4. **LoaderStrategy 不能为 nullptr**：`Page::firstTimeInitialization()` 会解引用 `platformStrategies()->loaderStrategy()`（调 `addOnlineStateChangeListener`）。已在 `ShotPlatformStrategies.cpp` 提供最小 `ShotLoaderStrategy` 桩（29 个纯虚全实现；带 `CompletionHandler` 的方法必须回调否则析构断言）。M2 用 curl 直驱替换。
5. **进程退出 teardown 崩溃**：正常退出时 `ThreadGlobalData::~ThreadGlobalData`→`FontCache`→`Font::~Font` 再度访问 `threadGlobalData()`→重建→`MainThreadSharedTimer` 断言崩。WebCore 线程级单例被设计为**进程退出时泄漏**，不支持干净静态析构。`cli/main.cpp` 在写完 PNG（已 flush 落盘）后 `std::_Exit(0)` 硬退出，跳过一切静态析构/atexit。**M2 起 C ABI/libshot 场景（同进程多次 render、不能硬退出）需另找干净收尾方案**（如每次 render 后不销毁线程全局、复用 Page，或显式 leak）。

**构建/重配（务必用脚本 `scripts/build-shot.ps1`，避免 cache-wipe 后手工补参数）**：
- 增量编译（只改了 `shot/` 源）：`build-shot.ps1 -Build`。
- 改了任何 `*.cmake` 或 ninja 自动重配擦了缓存后：`build-shot.ps1 -Configure -Build`（内含全部 `-D`：PORT、MinSizeRel+full LTO、vcpkg 工具链+triplet+overlay、`CMAKE_PREFIX_PATH` 指向 vcpkg installed、以及 `CMAKE_C/CXX_FLAGS_MINSIZEREL=/MD /O1 /DNDEBUG`；**缺 `/DNDEBUG` 会开断言，触发 C_LOOP 下 `JSDOMGlobalObject` 编译中断**）。脚本自动 vcvarsall + 把 LLVM+Ruby 塞进 PATH。
- 运行需把 `WebKitBuild/vcpkg_installed/x64-windows-webkit/bin`（ICU/Skia/curl 等 DLL）加进 PATH。

**已补齐**：发布构建已启用 MinSizeRel/full LTO/REF+ICF；远程 URL、外链资源、Cookie、超时状态机、WebP、XML/XSLT/MathML 回归均通过。当前基线见第 7 节 M2 行。
