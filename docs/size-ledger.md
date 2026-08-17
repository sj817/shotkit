# 体积账本

体积是一等目标。这里是：极致化清单（做法与预期收益）、激进裁切清单
（含「查过但决定不做」的留档），以及各里程碑的体积基线。

> 纪律：引入任何新依赖、打开任何 `ENABLE_`/`USE_` 开关前，先回答「值多少 KB」；
> 体积跳涨 >5% 必须用 bloaty / link map 归因后才能合入。

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
- [build-options.md](build-options.md) 的开关矩阵是底线；此外**确保默认 OFF 的选项绝不打开**：`ENCRYPTED_MEDIA`、`WEB_AUTHN`、`WEB_CODECS`、`PDFJS`、`MHTML`、`TOUCH_EVENTS`、`SPELLCHECK`、`CONTENT_EXTENSIONS`、`APPLICATION_MANIFEST`、`SERVICE_CONTROLS`、`RESOURCE_USAGE` 等（WebKitFeatures.cmake 中默认即 OFF）。
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
- 每个里程碑完成时记录：`libshot` + `shotcli` 的 strip 后体积（三平台各自），写入本文末尾「里程碑与体积基线」表的对应列。
- 用 `bloaty`（或 MSVC 下 `link /MAP` + 分析）出 per-section/per-symbol 报告，任何一次体积跳涨 >5% 必须归因。
- M5 CI 加体积预算门槛：超预算即红灯。预算数值在 M1 实测后定（先定基线，再谈目标；不预设拍脑袋数字）。

**明确不做的"负优化"**：不要为省体积换 `USE_SYSTEM_MALLOC`（bmalloc/libpas 很小且是 WebKit 性能/安全基座）；不要删 Yarr/LLInt（第 2 节证据链——删了 WebCore 无法链接）；不要动 `editing/`（`Editor` 是 `LocalFrame` 强成员，与 ScriptController 同款结构耦合，砍不动）；不要砍 SVG（截图保真度明显受损）。

### 4.6 激进裁切（快照模式专属，放弃上游同步后新解锁）

> 前提：已放弃 rebase。以下手段都要**直接编辑上游源码**，收益不再"归零于下次同步"。每一处删改登记到"上游偏离清单"。
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


## 里程碑与体积基线

| 里程碑 | 内容 | 验证标准 | 体积基线（strip 后，实测填写） |
|---|---|---|---|
| **M0** Windows 端口骨架 | ALL_PORTS 注册、OptionsShot.cmake（Win 段）、各 PlatformShot.cmake，编译到 WebCore OBJECT 汇总；**体积化编译/链接层全部打开**（MinSizeRel/LTO/gc-sections/visibility，见 4.5①） | 链接出空 main 可执行文件；`jsc` shell（CLoop）能算 `1+1` | — |
| **M1** Win 最小 HTML→PNG ✅ | ShotGlobal/ShotPage + EmptyClients 替换件 + writer 直喂 + snapshotFrameRect + encodeData；子资源仅 data:；Skia 裁到纯 CPU（4.5③） | ✅ `shotcli --html` 截出 640×400 RGBA PNG，退出码 0，CJK/emoji 正常 | 67.4 MB（未优化 Release） |
| **M2** Win 网络化 + 体积 DCE + 硬化 ✅ | Strategies/CurlResourceLoader/NetworkingContext/Session、完成状态机、超时；DCE 三件套 + /O1；ICU 数据与 converter 裁剪；无脚本网络闭包；JSC 地址空间收缩；ANGLE 仅 delay-load 且不分发；斩链二期（JSGlobalObject 创建链五家族全切）+ icuin/sqlite3 双双摘除 | ✅ 网络/WebP/XML/XSLT/7 编码像素/无脚本请求；仅 10 个导出；1000×render RSS 基线 27.1→峰值 29.2 MB、增长 2.1 MB；Shot/JSC reserve 增量 32.6 MiB；**import 表中已无 `icuin77.dll` / `sqlite3.dll`，lldmap 中已无 `JSC::JSGlobalObject::init`** | **shot.dll 27,482,112 bytes**（2026-08-02 T8 实测；T1–T6 的 30,921,216 → −3,439,104 / −11.12%；更早 33,072,128 → 累计 −16.9%）；**shotcli 48,640 bytes**；导出面恒为 10；**Windows x64 运行闭包 40,724,992 bytes / 22 文件**（T1–T6 的 48,200,704 / 24 文件 → −7,475,712 / −15.51%；构成：shot.dll −3,439,104、icuin77.dll −2,998,272、sqlite3.dll −1,038,336）；无运行时解压或缓存 |
| **M3** Linux ✅ | OptionsShot Linux 段（Fontconfig/FreeType/Generic RunLoop）；Ubuntu CI 固定字体包；full LTO 构建与发布闭包 | ✅ Ubuntu 24.04 hosted CI：PNG/WebP/网络/无脚本/ABI/RPATH/发布包通过（run 29687395019） | full LTO strip：`libshot.so` **48,999,400 bytes**，`shotcli` **35,296 bytes**；xz **12,217,272 bytes** |
| **M4** macOS ✅ | mac 段（CG/CT/CFNetwork/ResourceHandle 路径）；LoaderStrategy 的 mac 分支；静态 libwebp 输出 | ✅ macOS 15 arm64 hosted CI：内部链接、PNG/WebP、CFNetwork、无脚本、XML/XSLT、ABI/RPATH/发布包通过（run 29687395027） | 非 LTO strip：`libshot.dylib` **41,069,504 bytes**，`shotcli` **57,192 bytes**；xz **9,540,040 bytes** |
| **M5** 交付硬化（进行中） | ABI 线程所有权与零复制；静态汇入 C API/WebCore 的 `shot.node`；Node 专用线程 FIFO；六平台 npm 子包；鲁棒性与泄漏回归；**CI 体积预算门槛**（4.5④） | 同一 N-API v8 产物通过 Node 18.18/20/22/24；六平台真实 smoke；addon/CLI 确定性 fixture 逐字节一致；1000 次 RSS/线程/句柄不线性增长 | 等 hosted CI 填写；完整 `.node` 运行闭包相对对应 CLI 闭包增长 >5% 必须归因 |

### 上游同步 2026-08-15（`9841b6f9` → `41d0d5bc`，约一个月）的体积对账

六平台发布包相对同步前（同布局、同流程，PR#1 的 `88d64dce19`）：

| 平台 | 同步前 tar.xz | 同步后 tar.xz | 变化 |
|---|---|---|---|
| linux-x64 | 9,127,520 | 9,199,392 | +0.79% |
| linux-arm64 | 8,221,518 | 8,287,618 | +0.80% |
| macos-x64 | 9,609,060 | 9,685,764 | +0.80% |
| macos-arm64 | 8,138,714 | 8,238,802 | +1.23% |
| windows-x64 | 11,453,558 | 11,513,322 | +0.52% |
| windows-arm64 | 10,616,708 | 10,667,536 | +0.47% |

`shot.dll` 27,479,040 → 27,649,024（+0.62%），Windows x64 运行闭包 25 文件 / 38.95 MiB。
全部在 5% 门槛内，属一个月上游代码自然增长。

**过程中拦下一次真回归**：先跑出来的 Windows 数是 +8.08%（x64）/ +7.46%（arm64），
其余四平台正常。归因到符号级——分发闭包多了 `icuin77.dll`，而 `shot.dll` 对它
只有**一个**导入符号 `udat_close`：`IntlDateTimeFormat` 那几个
`std::unique_ptr<UDateFormat>` 成员的析构器，被 JSCell 静态方法表取地址钉住
（与偏离清单里 ShadowRealm 那条同机制）。判据是「只有析构器符号」——Intl 日期
格式化真活着的话 `udat_open`/`udat_format`/`udatpg_*` 会一起出现在导入表里，实测
没有。算术也对得上：解压后 +3.00 MiB = icuin77.dll 2.86 + shot.dll 0.16。
这 2.86 MiB 正是 M2「斩链二期」消掉过的那一份，被上游 Temporal 重构带了回来。

修法沿用 M2 对 ANGLE 的既有先例（链接期可达、运行期不可达 ⇒ 延迟加载且不分发）：
`libshot` 加 `/DELAYLOAD:icuin<N>.dll`、`collect-dist.ps1` 的 `$unusedDelayLoads`
加 `icuin*.dll`。DLL 名由 `ICU_VERSION` 推导且取不到即 `FATAL_ERROR`，避免 ICU
升版后 `/DELAYLOAD` 静默失效、这 2.86 MiB 悄悄回到包里。

> 教训：**`shot.dll` 本体的体积是健康的（+0.62%），问题全在分发闭包的文件数上**。
> 只盯主二进制会漏掉这类回归——对账要同时看 `extracted directory: N files` 那一行。

**为什么从 Windows 起步**：开发机是 Windows；Win 官方端口本就是 curl+OpenSSL+Skia+HarfBuzz+DirectWrite 的活跃 CI 组合，OptionsShot 的 Win 段基本是 OptionsWin.cmake 的减法；WebKitRequirements 预构建包一次解决全部系统依赖。
