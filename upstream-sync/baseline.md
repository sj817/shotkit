# 上游对齐基线

## 当前基线

- 上游仓库：https://github.com/WebKit/WebKit
- 对齐提交：`41d0d5bc00e7a614ba4a23052ae65d3935ad646e`
- 提交时间：2026-08-14 20:29:11 -0700
- 提交主题：Adding a missing null check in WebCore::attributedStringByReplacingRemoteFrameMarkers（https://bugs.webkit.org/show_bug.cgi?id=321810）

这个哈希是整个同步机制的锚点：**我们的树在未改动的文件上逐字节等于该提交**，
所以上游的 diff 可以直接三方应用。改动过的文件全部登记在 [deviations.md](deviations.md)。

同步流程见 [README.md](README.md)。每次同步完成后更新上面的哈希与时间。

## 历史沿革

### 2026-07-26：`shotkit` 分支历史截断

为缩减仓库体积（clone 曾达约 12 GB），`shotkit` 分支历史被截断为最近 100 个提交，
更早的约 31.6 万条上游历史已从远程移除。文件内容未受影响。

- 截断前分支顶端：`89b0de443686cbbe5b18fc2756c42d8564e35168`
- 截断点（新根提交对应的原提交）：`9a1d07cb008c71897765c522623f89b63287866a`
- 截断后分支顶端：`ad9df8dd39ca525466f2565a85e16db386f61a11`
- 截断后的历史中提交哈希已全部改变，原哈希可在上游仓库中查询

### 2026-08-15：本地 `.git` 清理

`main` 是压平过的单根历史，与上游没有共同祖先，靠分支同步的路子已经不成立
（见 README 第 1 节）。因此清掉了只为「留着对照」而存在的引用：

- 删除本地分支 `shotkit`、`upstream-sync`（各含约 31.7 万条上游提交）
- 删除 `upstream` remote（923 个分支 ref）与 4128 个上游 tag，保留 `v0.1.1`/`v0.1.2`
- 删除已并入 `main` 的 `codex/*` 分支与 5 个 `refs/codex/turn-diffs` 检查点

结果：`.git` 12.49 GiB → 1.68 GiB，对象数 6,675,427 → 424,334，
`main` 的 110 个提交与两个发布 tag 的哈希全部不变。

上游内容不再常驻本地——需要时按 README 的配方浅取到仓库外的 scratch 仓。

### 2026-08-15：首次对等同步 `9841b6f9` → `41d0d5bc`

一个月的上游改动，路径域内 7316 个文件。这一轮把流程本身也跑出了三个真问题（都已修进
`prepare.ps1` / `paths.txt`）：

- **补丁缺 `--binary`**：上游有二进制文件（ANGLE 的 `.angledata` 追踪数据），
  `git diff` 不加 `--binary` 只写一行「Binary files differ」，`git apply` 到那里整个失败。
  同时把补丁改成 `git diff --output=` 直接落盘——走 PowerShell 管道会被 `Set-Content`
  改成 CRLF，base85 的二进制 hunk 经不起换行符改写。
- **路径域含已删文件**：`Source/` 下 7 个 `*.xcodeproj/project.pbxproj` 已被本 fork 删除，
  上游对它们的改动会生成永远无法应用的 hunk。
- **范围过宽**：测试套件、其他端口平台层、GStreamer 后端都不参与构建，同步过来纯是噪声，
  已加入排除列表（本轮减掉 194 个文件）。

冲突 **9 个**（预报 40 个——多数上游改动与我们的 hunk 不重叠，三方合并干净过了）：

| 文件 | 处理 |
|---|---|
| `IntlCache.{h,cpp}` | 上游新增 language-epoch 观察者，是平台无关代码，移到我们的 `#if PLATFORM(SHOT)` 之外 |
| `JSNodeCustom.h` | 上游慢路径改名 + 新增 adoptNode 配套函数，同理由一并门控 |
| `RenderElement.{h,cpp}`、`RenderElementStyleInlines.h` | 上游拆成两个函数，偏离延伸到新函数 |
| `Sources.txt` | 上游删了 `JSDatagramsReadableMode.cpp`，我们删的 `JSDatabase*` 保持删除，两边都不要 |
| `CryptoKitShim.swift` | 上游改了参数类型（`WTF.BorrowedBytes`），保留我们加的 `public` |
| `WebKitXcodeSDK.cmake` | 架构分支上游已改为按 `_platform_name` 判断，天然覆盖 Shot，该半偏离注销 |
| `WebKitMacros.cmake` | **偏离整条注销**：上游用等价写法（裸变量名）修掉了同一个空展开问题 |

隐性断裂（补丁干净应用也会踩到，靠 README 第 6 节的检查捞出来）：

- 退化绑定清单：上游删了 23 个 IDL（`SVGPathSeg*` 全家、`DatagramsReadableMode`、
  `WebKitSerializedNode`）→ 清掉悬空条目；新增 25 个 IDL 未收录 → 按清单自己的规则
  （无手写 `JS*Custom*.cpp`、非 fetch/streams 核心）收录 22 个，会生成完整绑定的体积
  回涨就此堵住。
- `ShotPruning.cmake` 的 18 处文件名引用全部仍能解析，未失配。

**补丁应用后又跑了七轮 CI 才全绿**，这部分是本次同步真正的成本所在。七个问题里
本地 Windows 全量构建**一个都碰不到**（它只走 `PlatformWin.cmake` 分支且是 x64）：

| 轮 | 平台 | 问题 | 类别 |
|---|---|---|---|
| 1 | macOS | 上游把各模块 `PlatformMac.cmake` 整体改名为 `PlatformCocoa.cmake`，我们 5 个 `PlatformShot.cmake` 的 `include()` 全失效 | 第 4 类 |
| 2 | macOS | 根 `CMakeLists.txt` 指向的 `swiftc-wrapper.sh` 上游改成 `.py`，而 `Tools/` 不在路径域内 → exit 127 | 第 5 类 |
| 3 | Linux / macOS | `Pasteboard::writeCustomData` 上游加了参数、桩没跟上；`OptionsCocoa` 新增 `-explicit-module-build` 在公开 Xcode 上撞出 Swift 模块环 | 签名漂移 / 工具链 |
| 4 | macOS / Linux | `WEBKIT_OPTION_OWNED_BY_PLATFORM_H` 注销 17 个 ApplePay 子特性；clang 18 对 C++23 的 `-Winvalid-constexpr` 仍按老规则报错 | 第 6、7 类 |
| 5 | macOS | 上游新增的 AX 代码无门控调用 `ChromeClient::showWritingToolsAffordance()` | 第 8 类 |
| 6 | **Windows arm64** | 上游新增无平台限制的 `-DHAVE_PRESERVE_MOST=1`，令 `preserve_most` 在 `aarch64-pc-windows-msvc` 上生效 → `shotcli` 出图 `0xC0000005` | 第 9 类 |
| 7 | Windows | 体积回归 +8.08%（见 [docs/size-ledger.md](../docs/size-ledger.md)） | 体积对账 |

（第 1–6 轮之外还被 community.chocolatey.org 连续 503/504 挂掉两轮，与同步无关；
已把 `winflexbison3` 改成 choco 失败时回落到上游 Release，少一个故障域。）

**三条可复用的结论**：

1. **跨平台 fork 的上游同步，CI 不可替代。** 七个问题全部落在「我们的偏离面 ×
   上游新代码」的交界处，且各自只在一个平台暴露。本地单平台构建从头绿到尾。
2. **排查先做三方对照，再读 diff。** 第 6 轮的 `preserve_most` 是靠
   「Windows x64 过 / **Linux arm64 过** / Windows arm64 崩」把嫌疑从「架构」和「LTO」
   收敛到「OS/ABI」这一维之后才找到的。在 3188 个文件、7.3 万行的补丁里直接找是无界的。
3. **`aarch64-pc-windows-msvc` 是本 fork 最没有上游兜底的一格**——WebKit 上游没有
   Windows ARM64 端口，任何按 `__aarch64__` / `CPU(ARM64)` 门控的新代码，上游都只在
   Darwin/Linux 的 aarch64 上验证过。
