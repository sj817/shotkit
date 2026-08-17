# ShotKit 跨语言调用

ShotKit 提供两层稳定入口：

1. `shot.dll` / `libshot.so` / `libshot.dylib` 的 C ABI，适合 Python ctypes/cffi、Go cgo、Rust FFI 等进程内绑定；
2. `shotcli --serve` 的 JSONL 常驻协议，适合不希望处理原生链接和主线程约束的语言。

Node.js 优先使用 `apps/node/` 的 `@shotkit/node`。从 0.2 起它加载静态汇入内核与 C API 的
`shot.node`，在进程内专用线程维护一个 FIFO renderer，返回 Promise 与零临时文件 Buffer，
同时支持 ESM 和 CommonJS。CLI/JSONL 仍是独立、可隔离的通用入口，npm SDK 不再启动它。

## JSONL 常驻协议

启动：

```text
shotcli --serve
```

stdout 首行：

```json
{"ready":true,"protocol":1}
```

每次向 stdin 写入一行：

```json
{"id":1,"url":"https://example.com/","out":"example.png","width":1280,"height":800,"full_page":true,"format":"png"}
```

对应 stdout：

```json
{"id":1,"ok":true,"status":0,"bytes":12345,"duration_ms":92.5}
```

关闭：

```json
{"id":2,"op":"shutdown"}
```

协议保证单进程、单渲染线程顺序执行；调用方可通过 `id` 将响应映射回自己的 Promise/Future。单次请求失败只返回 `ok:false`，不会终止服务进程。

### 请求字段

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `id` | number | 必填 | 回执用；响应原样带回 |
| `op` | string | `render` | 另可取 `shutdown` |
| `url` / `html` / `html_file` | string | 必填其一 | 三选一，多给或不给都报 `SHOT_ERR_INVALID_ARG` |
| `out` | string | 必填 | 输出图像路径 |
| `width` | number | 1280 | 视口 CSS px；决定布局，响应式模板据此断点 |
| `height` | number | 800 | 视口 CSS px；`full_page` 或 `selector` 生效时不参与最终画幅 |
| `scale` | number | 1 | 设备像素比 |
| `full_page` | boolean | false | 按 `contentsSize` 截整页。**只拉高度，不收宽度** |
| `selector` | string | 空 | 裁到该 CSS 选择器命中的**首个**元素，优先于 `full_page` |
| `format` | string | `png` | `png` / `webp` / `webp-lossless` |
| `quality` | number | 80 | 仅 `webp` 有损，0..100 |
| `timeout_ms` | number | 30000 | 加载硬超时 |
| `base_url` | string | 空 | 仅 `html` / `html_file` 模式：解析外链子资源 |
| `mime_type` | string | `text/html` | 显式指定 XML/XHTML 时用 |
| `ua` | string | 空 | 空=默认 UA |
| `allow_file_urls` | boolean | false | 是否允许 `file://` 子资源 |

### selector 与 full_page 的取舍

`full_page` 沿用浏览器语义：把画幅拉到内容高度，宽度仍是 `width`。页面内容窄于视口时（典型如固定宽度的卡片模板），右侧会留下等于差值的空白 —— 这不是缺陷，Puppeteer 与 Playwright 的 `fullPage` 同样如此。

`selector` 对应的是 Puppeteer 的 `elementHandle.screenshot()`：`width` 照常参与布局，但最终画幅取命中元素的边框盒。几何走 WebCore 的 `absoluteBoundingBoxRect(useTransform=true)`，元素身上的 `transform` 与 `zoom` 已折算在内，但后代的阴影或绝对定位 overflow 不会把画幅撑大。

选择器非法、没命中、或命中元素不可渲染（如 `display:none`）时，请求以 `SHOT_ERR_SELECTOR_NOT_FOUND`（状态码 8）失败，`error` 字段给出具体原因。

## Python 最小示例

```python
import json, subprocess

p = subprocess.Popen(
    [r"C:\shotkit\shotcli.exe", "--serve"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE,
    text=True, encoding="utf-8",
)
assert json.loads(p.stdout.readline())["ready"]

p.stdin.write(json.dumps({
    "id": 1,
    "url": "https://example.com/",
    "out": "example.png",
    "full_page": True,
}) + "\n")
p.stdin.flush()
print(json.loads(p.stdout.readline()))

p.stdin.write(json.dumps({"id": 2, "op": "shutdown"}) + "\n")
p.stdin.flush()
p.wait()
```

## 线程与并行

首次成功 `shot_init` 的线程成为进程级 owner；重复初始化只允许该线程。renderer 的创建、
渲染、销毁和错误读取都留在 owner 线程，错误线程返回 `SHOT_ERR_WRONG_THREAD`（create 返回
`nullptr`）。`shot_render_options_default`、`shot_image_free`/`shot_png_free` 可在任意线程调用。

JSONL 把约束隔离在 `shotcli` 进程内；Node SDK 则封装在宿主进程内唯一的原生专用线程和
FIFO 队列里，不阻塞 Node 事件循环。多个 `ShotKit` handle 共享队列，`close()` 只等待当前
handle 已提交的请求；底层线程保留到环境清理。0.2 不支持从 `worker_threads` 加载。
需要故障隔离或真正并行时启动多个 CLI 进程，不要并发调用同一 C ABI renderer。
