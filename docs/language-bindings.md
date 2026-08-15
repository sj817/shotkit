# ShotKit 跨语言调用

ShotKit 提供两层稳定入口：

1. `shot.dll` / `libshot.so` / `libshot.dylib` 的 C ABI，适合 Python ctypes/cffi、Go cgo、Rust FFI 等进程内绑定；
2. `shotcli --serve` 的 JSONL 常驻协议，适合不希望处理原生链接和主线程约束的语言。

Node.js 优先使用 `apps/node/` 的 `@shotkit/node`。它封装了第二种入口，返回 Promise 与 Buffer，同时支持 ESM 和 CommonJS。

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

进程内 C ABI 必须在调用 `shot_init` 的同一线程持续使用。JSONL/Node SDK 已把该约束封装在独立 ShotKit 进程内。单实例请求串行；需要真正并行时启动多个实例/进程，不要从多个线程并发调用同一个 C ABI renderer。
