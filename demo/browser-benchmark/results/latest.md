# ShotKit / Puppeteer / Playwright 三场景基准报告

生成时间：2026-07-14T03:50:04.381Z

每个“引擎 × 场景 × 冷/热”独立截图 3 次，表格取成功样本中的最快结果；三次原始数据完整保存在 JSON 中。

## 场景一：本机 HTTP 静态页

地址：`http://127.0.0.1:51341/`

| 框架 | 引擎 | 版本 | 冷启动最快 ms | 常驻热启动最快 ms | 冷/热比 |
|---|---|---:|---:|---:|---:|
| Puppeteer | Chrome | Chrome/150.0.7871.24 | 1200.1 | 284.3 | 4.22× |
| Puppeteer | Firefox | firefox/152.0.4 | 2192.5 | 118.8 | 18.46× |
| Playwright | Chromium | 149.0.7827.55 | 431.2 | 212.6 | 2.03× |
| Playwright | Firefox | 151.0 | 1398.8 | 263.0 | 5.32× |
| Playwright | WebKit | 26.5 | 3171.5 | 3085.6 | 1.03× |
| ShotKit | WebCore/Skia | shotkit | 186.4 | 91.1 | 2.05× |

## 场景二：公网 example.com

地址：`https://example.com/`

| 框架 | 引擎 | 版本 | 冷启动最快 ms | 常驻热启动最快 ms | 冷/热比 |
|---|---|---:|---:|---:|---:|
| Puppeteer | Chrome | Chrome/150.0.7871.24 | 1248.3 | 503.5 | 2.48× |
| Puppeteer | Firefox | firefox/152.0.4 | 2168.3 | 453.0 | 4.79× |
| Playwright | Chromium | 149.0.7827.55 | 672.4 | 448.2 | 1.50× |
| Playwright | Firefox | 151.0 | 1675.3 | 424.0 | 3.95× |
| Playwright | WebKit | 26.5 | 3377.5 | 3118.5 | 1.08× |
| ShotKit | WebCore/Skia | shotkit | 345.9 | 128.1 | 2.70× |

## 场景三：本地 file:// 页面

地址：`file:///D:/Github/webkit/demo/browser-benchmark/fixtures/local.html`

| 框架 | 引擎 | 版本 | 冷启动最快 ms | 常驻热启动最快 ms | 冷/热比 |
|---|---|---:|---:|---:|---:|
| Puppeteer | Chrome | Chrome/150.0.7871.24 | 1088.8 | 280.5 | 3.88× |
| Puppeteer | Firefox | firefox/152.0.4 | 1729.9 | 169.8 | 10.19× |
| Playwright | Chromium | 149.0.7827.55 | 400.4 | 193.0 | 2.08× |
| Playwright | Firefox | 151.0 | 1374.3 | 306.5 | 4.48× |
| Playwright | WebKit | 26.5 | 3155.6 | 3058.6 | 1.03× |
| ShotKit | WebCore/Skia | shotkit | 158.1 | 66.4 | 2.38× |

## 常驻内存与安装体积

| 框架 | 引擎 | 热进程 RSS MB | 引擎/分发体积 MB |
|---|---|---:|---:|
| Puppeteer | Chrome | 428.0 | 418.7 |
| Puppeteer | Firefox | 809.0 | 335.5 |
| Playwright | Chromium | 163.6 | 415.4 |
| Playwright | Firefox | 535.7 | 327.3 |
| Playwright | WebKit | 68.9 | 166.5 |
| ShotKit | WebCore/Skia | 45.0 | 64.1 |

## 测试口径

- 主机：win32 10.0.26300，Intel(R) Core(TM) i9-14900KF，63.8 GB RAM，Node v22.22.2。
- 截图：1280×800、DPR 1、full-page PNG；页面加载等待条件统一为 `load`。
- 冷启动：每张图启动并关闭一个全新浏览器/ShotKit 进程；操作系统文件缓存保持自然热态。
- 热启动：进程常驻；浏览器每次新建并关闭隔离 Context + Page，ShotKit 每次在同一 renderer 中创建独立页面和网络状态。
- 延迟包含进程启动（仅冷测）、页面加载、布局、光栅化、PNG 编码和磁盘写入。
- `https://example.com/` 使用真实公网，三次取最快用于降低瞬时网络抖动影响，并不消除线路差异。
- RSS 是全部热场景完成后、空闲状态下相对基准进程的整棵子进程树增量；内存采样不在计时区间内。
- 体积为对应浏览器引擎安装目录；ShotKit 为完整 shot-dist。Puppeteer/Playwright 共享的 Node 依赖未分摊到单个引擎。

原始数据见 [latest.json](./latest.json)。
