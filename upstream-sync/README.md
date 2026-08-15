# 上游同步手册

> 这份文档是给**执行同步的人或 AI** 看的操作规程。同步基本由 AI 完成，
> 所以每一步都写明「做什么、为什么、怎么判断做对了」，不依赖口口相传的上下文。

同目录下：

| 文件 | 作用 |
|---|---|
| [baseline.md](baseline.md) | 当前对齐的上游提交哈希（同步的锚点），以及历史沿革 |
| [deviations.md](deviations.md) | 上游偏离清单 —— **同步时的冲突地图** |
| [paths.txt](paths.txt) | 同步路径域：上游 diff 只在这些路径内取 |
| [prepare.ps1](prepare.ps1) | 准备 scratch 仓、生成 path-scoped patch、预报冲突文件 |

---

## 1. 为什么不能用 git merge

ShotKit 的 `main` 是压平过的单根历史（根提交 `Initial ShotKit source release`），
和 `upstream/main` **没有共同祖先**：

```sh
git merge-base main upstream/main   # 输出为空
```

没有共同祖先，`git merge` / `git rebase` / `git cherry-pick` 全部失去意义——
三方合并算不出 base，只会退化成「两棵无关的树全文冲突」。

所以「同步上游」在本项目里不是分支合并，而是**路径域的三方补丁重放**：
把上游从基线到目标之间的 diff，当成一个补丁打到我们的快照上。

这套做法能成立，靠的是一个事实：**我们的树在未改动的文件上逐字节等于基线提交**。
`git apply --3way` 因此能对每个 hunk 找到正确的 base，冲突只会出现在我们真正
改过的文件上——也就是 [deviations.md](deviations.md) 里登记的那 108 个。

## 2. 什么叫「对等同步」

不是把上游的东西全搬过来，而是**在我们关心的范围内，与上游保持逐文件对等**：

- **范围对等**：只同步 [paths.txt](paths.txt) 里的路径（PORT=Shot 实际构建的目录）。
  上游对 `Tools/`、`Source/WebKit`、`WebInspectorUI`、`libwebrtc` 的改动与本 fork 无关，
  取进来只会制造噪声和假冲突。
- **内容对等**：范围内未登记偏离的文件，同步后应当**与上游目标提交逐字节相同**。
  这是可验证的不变量，见第 6 步。
- **偏离对等**：登记过的文件不追求字节相同，而是追求**意图仍然成立**——
  逐条复核 deviations.md 的「原因」列。

## 3. 准备 scratch 仓

上游内容不常驻本仓库（那正是 `.git` 曾经 12 GB 的原因）。每次同步临时浅取到**仓库外**：

```powershell
pwsh upstream-sync/prepare.ps1 -TargetRef main
```

脚本做的事（也可手工执行）：

```sh
git init ../webkit-upstream && cd ../webkit-upstream
git remote add origin https://github.com/WebKit/WebKit.git
# 两个互不相连的浅提交即可；git diff 只比树，不需要祖先关系
git fetch --depth=1 --filter=blob:none origin <BASELINE_SHA>
git fetch --depth=1 --filter=blob:none origin main
```

`--filter=blob:none` 让文件内容按需下载，`--depth=1` 不取历史。
两个快照加起来远小于完整 clone。

## 4. 生成 path-scoped patch

```powershell
pwsh upstream-sync/prepare.ps1 -TargetRef main -Patch ../upstream.patch
```

等价于：

```sh
git -C ../webkit-upstream diff <BASELINE_SHA> <TARGET_SHA> -- <paths.txt 的内容> > ../upstream.patch
```

脚本会同时打印**预计冲突的文件**（patch 涉及的文件 ∩ deviations.md 登记的文件）。
先看这份清单再动手——它决定了这次同步的工作量。

## 5. 三方应用

```sh
git checkout -b sync/upstream-<日期>
git apply --3way ../upstream.patch
```

`--3way` 在冲突时会留下标准冲突标记并把文件标为 unmerged。逐个处理：

- **未登记的文件冲突了** → 说明有人改了上游文件却没登记。先补进 deviations.md，再解决。
- **已登记的文件冲突了** → 打开 deviations.md 对应行，按「原因」列判断：
  - 原因仍然成立 → 保留我们的改动，把上游的其余变更合进来；
  - 上游已经提供了等价能力（新开关、新钩子）→ **删掉我们的改动改用上游的**，
    并在 deviations.md 里删除该行、在提交信息里说明；
  - 上游把这块重写了 → 重新实现意图，更新 deviations.md 的「改动」列。

## 6. 隐性断裂（不会以冲突形式出现）

这是最容易漏的部分。补丁干净应用**不等于**同步成功：

1. **上游删/改了 IDL** → [`shot/degenerate-bindings.txt`](../shot/degenerate-bindings.txt)
   里 1700 多个接口名可能出现悬空条目。上游新增的 IDL 也不会自动进入退化清单
   （新接口会以完整绑定形式编译，体积悄悄涨回去）。
   查：把 patch 里 `*.idl` 的增删名单与清单对照。
2. **上游动了 `Source/WebCore/Sources.txt`** → `Source/WebCore/ShotPruning.cmake`
   的裁剪规则可能失配（按文件名排除的条目找不到目标，或新增文件绕过裁剪）。
3. **上游改了导出宏/构建宏** → `SHOT_NO_DLLEXPORT`（`WTF/wtf/ExportMacros.h`、
   `bmalloc/BExport.h`）、`JS_NO_EXPORT`、`SHOT_NO_INSPECTOR`、`SHOT_NO_SCRIPT`
   的分支插入点可能漂移。查：确认这些宏的 `#if` 分支仍在生效位置上。
4. **上游重命名/删除了我们 include 的文件** → 我们自己的文件（各层 `PlatformShot.cmake`、
   `ShotPruning.cmake`）不在补丁里，所以**不会产生冲突**，但它们指向的上游文件可能
   已经不存在了，直到配置期才炸。
   `prepare.ps1 -Verify` 会检查我们端口文件里的每个 `include()` 是否仍能解析。

   > 2026-08-15 首次同步就踩到了：上游把各模块的 `PlatformMac.cmake` 整体重命名为
   > `PlatformCocoa.cmake`（引入 `Cocoa` 端口），我们 5 个 `PlatformShot.cmake` 的
   > `include(PlatformMac.cmake)` 全部失效。Windows 本地构建完全无感——它走
   > `PlatformWin.cmake` 分支——只有 macOS CI 报错。**跨平台的偏离必须靠 CI 兜底。**

5. **同步过来的文件引用了不在路径域内的文件** → 第 4 类的镜像：这次冲突的不是「我们的
   文件指向失效的上游文件」，而是「上游文件指向路径域外的上游文件」。
   查：patch 里新增的 `include`/脚本调用是否落在 `paths.txt` 内。

   > 2026-08-15：根 `CMakeLists.txt`（在域内）把 `CMAKE_Swift_COMPILER` 指向
   > `Tools/Scripts/swift/swiftc-wrapper.sh`，上游把它改成了 `.py`，而 `Tools/`
   > 整体不在域内 → macOS 构建 exit 127。修法是把 `Tools/Scripts/swift` 补进域。

6. **上游把 CMake 特性开关「注销」，改由 `Platform*.h` 按 SDK 判定** → 我们用
   `WEBKIT_OPTION_DEFAULT_PORT_VALUE(... OFF)` 关掉的东西会被悄悄打开。
   查：patch 是否新增/扩充了 `WEBKIT_OPTION_OWNED_BY_PLATFORM_H(...)` 列表。

   > 2026-08-15：`OptionsCocoa.cmake` 用新引入的 `WEBKIT_OPTION_OWNED_BY_PLATFORM_H`
   > 一次注销了 17 个 ApplePay 子特性（`unset(... CACHE)` + 从
   > `_WEBKIT_CONFIG_FILE_VARIABLES` 移除），于是 `cmakeconfig.h` 不再写
   > `#define ENABLE_APPLE_PAY_COUPON_CODE 0`。而 `PlatformEnableCocoa.h` 里这些
   > 子特性挂的是 `HAVE(PASSKIT_*)` 而**不是** `ENABLE(APPLE_PAY)`——父特性关、子特性
   > 开，`ApplePayCouponCodeUpdate.h` 就去引用 `#if ENABLE(APPLE_PAY)` 里才有的
   > `ApplePayLineItem`。上游自己永远碰不到，因为 Cocoa 的 `ENABLE_APPLE_PAY` 是 ON。
   > 修法见 `OptionsShot.cmake` 的 APPLE 分支：`add_definitions` 与
   > `SET_AND_EXPOSE_TO_BUILD` 两份视图都要补齐（前者管 C++，后者管 cmakeconfig.h
   > 与 Swift 平台参数生成）。

7. **上游用上了比我们 CI 工具链更新的语言/编译器语义** → 上游 CI 绿、我们红，且只在
   最旧的那条工具链上红。
   查：编译错误里出现上游未改动过的头文件时，先比对编译器版本再考虑改代码。

   > 2026-08-15：上游给 `LayoutRect::infiniteRect()` 加了 `constexpr`，但它调用的
   > 构造函数不是 constexpr。C++23 的 P2448R2 允许这种写法，clang 据此把
   > `-Winvalid-constexpr` 降为默认忽略——**但那是 clang 19 才做的**。
   > Ubuntu 24.04 自带 clang 18.1.3 仍按老规则报 error，Windows(clang-cl 20) 与
   > macOS(Xcode) 都不报。为一条纯咨询性诊断改上游头文件会变成永久偏离，所以在
   > `OptionsShot.cmake` 里关掉该诊断，并注明 Linux CI 升到 clang 19+ 后可删。

8. **上游 Cocoa 代码漏了特性门控** → 只在 macOS 炸，且上游永远发现不了。
   查：编译错误形如「no member named 'xxx' in 'WebCore::YyyClient'」时，看该成员在头文件里
   的 `#if ENABLE(...)`，再看调用点有没有同样的门控。

   > 根因是本端口的结构性选择：`OptionsShot.cmake` 在 `WEBKIT_OPTION_END()` **之后**才
   > `include(OptionsCocoa)`（只借它的 SDK/工具链配置，特性矩阵仍归 Shot 自己管），
   > 于是 OptionsCocoa 里 **71 个 `WEBKIT_OPTION_DEFAULT_PORT_VALUE(... ON)` 有 68 个
   > 对我们是空操作**。上游 Cocoa 代码是按「这些都开着」写的，只要有一处漏门控就会炸。
   > 这也是**为什么 macOS 是本 fork 最脆弱的平台**——Windows/Linux 端口在上游有真实的
   > 关闭组合被持续构建，Cocoa 没有。
   >
   > 2026-08-15：上游给 AX 新增 `NSAccessibilityShowWritingToolsAction` 分支，无门控地
   > 调用 `ChromeClient::showWritingToolsAffordance()`（声明在 `#if ENABLE(WRITING_TOOLS)`
   > 内）。修法是给调用点补同样的门控并登记进 deviations.md。
   >
   > 补完一处后建议顺手扫同族：把该头文件里同一 `#if` 块内声明的方法全部列出，
   > `git grep` 它们的调用点，逐个回溯所在的 `#if` 栈，确认没有第二处漏网。

9. **上游新增的编译期开关没有平台限制，在上游从不构建的目标三元组上有害** →
   构建全绿、运行期崩溃，是最贵的一类（要跑满一次构建才暴露）。
   查：patch 里新增的 `add_definitions(-DHAVE_*)` / `add_compile_options`，
   看它的启用条件里有没有平台维度；再看被它激活的头文件开关是按什么门控的。

   > **本 fork 独有的目标三元组是 `aarch64-pc-windows-msvc`** —— WebKit 上游没有
   > Windows ARM64 端口，任何按 `__aarch64__` 或 `CPU(ARM64)` 门控的新代码，上游都
   > 只在 Darwin/Linux 的 aarch64 上验证过。这是本 fork 最没有上游兜底的一格。
   >
   > 2026-08-15：上游新增 `if (LTO_MODE AND COMPILER_IS_CLANG) add_definitions(-DHAVE_PRESERVE_MOST=1)`
   > （无平台限制），配合 `pas_utils_prefix.h` / `WTF/Compiler.h` 里的
   > `#if defined(HAVE_PRESERVE_MOST) && HAVE_PRESERVE_MOST && defined(__aarch64__)`，
   > 让 `__attribute__((preserve_most))` 在 Windows ARM64 上生效，`shotcli` 出图时
   > 0xC0000005。三方对照定位：Windows x64 正常（不满足 `__aarch64__`）、
   > **Linux arm64 正常**（同样 `-DLTO_MODE=full`，preserve_most 确实生效且没问题）、
   > 只有 Windows arm64 崩 —— 问题锁在该 ABI 的调用约定实现上。
   > 修法见 `OptionsShot.cmake`：`if (WIN32) remove_definitions(-DHAVE_PRESERVE_MOST=1)`。
   > preserve_most 是纯优化，关掉不影响正确性，且保留了 Linux arm64 的收益。
   >
   > 排查手法值得复用：**先用「哪些平台过、哪些平台崩」做三方对照**，把嫌疑收敛到
   > 单一维度（这里是 OS/ABI，因为架构与 LTO 都被 Linux arm64 排除了），再去读 diff。
   > 直接在 3188 个文件、7.3 万行的 patch 里找是无界的。

**内容对等校验**（第 2 节的不变量）：

```sh
# 范围内、未登记偏离的文件应当与上游目标提交逐字节相同
git diff --name-only <TARGET_SHA> HEAD -- <paths.txt 的内容>
```

输出应当**恰好等于** deviations.md 登记的文件集合。多出来的就是漏登记或误改。

## 7. 验证矩阵

同步不是「编过了」就算完。至少跑完：

```powershell
pwsh scripts/build-shot.ps1 -Configure -Build       # 全新配置 + 构建
pwsh tests/verify_no_script_network.ps1             # 脚本资源零请求
pwsh scripts/collect-dist.ps1                       # 分发闭包
pwsh scripts/package-release.ps1                    # 体积门槛
cd apps/node; npm ci; npm run typecheck; npm run build; npm test
```

- 截图回归：`shotcli` 对多语言混排（CJK + RTL + emoji）页面出图，与同步前像素比对。
- **体积对账**：`shot.dll` 相对同步前跳涨 >5% 必须用 bloaty/link map 归因后才能合入。
  上游新增的子系统很容易悄悄进来。
- 三平台 CI 全绿（推分支触发 windows/linux/macos 三条 workflow）。

## 8. 收尾

1. 更新 [baseline.md](baseline.md) 的哈希、时间、主题为本次的目标提交；
2. 更新 [deviations.md](deviations.md)：删掉不再需要的行，补上新增/改写的行；
3. 在 `docs/CHANGELOG.md` 记一条：目标提交、冲突文件数、体积变化、发现的问题；
4. 删掉 scratch 仓（`../webkit-upstream`）和临时 patch。

## 给 AI 执行者的注意事项

- **不要试图恢复 `upstream` remote 常驻**。那是 12 GB 的来源，且对本项目无用——
  没有共同祖先，本地留着上游分支不会让任何 git 操作变得更容易。
- **不要扩大 paths.txt 的范围**去「顺便同步一下」。范围就是构建闭包，
  多取的每一个路径都是纯噪声。
- **不要在冲突里无脑选上游**。deviations.md 里每一条都是有实测数据支撑的决定
  （多数带体积数字），随手丢掉会让 `shot.dll` 涨几 MB 而没人发现。
- **不要跳过第 6 节**。它是这套流程里唯一不能靠编译器兜底的部分。
- 同步的目标是**能截图 + 二进制极致小**这两条，不是「和上游一致」。
  上游的新特性默认不要，除非它对这两个目标有帮助。
