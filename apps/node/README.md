# @shotkit/node

ShotKit 的原生 Node.js SDK：把 HTML、文件或 URL 直接渲染成 PNG/WebP `Buffer`。页面 JavaScript 永不执行。

`@shotkit/node` 通过 Node-API 加载预编译的 `shot.node`，图片编码结果直接成为 Node Buffer；没有浏览器子进程、JSONL、临时图片文件、node-gyp 或安装后下载。CLI 与稳定 C ABI 继续通过 GitHub Release 独立分发。

## 安装

```bash
npm install @shotkit/node
```

npm 会根据 `os`/`cpu` 只安装六个平台包中的一个：Windows、Linux、macOS 的 x64 或 arm64。支持 Node.js 18.18 及以上版本。

## 使用

```ts
import { launch } from '@shotkit/node';

const shot = await launch();
try {
  const result = await shot.screenshotHTML(
    '<main id="card"><h1>Hello ShotKit</h1></main>',
    { width: 1200, height: 630, selector: '#card' },
  );
  console.log(result.bytes, result.durationMs, result.data);
} finally {
  await shot.close();
}
```

CommonJS 使用相同接口：

```js
const { launch } = require('@shotkit/node');
```

输入三选一：

```ts
await shot.screenshotURL('https://example.com/', { fullPage: true });
await shot.screenshotHTML('<h1>Hello</h1>', { format: 'webp', quality: 82 });
await shot.screenshot({ htmlFile: './page.xhtml', mimeType: 'application/xhtml+xml' });
```

设置 `outputPath` 时仍返回同一个 Buffer，并额外通过 Node 文件 API 写入目标路径：

```ts
await shot.screenshotHTML('<h1>Hello</h1>', { outputPath: './out/card.png' });
```

## 线程与进程模型

- 一个 Node 进程只有一条 ShotKit 原生渲染线程和 FIFO 队列。
- 并发 Promise 可以同时提交，但会在 WebCore owner 线程串行执行；Node 主事件循环不会被截图阻塞。
- 多次 `launch()` 返回独立逻辑 handle，共享底层队列；`close()` 只关闭当前 handle。
- 第一版不支持在多个 `worker_threads` isolate 中重复加载 addon。需要真正并行或故障隔离时，使用多个 Node 子进程，或使用 GitHub Release 中的 `shotcli --serve`。
- 原生崩溃会终止宿主 Node 进程，这是进程内绑定相对于 CLI 隔离模式的固有取舍。

`durationMs` 只统计 C API 渲染与编码；`elapsedMs` 还包含排队、跨线程回传，以及可选的输入/输出文件 I/O。

## 本地开发

```powershell
cd apps/node
npm ci
npm run typecheck
npm run build

# 配置并构建 WebKit 时增加 -NodeAddon
pwsh ../../scripts/build-shot.ps1 -Configure -Build -NodeAddon
$env:SHOTKIT_NATIVE_PATH = '../../WebKitBuild/shot/bin/shot.node'
npm test
```

发布流程从六个平台 CI 的 `shotkit-node-<os>-<arch>` artifact staging `shot.node` 和必要动态依赖，再发布平台子包与主包。`SHOTKIT_NATIVE_PATH` 仅用于仓库测试和自定义构建定位。
