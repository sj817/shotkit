# @shotkit/node

ShotKit 的 Node.js SDK。它启动一个长期驻留的 `shotcli --serve` 子进程，通过 JSONL 协议提交截图任务，因此：

- 不需要 node-gyp、Visual Studio 或 N-API 二进制适配；
- ESM `import` 与 CommonJS `require` 都可用；
- 每个 `ShotKit` 实例只冷启动一次，后续请求走热进程；
- API 返回 `Buffer`，也可以同时写入指定文件；
- 并发 Promise 会在 ShotKit 的渲染线程上安全串行执行。

跨平台通过平台子包分发：`@shotkit/node` 本体是纯 JS，二进制运行时放在 6 个带 `os`/`cpu` 限制的可选依赖里（`@shotkit/win32-x64`、`@shotkit/win32-arm64`、`@shotkit/linux-x64`、`@shotkit/linux-arm64`、`@shotkit/darwin-x64`、`@shotkit/darwin-arm64`），npm 安装时只会落下与当前平台匹配的那一个。

## 安装与使用

```bash
npm install @shotkit/node
```

ESM：

```js
import { launch } from '@shotkit/node';

const shot = await launch();
try {
  const result = await shot.screenshotURL('https://example.com/', {
    width: 1280,
    height: 800,
    fullPage: true,
    outputPath: 'example.png',
  });

  console.log(result.bytes, result.durationMs, result.data);
} finally {
  await shot.close();
}
```

CommonJS：

```js
const { launch } = require('@shotkit/node');

(async () => {
  const shot = await launch();
  try {
    const { data } = await shot.screenshotHTML('<h1>Hello from Node</h1>', {
      width: 640,
      height: 360,
      format: 'webp',
      quality: 82,
    });
    // data 是 Buffer，可直接交给 HTTP response / S3 / sharp 等后续处理。
  } finally {
    await shot.close();
  }
})();
```

本地文件：

```js
const result = await shot.screenshotURL('file:///D:/pages/report.html', {
  allowFileURLs: true,
  fullPage: true,
});
```

## API

```ts
const shot = await launch({
  executablePath?: string,
  env?: NodeJS.ProcessEnv,
  launchTimeoutMs?: number,
});

await shot.screenshot({ url | html | htmlFile, ...settings });
await shot.screenshotURL(url, settings);
await shot.screenshotHTML(html, settings);
await shot.close();
```

主要 settings：`outputPath`、`format: 'png' | 'webp' | 'webp-lossless'`、`quality: 0..100`、`width`、`height`、`scale`、`fullPage`、`timeoutMs`、`baseURL`、`userAgent`、`mimeType`、`allowFileURLs`。

结果字段：

- `data: Buffer`：编码后的图片；
- `bytes`：ShotKit 报告的编码大小；
- `durationMs`：ShotKit 内部渲染、编码与写文件耗时；
- `elapsedMs`：Node 端完整往返时间，额外包含读取 Buffer；
- `outputPath`：指定输出路径时返回其绝对路径。

## 开发、测试、发布

```powershell
cd apps\node   # 仓库根目录下
npm install
npm run typecheck

# 把本地 Windows 构建产物装入 npm/win32-x64/（平台子包骨架），然后跑集成测试
npm run stage:win
npm test
```

运行时解析顺序：`launch({ executablePath })` > 环境变量 `SHOTKIT_EXECUTABLE` > 已安装的 `@shotkit/<platform>-<arch>` 子包 > 仓库内 `npm/<platform>/` 已 staging 的运行时 > `WebKitBuild/shot-dist`。

发布走 `.github/workflows/publish.yml`：构建 6 个平台运行时 → `tools/stage-platform.ts` 装入各子包 → `tools/sync-versions.ts` 统一版本并注入 optionalDependencies → 经 npm Trusted Publishing(OIDC)免 token 发布。仓库里的 package.json 刻意不含 optionalDependencies(子包未发布前会破坏 `npm ci`),只有发布出去的 manifest 携带。
