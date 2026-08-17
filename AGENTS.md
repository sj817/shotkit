# AGENTS.md — ShotKit：WebKit 纯静态截图内核

> 本文件是索引与当前状态，任何会话开始实施前先读它，再按需要展开下面的文档。
> 方案定稿日期：2026-07-13。基线：WebKit 上游快照（约 WPE 2.53.3，2026-07）。

## 这是什么

本仓库是 WebKit 的 fork。目标产物 **ShotKit**：一个裁切到极限的纯静态截图内核。

- **输入**：HTML 字符串 / 本地 HTML、XHTML、XML 文件 / 远程 URL
- **输出**：PNG / WebP（有损或无损）字节
- **形态**：无头、单进程、跨平台（Windows / Linux / macOS）
- **交付**：C ABI 动态库 `libshot` + 命令行 `shotcli` + `@shotkit/node`

**这不是一个浏览器。** 明确不做：JS 执行（页面脚本永不运行）、视频/音频、
WebGL/WebGPU、Web Inspector、双进程架构、窗口系统、用户交互。
它是一个「HTML/CSS → 像素」的确定性渲染器。

**两个目标压倒一切：能截图 + 二进制极致小。** 任何新增依赖或特性都要先回答
「值多少 KB」。

**工作模式：快照裁切（snapshot fork）。** 已放弃 rebase 上游，允许直接编辑上游源码
来减小体积；但每一处删改都要登记到
[`upstream-sync/deviations.md`](upstream-sync/deviations.md)，
且逻辑优先集中在端口（`PORT=Shot`）与 `shot/`，为的是可追踪、可回滚。

## 当前状态

**M0 + M1 + M2 + M3 + M4 已完成。** Windows x64、Linux x64/arm64 与 macOS x64/arm64
在 hosted CI 全绿：PNG/WebP、无脚本网络闭包、C ABI 导出面、可重定位 CLI 与发布归档
全部通过；macOS 另通过内部链接完整性、CFNetwork 与 XML/XSLT 回归。

M5（交付硬化）进行中。基于 C API 的进程内 `shot.node`、Node 专用线程 FIFO 与六平台
构建/发布接线已进入实现阶段，完整编译和 macOS 非系统主线程验证以 hosted CI 为准。
**已知限制**：不支持 iframe、Node `worker_threads` 多 isolate。

明细、实测数据与踩坑记录见 [docs/CHANGELOG.md](docs/CHANGELOG.md)。

## 核心架构决策（已拍板，不要重新讨论）

| 决策点 | 结论 | 一句话理由 |
|---|---|---|
| JS 引擎 | **保留 JSC 但裁到最小**：`ENABLE_C_LOOP=ON` 纯 LLInt 解释器（自动关掉全部 JIT/DFG/FTL/WASM）+ 设置层禁死脚本执行 | 完全移除不可行，见 architecture.md 的证据链 |
| 图形后端 | Windows/Linux = **Skia 纯 CPU 软光栅**（vendored，`Source/ThirdParty/skia`）；macOS = **CoreGraphics/CoreText** | WebKit 树内不存在 macOS+Skia 接线；接受平台间像素差异 |
| 网络栈 | Windows/Linux = **curl + OpenSSL**；macOS = **CFNetwork** | curl 后端本质跨平台（Win/PlayStation 端口先例）；macOS 换 curl 会迫使修改上游几十个 .mm |
| 代码组织 | **新自定义端口 `PORT=Shot`**，蓝本 = PlayStation 端口；允许直接改上游源码（快照模式） | 端口机制按文件名自动挂载；改动登记到偏离清单即可 |
| 进程模型 | **单进程直嵌 WebCore**，不编译 `Source/WebKit` 双进程层 | WebCore 内部的 SVGImage 就是现成的单进程自嵌入模板 |
| 事件循环 | 各平台用 WTF 默认（Win 消息泵 / mac CFRunLoop / Linux Generic） | 都是官方走过的组合；mac 的 CFNetwork/CoreText 需要 CFRunLoop |
| 链接形态 | bmalloc/WTF/JSC/PAL/WebCore 全部 **OBJECT 库**静态汇入 `libshot`（SHARED，只导出 C ABI） | 仿 `OptionsPlayStation.cmake` + `ENABLE_STATIC_JSC` |
| 体积策略 | **MinSizeRel + LTO + section GC + 符号全隐藏 + 特性最小集 + 依赖裁剪**，体积回归纳入 CI | 静态汇入 + 只导出 C ABI 让链接器能做全程序死代码消除 |

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/conventions.md](docs/conventions.md) | **工作约定与提交规范** —— 动手前必读 |
| [docs/architecture.md](docs/architecture.md) | 定位、决策证据链、代码地图、嵌入库设计、C ABI、风险登记 |
| [docs/build-options.md](docs/build-options.md) | `OptionsShot.cmake` 开关矩阵、Windows 构建速查 |
| [docs/size-ledger.md](docs/size-ledger.md) | 体积极致化清单、激进裁切（含「查过但不做」）、各里程碑体积基线 |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | 实施进度：做了什么、实测数据、踩过的坑 |
| [docs/getting-started.md](docs/getting-started.md) | 拿到产物怎么用、怎么从源码构建 |
| [docs/language-bindings.md](docs/language-bindings.md) | C ABI 与 JSONL 常驻协议（跨语言调用的规范源） |
| [upstream-sync/](upstream-sync/) | 上游同步流程、基线提交、**上游偏离清单** |

## 仓库布局

```
shot/       内核 kernel/、C ABI capi/、CLI cli/、degenerate-bindings.txt
apps/       node/ = @shotkit/node SDK；benchmark/ = 跨引擎基准
scripts/    build-shot / collect-dist / package-release / slim-icu / release-notes
tests/      fixture 服务器、无脚本网络校验、泄漏 harness
docs/       本索引指向的文档
upstream-sync/  同步手册与偏离清单
Source/     上游 WebKit + 端口粘合（各层 PlatformShot.cmake、ShotPruning.cmake）
```

`Source/` 里只剩两类属于我们的东西：CMake 端口机制按文件名强制要求的
`Platform${PORT}.cmake` 钩子，以及登记在案的上游改动。产品代码全部在 `Source/` 之外。

## 常用命令

```powershell
pwsh scripts/build-shot.ps1 -Configure -Build   # 配置 + 构建（Windows）
pwsh tests/verify_no_script_network.ps1         # 脚本资源零请求回归
pwsh scripts/collect-dist.ps1                   # 收集运行时分发闭包
pwsh scripts/package-release.ps1                # 打发布归档（带体积门槛）
cd apps/node; npm ci; npm run build; npm test   # Node SDK
```
