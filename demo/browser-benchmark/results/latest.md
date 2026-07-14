# ShotKit / Puppeteer / Playwright 基准报告

生成时间：2026-07-14T02:10:08.189Z

| 框架 | 引擎 | 版本 | 冷启动中位数 ms | 冷启动 P95 ms | 热启动中位数 ms | 热启动 P95 ms | 冷/热加速比 | 热进程 RSS MB | 引擎/分发体积 MB |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Puppeteer | Chrome | Chrome/150.0.7871.24 | 1179.8 | 2039.3 | 283.6 | 333.6 | 4.16× | 444.0 | 418.7 |
| Puppeteer | Firefox | firefox/152.0.4 | 2260.3 | 6472.9 | 156.8 | 256.3 | 14.41× | 872.0 | 335.5 |
| Playwright | Chromium | 149.0.7827.55 | 448.9 | 865.8 | 215.9 | 221.3 | 2.08× | 166.9 | 415.4 |
| Playwright | Firefox | 151.0 | 1439.2 | 2018.7 | 271.6 | 916.3 | 5.30× | 544.9 | 327.3 |
| Playwright | WebKit | 26.5 | 3404.7 | 3447.9 | 3260.5 | 3483.5 | 1.04× | 75.1 | 166.5 |
| ShotKit | WebCore/Skia | shotkit | 186.5 | 280.7 | 92.5 | 94.6 | 2.02× | 40.2 | 64.1 |

## 测试口径

- 主机：win32 10.0.26300，Intel(R) Core(TM) i9-14900KF，63.8 GB RAM，Node v22.22.2。
- 页面：本机 HTTP，1280×800、DPR 1、full-page PNG；静态 HTML/CSS/SVG/WebP/MathML，不含 JavaScript 和 iframe。
- 冷启动：每张图启动并关闭一个全新浏览器/ShotKit 进程，共 5 次；操作系统文件缓存保持自然热态。
- 热启动：进程常驻；浏览器每次新建并关闭隔离 Context + Page，ShotKit 每次在同一 renderer 中创建独立页面和网络状态，共 20 次，另有 3 次不计入预热。
- 延迟包含页面加载、布局、光栅化、PNG 编码和磁盘写入。热启动不包含常驻进程的首次启动。
- RSS 是热测试完成后、空闲状态下相对基准进程的整棵子进程树增量；内存采样不在计时区间内。
- 体积为对应浏览器引擎安装目录；ShotKit 为完整 shot-dist。Puppeteer/Playwright 共享的 Node 依赖未分摊到单个引擎。

原始数据见 [latest.json](./latest.json)。
