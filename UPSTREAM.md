# 上游对齐记录

## 当前对齐的上游提交

- 上游仓库:https://github.com/WebKit/WebKit
- 对齐提交:`9841b6f9f3840e5dc86f5d1097b73b929953be7b`
- 提交时间:2026-07-13 00:33:13 -0700
- 提交主题:`ipc/loadping-firstpartyforcookies-message-check.html` is constant failure with assertions enabled(https://bugs.webkit.org/show_bug.cgi?id=318436)

`shotkit` 分支中该提交之上的 `[ShotKit]` 系列提交为本项目自有改动。

与上游同步时,以该哈希为基点查看差异:

```sh
git fetch upstream main
git log 9841b6f9f3840e5dc86f5d1097b73b929953be7b..upstream/main
```

## shotkit 分支历史截断说明(2026-07-26)

为缩减仓库体积(clone 曾达约 12 GB),`shotkit` 分支历史被截断为最近 100 个提交,更早的约 31.6 万条上游历史已从远程移除;`upstream-sync` 分支已删除。文件内容未受影响。

- 截断前分支顶端:`89b0de443686cbbe5b18fc2756c42d8564e35168`
- 截断点(新根提交对应的原提交):`9a1d07cb008c71897765c522623f89b63287866a`
- 截断后分支顶端:`ad9df8dd39ca525466f2565a85e16db386f61a11`
- 截断后的历史中提交哈希已全部改变,原哈希可在上游仓库中查询
- 完整历史备份保存在本地引用 `refs/backup/shotkit-full-20260726`(仅本地,未推送)
