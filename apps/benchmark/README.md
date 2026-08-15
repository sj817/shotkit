# ShotKit / Puppeteer / Playwright benchmark

TypeScript ESM + `tsx` 驱动的可重复浏览器基准，比较：

- Puppeteer：Chrome、Firefox
- Playwright：Chromium、Firefox、WebKit
- ShotKit：`shotcli` 一次性进程和 `--serve` 常驻进程

测试包含三个场景：

- 本机 HTTP 静态 fixture（HTML/CSS/SVG/WebP/MathML）
- 公网 `https://example.com/`
- 本地 `file://` 页面与同目录外链 CSS

每个“引擎 × 场景 × 冷/热”截图三次，报告取成功样本中的最快值，同时在 JSON 中保留全部原始数据。热启动时浏览器进程常驻、每次创建隔离 Context + Page；ShotKit 进程和 renderer 常驻、每次创建独立页面和网络状态。

## 安装

需要 Node.js 22.12 或更高版本。

先构建并收集 ShotKit 分发目录，然后安装 Node 依赖和五个浏览器构建：

```powershell
cd <仓库根目录>
pwsh scripts\build-shot.ps1 -Build
pwsh scripts\collect-dist.ps1
cd apps\benchmark
npm install
npm run install:browsers
```

浏览器放在本目录的 `.browsers/`，不会污染用户全局缓存。

## 运行

```powershell
# 类型检查
npm run typecheck

# 默认：三个场景；每个冷/热组合各截图 3 次并取最快
npm run benchmark

# 快速冒烟：每个组合只跑 1 次
npm run benchmark:quick

# 只跑一个场景
npx tsx benchmark.ts --scenario example-com --trials 3
```

可选场景 ID：`fixture-http`、`example-com`、`local-file`。

可用环境变量覆盖 ShotKit 路径：

```powershell
$env:SHOTCLI='D:\path\to\shotcli.exe'
$env:SHOT_DIST='D:\path\to\shot-dist'
npm run benchmark
```

输出：

- `output/`：每次截图及每组最快截图（git ignored）
- `results/latest.json`：逐次原始样本
- `results/latest.md`：可直接阅读的表格报告

## `shotcli --serve` 协议

基准脚本用常驻模式测「热请求」耗时——启动后 stdin 每行一条 JSON 请求，stdout 同序返回一行：

```json
{"id":1,"url":"https://example.com","out":"example.png","width":1280,"height":800,"full_page":true,"format":"png"}
```

协议的完整定义（ready 消息、全部字段、错误语义）见
[docs/language-bindings.md](../../docs/language-bindings.md)，那里是规范源。
