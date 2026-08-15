# 工作约定

面向在这个仓库里干活的人和 AI。

1. **动手前先读 [AGENTS.md](../AGENTS.md)**，它是索引与当前状态；再按需要读本目录下的
   [architecture.md](architecture.md) / [build-options.md](build-options.md) /
   [size-ledger.md](size-ledger.md)。完成一个里程碑就更新 AGENTS.md 的状态行，
   并在 [CHANGELOG.md](CHANGELOG.md) 追加一条。
2. **允许改上游源码，但每一处都要登记**到
   [`upstream-sync/deviations.md`](../upstream-sync/deviations.md)（文件、改了什么、为什么）。
   快照模式下这是「改了什么」的账本，也是同步上游时的冲突地图。
   优先仍把逻辑放进新端口 / `shot/`，纯粹为了可追踪、可回滚。
3. 删源码/桩化前先量化（bloaty 占比），收益 KB 级的不值当为它引入编译不稳定；
   文档里引用的行号仅为定位锚点，以符号名/函数名为准。
4. 新增代码风格遵循 WebKit 上游（WTF 智能指针、`_s` 字符串字面量、无异常）；
   `shot/` 内部可用 C++ 标准库但边界处转换为 WTF 类型。
5. 测试 fixture 放 `tests/`，golden 图按平台分目录（Win/Linux 同 Skia 可共享，mac 独立）。
6. **体积纪律**：引入任何新依赖、打开任何 `ENABLE_`/`USE_` 开关前，先回答「值多少 KB」；
   里程碑完成必须更新 [size-ledger.md](size-ledger.md) 的体积基线；
   体积跳涨 >5% 必须用 bloaty 归因后才能合入。
7. **提交规范（强制）**：提交信息标题必须为 `<type>: <中文标题>`，
   type ∈ `feat|fix|perf|refactor|build|ci|docs|test|chore|revert`，可带作用域 `type(scope):`，
   冒号后一个空格；标题必须含中文、≤72 字符（建议 ≤50）、结尾不加句号；正文自由。
   git 自动生成的 `Merge `/`Revert `/`fixup! `/`squash! ` 标题豁免，历史英文提交不追溯。
   本地拦截：每个克隆执行一次 `git config core.hooksPath .githooks`（钩子在 `.githooks/commit-msg`）；
   远端由 `.github/workflows/commit-lint.yml` 强制，规则改动必须两处同步。
   示例：`fix(network): 修复子资源重定向后 cookie 丢失`。
8. **同步上游**走 [`upstream-sync/README.md`](../upstream-sync/README.md) 的流程，
   不要试图用 git merge/rebase —— `main` 与上游没有共同祖先。
