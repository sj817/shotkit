# 架构

ShotKit 的定位、已拍板的核心决策、代码地图、嵌入库设计与 C ABI。
这一份是**规范**，改动很少；进度与实测数据在 [CHANGELOG.md](CHANGELOG.md)，
体积相关的决策与账本在 [size-ledger.md](size-ledger.md)。

## 1. 项目定位

本仓库是 WebKit 的 fork。目标产物 **ShotKit**：一个裁切到极限的纯静态截图内核——

- **输入**：HTML 字符串 / 本地 HTML 文件 / 远程 URL
- **输出**：PNG / WebP（有损或无损）字节
- **形态**：无头（headless）、单进程、跨平台（Windows / Linux / macOS）
- **交付**：C ABI 动态库 `libshot` + 命令行工具 `shotcli`，供 Node / Python / Go 绑定
- **体积是一等目标**：产物追求极致小。任何新增依赖/特性都要回答"值多少 KB"；体积化清单见 [size-ledger.md](size-ledger.md)，每个里程碑都要记录体积基线

**这不是一个浏览器。** 明确不做：JS 执行（页面脚本永不运行）、视频/音频、WebGL/WebGPU、Web Inspector、双进程架构、窗口系统、用户交互。它是一个"HTML/CSS → 像素"的确定性渲染器。

**工作模式：快照裁切（snapshot fork），不再跟进上游。** 项目已决定放弃 rebase 上游同步，只对准两个目标：**能截图** + **二进制极致小**。因此：
- 允许直接编辑上游源码来减小体积（删 `Sources.txt` 行、桩化文件、裁 IDL 清单等），不再要求改动全落在新增文件里。
- 但**仍优先把逻辑集中在新端口 + `shot/`**——不是为了 rebase，而是为了改动可追踪、可回滚、心智负担低。对上游源文件的每一处删改，登记到 [`upstream-sync/deviations.md`](../upstream-sync/deviations.md)（现在它是"改了什么"的账本，不再是"待还的债"）。
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

### 3.1 端口与产品代码的文件布局

```
Source/cmake/OptionsShot.cmake              # 端口选项（开关矩阵见 build-options.md）
Source/PlatformShot.cmake                   # 被 Source/CMakeLists.txt 自动 include，挂 shot/ 子目录
Source/bmalloc/PlatformShot.cmake           # 各层平台文件，仿对应 PlatformPlayStation.cmake / PlatformWin.cmake
Source/WTF/wtf/PlatformShot.cmake
Source/JavaScriptCore/PlatformShot.cmake
Source/WebCore/PAL/pal/PlatformShot.cmake
Source/WebCore/PlatformShot.cmake
Source/WebCore/ShotPruning.cmake            # WebCore 源/IDL 裁剪入口

shot/
├── kernel/                                 # C++ 内核（类设计见第 5 节）
│   ├── ShotGlobal.{h,cpp}                  # 进程级一次性初始化、主线程绑定
│   ├── ShotPage.{h,cpp}                    # Page 生命周期 + 渲染状态机
│   ├── ShotPlatformStrategies.{h,cpp}      # PlatformStrategies 四个工厂
│   ├── ShotLoaderStrategy.{h,cpp}          # 网络接入缝 + 主资源抓取
│   ├── ShotCurlResourceLoader.{h,cpp}      # [Win/Linux] CurlRequestClient → ResourceLoader 数据泵
│   └── ShotSession.{h,cpp}                 # ephemeral NetworkStorageSession + 内存 CookieJar
├── capi/
│   ├── shot.h                              # C ABI 公开头（见第 6 节）
│   └── shot.cpp
├── cli/
│   └── main.cpp                            # shotcli（含 --serve JSONL 常驻模式）
├── config.h
└── degenerate-bindings.txt                 # 退化绑定接口清单（构建输入）
```

> 第 5.2 节列出的 `ShotFrameLoaderClient` / `ShotChromeClient` /
> `ShotProgressTrackerClient` / `ShotNetworkingContext` **最终没有实现**：
> M2 改走「curl 直接抓主资源喂 DocumentWriter」的简化路线，绕开了导航策略机制，
> 非 iframe 页面根本不触发那几个坏方法。iframe 支持仍是已知限制。

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
