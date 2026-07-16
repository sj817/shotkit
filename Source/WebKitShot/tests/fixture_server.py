#!/usr/bin/env python3
"""M2 网络栈本地验证 fixture（无第三方依赖，纯标准库）。

启动：  python fixture_server.py [port]     # 默认 8987
覆盖点：外链 CSS / PNG+WebP 图 / XML+XSLT / 302 重定向 / cookie 下发+回读 / 主文档。

端点：
  GET /                主 HTML：外链 /style.css + <img src=/logo.png> + 通过 302 拿到的 /redirected.css
  GET /style.css       外链样式表（渐变卡片）
  GET /alt.css         被 /redirect-css 302 指向的样式（证明子资源重定向可用）
  GET /redirect-css    302 → /alt.css
  GET /logo.png        动态生成的 PNG（纯色块）
  GET /set-cookie      Set-Cookie: shot=ok; 302 → /
  GET /cookie.txt      回读 Cookie 头（证明 cookie 回写生效）
所有响应带宽松 CORS/缓存头，尽量贴近真实站点。
"""
import base64, collections, json, sys, struct, threading, zlib, http.server

VERBOSE = "--verbose" in sys.argv
REQUEST_COUNTS = collections.Counter()
REQUEST_COUNTS_LOCK = threading.Lock()

def _png(w, h, rgba):
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xffffffff)
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    row = b"\x00" + bytes(rgba) * w
    raw = row * h
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))

LOGO = _png(96, 96, (0x22, 0xff, 0x88, 0xff))  # 绿色块
PIX_OK = _png(32, 32, (0x22, 0xff, 0x88, 0xff))   # 有 cookie=绿
PIX_NO = _png(32, 32, (0xff, 0x33, 0x33, 0xff))   # 无 cookie=红
WEBP_GREEN = base64.b64decode(
    "UklGRgACAABXRUJQVlA4WAoAAAAgAAAADwAADwAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZWUDhMEQAAAC8PwAMAB9D/ihSx/4GI6H8AAA==")

XML = b'''<?xml version="1.0"?>
<?xml-stylesheet type="text/xsl" href="/document.xsl"?>
<items><item>XML + XSLT retained</item></items>'''

XSL = b'''<?xml version="1.0"?>
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
<xsl:template match="/"><html><body style="background:#eef2f7;font-family:sans-serif">
<h1><xsl:value-of select="items/item"/></h1>
</body></html></xsl:template></xsl:stylesheet>'''

INLINE_XSL = b'''<?xml version="1.0"?>
<?xml-stylesheet type="text/xsl" href="#stylesheet"?>
<!DOCTYPE doc [<!ELEMENT xsl:stylesheet ANY><!ATTLIST xsl:stylesheet id ID #REQUIRED>]>
<doc><item>Inline XSLT retained</item>
<xsl:stylesheet version="1.0" id="stylesheet" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
<xsl:output method="html"/><xsl:template match="xsl:stylesheet"/>
<xsl:template match="doc"><html><body style="background:#eef2f7;font-family:sans-serif">
<h1><xsl:value-of select="item"/></h1></body></html></xsl:template>
</xsl:stylesheet></doc>'''

WEBP_PAGE = b'''<!doctype html><html><body style="margin:0;background:#123;color:white;font:24px sans-serif">
<h1>WebP decoder</h1><img src="/green.webp" width="160" height="160">
</body></html>'''

SCRIPT_PAGE = b'''<!doctype html><html><body style="background:#eef2f7;font-family:sans-serif">
<h1 id="result">Static content retained</h1>
<script>document.getElementById('result').textContent='JS EXECUTED';</script>
</body></html>'''

SCRIPT_NETWORK_PAGE = b'''<!doctype html><html><head>
<link rel="preload" as="script" href="/preloaded.js">
<link rel="modulepreload" href="/module.js">
<script src="/classic.js"></script>
<script type="module" src="/module.js"></script>
</head><body><h1>Script network requests must remain zero</h1></body></html>'''

INDEX = """<!DOCTYPE html><html><head><meta charset=utf-8>
<link rel=stylesheet href="/style.css">
<link rel=stylesheet href="/redirect-css">
</head><body>
<div class=card>
  <img src="/logo.png" width=64 height=64 alt=logo>
  <img src="/cookiepix" width=32 height=32 alt=cookie>
  <h1>M2 network stack</h1>
  <p class=alt>外链 CSS + 图片 + 302 + cookie 全链路</p>
</div>
</body></html>""".encode("utf-8")

STYLE = b"""body{margin:0;background:#0b1021;font-family:sans-serif}
.card{width:560px;margin:56px auto;padding:36px;border-radius:16px;
 background:linear-gradient(135deg,#6a11cb,#2575fc);color:#fff}
h1{margin:12px 0 6px;font-size:32px}"""

ALT = b".alt{font-size:18px;opacity:.9;color:#22ff88}"

class H(http.server.BaseHTTPRequestHandler):
    def _send(self, body, ctype, code=200, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_GET(self):
        p = self.path.split("?")[0]
        if p == "/reset-counts":
            with REQUEST_COUNTS_LOCK:
                REQUEST_COUNTS.clear()
            self._send(b"ok", "text/plain")
            return
        if p == "/request-counts":
            with REQUEST_COUNTS_LOCK:
                body = json.dumps(dict(REQUEST_COUNTS), sort_keys=True).encode()
            self._send(body, "application/json")
            return
        with REQUEST_COUNTS_LOCK:
            REQUEST_COUNTS[p] += 1
        if p == "/":
            # 主文档下发 cookie；随后的 /cookiepix 子资源请求应带上它。
            self._send(INDEX, "text/html; charset=utf-8", 200, {"Set-Cookie": "shot=ok; Path=/"})
        elif p == "/cookiepix":
            has = "shot=ok" in self.headers.get("Cookie", "")
            self._send(PIX_OK if has else PIX_NO, "image/png")
        elif p == "/style.css":
            self._send(STYLE, "text/css")
        elif p == "/alt.css":
            self._send(ALT, "text/css")
        elif p == "/redirect-css":
            self._send(b"", "text/plain", 302, {"Location": "/alt.css"})
        elif p == "/logo.png":
            self._send(LOGO, "image/png")
        elif p == "/webp-page":
            self._send(WEBP_PAGE, "text/html; charset=utf-8")
        elif p == "/green.webp":
            self._send(WEBP_GREEN, "image/webp")
        elif p == "/script-disabled":
            self._send(SCRIPT_PAGE, "text/html; charset=utf-8")
        elif p == "/script-network":
            self._send(SCRIPT_NETWORK_PAGE, "text/html; charset=utf-8", 200, {
                "Link": "</header-preload.js>; rel=preload; as=script, </header-module.js>; rel=modulepreload"
            })
        elif p in ("/classic.js", "/module.js", "/preloaded.js", "/header-preload.js", "/header-module.js"):
            self._send(b"throw new Error('ShotKit must never fetch this')", "text/javascript")
        elif p == "/document.xml":
            self._send(XML, "application/xml")
        elif p == "/document.xsl":
            self._send(XSL, "text/xsl")
        elif p == "/inline-xsl.xml":
            self._send(INLINE_XSL, "application/xml")
        elif p == "/set-cookie":
            self._send(b"", "text/plain", 302, {"Location": "/", "Set-Cookie": "shot=ok; Path=/"})
        elif p == "/cookie.txt":
            self._send(self.headers.get("Cookie", "<none>").encode(), "text/plain")
        elif p == "/redirect-loop":
            # 无限自指 302：验证内核有重定向次数上限、不死循环/不崩。
            self._send(b"", "text/plain", 302, {"Location": "/redirect-loop"})
        elif p == "/slow":
            # 迟迟不响应：验证硬超时（配合 --timeout）。
            import time
            time.sleep(60)
            self._send(b"<h1>too late</h1>", "text/html")
        elif p == "/loop-page":
            # 主文档引用一个陷入重定向环的子资源：验证坏子资源不阻塞整页完成。
            self._send(b"<!DOCTYPE html><h1>ok</h1><img src=/redirect-loop>",
                       "text/html; charset=utf-8")
        else:
            self._send(b"not found", "text/plain", 404)

    do_HEAD = do_GET

    def log_message(self, format, *args):
        if VERBOSE:
            print(format % args, flush=True)

if __name__ == "__main__":
    port = next((int(arg) for arg in sys.argv[1:] if arg.isdigit()), 8987)
    print(f"fixture on http://127.0.0.1:{port}/  (Ctrl-C to stop)")
    http.server.ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
