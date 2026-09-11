# @pixel.js/shotkit

ShotKit 的原生 Node.js SDK：把 HTML、文件或 URL 直接渲染成 PNG/WebP `Buffer`。页面 JavaScript 永不执行。

`@pixel.js/shotkit` 通过 Node-API 加载预编译的 `shot.node`，图片编码结果直接成为 Node Buffer；没有浏览器子进程、JSONL、临时图片文件、node-gyp 或安装后下载。CLI 与稳定 C ABI 继续通过 GitHub Release 独立分发。

## 安装

```bash
npm install @pixel.js/shotkit
```

<details>
<summary><b>旧包名 <code>@shotkit/node</code>（过渡期继续发布）</b></summary>

从 0.3.1 起，`@shotkit/node` 是 `@pixel.js/shotkit` 的兼容别名：两者同版本号同步发布，安装旧名会自动带上 `@pixel.js/shotkit` 及对应平台包。已有项目无需改动即可继续收到每一个新版本。旧的六个 `@shotkit/<os>-<arch>` 平台包停留在 0.3.0，不再更新。

切换到正式包名：

```bash
npm uninstall @shotkit/node
npm install @pixel.js/shotkit
```

```diff
- import { screenshot } from '@shotkit/node';
+ import { screenshot } from '@pixel.js/shotkit';
```

</details>

npm 会根据 `os`/`cpu` 只安装六个平台包中的一个：Windows、Linux、macOS 的 x64 或 arm64。支持 Node.js 18.18 及以上版本。

## 使用

API 与 [`@pixel.js/shotium`](https://www.npmjs.com/package/@pixel.js/shotium) 同形：同样的函数、选项名和结果形状，换引擎不改调用代码。0.4.0 起旧的 `launch()` / `ShotKit` handle / `screenshotURL` / `screenshotHTML` 不再提供（`@shotkit/node` 别名包同步）。

```ts
import { screenshot } from '@pixel.js/shotkit';

const { image, stats } = await screenshot({
  html: '<main id="card"><h1>Hello ShotKit</h1></main>',
  viewport: { width: 1200, height: 630 },
  selector: '#card',
});
console.log(stats.bytes, stats.timing.render, image);
```

CommonJS 使用相同接口：

```js
const { screenshot } = require('@pixel.js/shotkit');
```

输入二选一：`file`（http(s) URL、`file:` URL 或本地路径）或 `html`（字符串，ShotKit 扩展）。本地文件由 Node 读取，并以文件自身的 URL 作为 base，旁边的相对子资源照常解析；`mimeType` 按扩展名推断（`.xhtml`、`.xml`、`.svg`），也可显式指定。

```ts
await screenshot({ file: 'https://example.com/', fullPage: true });
await screenshot({ html: '<h1>Hello</h1>', type: 'webp', quality: 82 });
await screenshot({ file: './page.xhtml' });
await screenshot({ html: '<div class="card">透明圆角卡片</div>', omitBackground: true });
```

传 `path` 时图片由 Node 写到目标路径，结果里 `image` 为 `null`：

```ts
const { stats } = await screenshot({ html: '<h1>Hello</h1>', path: './out/card.png' });
```

### 选项

| 选项 | 说明 |
| --- | --- |
| `file` | http(s) URL、`file:` URL 或本地路径；与 `html` 二选一 |
| `html` | HTML 字符串（ShotKit 扩展） |
| `viewport` | `{ width, height }`，默认 1280×720 |
| `type` | `png`（默认）、`webp`、`webp-lossless`（扩展）；没有 `jpeg` |
| `quality` | 1–100，默认 90，只对 `webp` 有效，png 传了会报错 |
| `scale` | 设备像素比，0.01–8，默认 1 |
| `fullPage` | 拉到文档高度 |
| `selector` | 只截命中的首个元素；与 `fullPage` 互斥 |
| `omitBackground` | 保留透明像素 |
| `path` | 写文件，`image` 变为 `null` |
| `pageGotoParams` | `{ timeout }` 毫秒，默认 30000；`waitUntil` 接受 `load`/`networkidle`，内核总是等网络静默，两者行为相同 |
| `allowFileAccess` | 为兼容接受并透传；内核只限制 `file:` 主文档导航，本地文件由 Node 读取，旁边的子资源总会加载 |
| `baseURL` / `mimeType` | `html` 或本地文件的基地址 / MIME 类型（扩展） |
| `userAgent` | 本次截图的 UA（扩展）；`start({ userAgent })` 设默认 |

`clip`、`headers`、`cache` 以及未知选项一律抛 `TypeError`，不会被忽略。

### 生命周期

```ts
import { start, status, stop, runtime } from '@pixel.js/shotkit';

start({ userAgent: 'my-app/1.0' }); // 同步：加载 addon、发起内核初始化；不调用则首次 screenshot() 自动启动
status();                           // { running, enginePath, cacheDir: null, cacheActive: false }
await stop();                       // 等在途截图完成；原生线程随进程退出释放，下一次 screenshot() 会重新启动
runtime.running;                    // 也可直接用 Runtime 实例
```

结果 `stats` 是 shotium `CaptureStats` 的子集：`{ bytes, timing: { render, total } }`——`render` 只统计 C API 渲染与编码，`total` 还包含排队、跨线程回传和可选的文件 I/O。选项错误是 `TypeError`；内核失败是 `ShotKitError`（带 C ABI 状态码 `status`）。

## 线程与进程模型

- 一个 Node 进程只有一条 ShotKit 原生渲染线程和 FIFO 队列。
- 并发 Promise 可以同时提交，但会在 WebCore owner 线程串行执行；Node 主事件循环不会被截图阻塞。
- ESM 与 CommonJS 入口各有一份 JS 状态（`runtime`），原生队列是同一条。
- 第一版不支持在多个 `worker_threads` isolate 中重复加载 addon。需要真正并行或故障隔离时，使用多个 Node 子进程，或使用 GitHub Release 中的 `shotcli --serve`。
- 原生崩溃会终止宿主 Node 进程，这是进程内绑定相对于 CLI 隔离模式的固有取舍。

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

`shot.node` 是只调用 C ABI 的薄插件，`libshot` 随平台包一起分发：Windows 与其它 DLL 一样平铺在 `shot.node` 旁，Linux/macOS 在 `lib/`（RPATH `$ORIGIN/lib` / `@loader_path/lib`）。打包成 asar 或类似归档时要把 `lib/` 与 `shot.node` 一起解出（平台包已声明 `preferUnplugged`）。发布流程从六个平台 CI 的 `shotkit-node-<os>-<arch>` artifact staging `shot.node`、`libshot` 和必要动态依赖，再发布平台子包与主包，最后以旧包名 `@shotkit/node` 发布一个同版本的兼容别名包（`tools/legacy-shim.ts` 生成，只依赖并重新导出主包）。`SHOTKIT_NATIVE_PATH` 仅用于仓库测试和自定义构建定位。
