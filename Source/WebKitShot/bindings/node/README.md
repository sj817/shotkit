# @shotkit/node

ShotKit 的 Node.js SDK。它启动一个长期驻留的 `shotcli --serve` 子进程，通过 JSONL 协议提交截图任务，因此：

- 不需要 node-gyp、Visual Studio 或 N-API 二进制适配；
- ESM `import` 与 CommonJS `require` 都可用；
- 每个 `ShotKit` 实例只冷启动一次，后续请求走热进程；
- API 返回 `Buffer`，也可以同时写入指定文件；
- 并发 Promise 会在 ShotKit 的渲染线程上安全串行执行。

当前打包脚本提供 Windows x64 runtime。Linux/macOS 端口完成后可按同样的 `vendor/<platform>-<arch>` 结构加入。

## 安装与使用

```bash
npm install ./shotkit-node-0.1.0.tgz
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

## 开发、测试、打包

```powershell
cd D:\Github\webkit\Source\WebKitShot\bindings\node
npm install
npm run typecheck
npm test

# 把 WebKitBuild/shot-dist 装入 vendor/win32-x64 并生成 tgz
npm run pack:win
```

未携带 vendor runtime 时，可以设置 `SHOTKIT_EXECUTABLE`，或给 `launch({ executablePath })` 传入 `shotcli` 路径。
