# 上游对齐基线

## 当前基线

- 上游仓库：https://github.com/WebKit/WebKit
- 对齐提交：`9841b6f9f3840e5dc86f5d1097b73b929953be7b`
- 提交时间：2026-07-13 00:33:13 -0700
- 提交主题：`ipc/loadping-firstpartyforcookies-message-check.html` is constant failure with assertions enabled（https://bugs.webkit.org/show_bug.cgi?id=318436）

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
