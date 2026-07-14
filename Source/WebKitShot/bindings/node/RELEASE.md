# @shotkit/node 0.1.0 — Windows x64

构建日期：2026-07-14

## 交付物

- 文件：`WebKitBuild/releases/shotkit-node-0.1.0-win32-x64.tgz`
- npm 包名：`@shotkit/node`
- 版本：`0.1.0`
- 压缩大小：28,933,067 bytes（27.6 MiB）
- 解压大小：约 67.3 MB
- 文件数：34
- SHA-256：`38FAD2DF615144BBD1BC9759D8CB4D69A7ACA42B2B8782941317252E955A9ECF`
- 生产依赖：0
- 内置 runtime：ShotKit Windows x64（`shotcli.exe` + `shot.dll` + 运行依赖）

## 安装

```powershell
npm install D:\Github\webkit\WebKitBuild\releases\shotkit-node-0.1.0-win32-x64.tgz
```

## 验收

- TypeScript 严格类型检查：PASS
- npm audit（SDK 开发树）：0 vulnerabilities
- 源码测试：4/4 PASS（ESM、CommonJS、并发 PNG/WebP、错误恢复、file URL）
- 全新空目录安装：PASS，生产依赖仅 `@shotkit/node`
- 安装包 ESM：`https://example.com/` → PNG Buffer PASS；HTML → WebP Buffer PASS
- 安装包 CommonJS：HTML → PNG Buffer PASS

vendor runtime 是构建产物，不提交 Git；用 `npm run pack:win` 可从当前 `WebKitBuild/shot-dist` 重建。
