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

## 6. 三类隐性断裂（不会以冲突形式出现）

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
