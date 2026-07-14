# ShotKit / Puppeteer / Playwright benchmark

同一静态页面、同一输出参数下比较：

- Puppeteer：Chrome、Firefox
- Playwright：Chromium、Firefox、WebKit
- ShotKit：`shotcli` 一次性进程和 `--serve` 常驻进程

每一项都测冷启动与热启动。热启动时浏览器进程常驻、每次创建新 Page；ShotKit 进程和 renderer 常驻、每次创建独立页面。

## 安装

需要 Node.js 22.12 或更高版本。

先构建并收集 ShotKit 分发目录，然后安装 Node 依赖和五个浏览器构建：

```powershell
cd D:\Github\webkit
pwsh Source\WebKitShot\build-shot.ps1 -Build
pwsh Source\WebKitShot\tools\collect-dist.ps1
cd demo\browser-benchmark
npm install
npm run install:browsers
```

浏览器放在本目录的 `.browsers/`，不会污染用户全局缓存。

## 运行

```powershell
# 默认：冷启动 5 次、预热 3 次、热启动 15 次
npm run benchmark

# 快速冒烟：冷启动 2 次、预热 1 次、热启动 3 次
npm run benchmark:quick
```

可用环境变量覆盖 ShotKit 路径：

```powershell
$env:SHOTCLI='D:\path\to\shotcli.exe'
$env:SHOT_DIST='D:\path\to\shot-dist'
npm run benchmark
```

输出：

- `output/`：每个引擎最后一次冷/热截图（git ignored）
- `results/latest.json`：逐次原始样本
- `results/latest.md`：可直接阅读的表格报告

## `shotcli --serve` 协议

启动后 stdout 首行是 ready 消息。之后 stdin 每行一条 JSON 请求，stdout 同序返回一行 JSON：

```json
{"id":1,"url":"https://example.com","out":"example.png","width":1280,"height":800,"full_page":true,"format":"png"}
{"id":2,"html_file":"page.html","out":"page.webp","format":"webp","quality":82}
{"op":"shutdown"}
```

每条渲染响应包含 `status`、`bytes` 和 CLI 内部统计的 `duration_ms`。单个请求失败不会退出服务进程。
