import http from 'node:http';

const webp = Buffer.from('UklGRtQDAABXRUJQVlA4WAoAAAAgAAAAPwEAxwAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZWUDgg5gEAADAXAJ0BKkAByAA+bTaZSaQjIqEgmAgAgA2JaW7hdrEe6o+d/hmoQD9AOAl/bP0nbYATaNkLGYJ5x/U34Bv43/SP9wAz4I2IKjntiLuzCI7VHD1WMuJKinP11LI2IKjntiLxDEcqznII2IKjntiLxBUc9sReIKjntiLxBUc9sReIKjntiLxBUc9sReIKjntiLxBUc9sReIKjntiLxBUc9sReIKjntiLxBUc9sReIKjntiLxBUc9sReIKjntiLxBUc9hAAP7/ayP///G4BXO8T///I4+Rx8jj/5Ec7YXl+bh2UtLzX9bZyy7+f+E2QmNfJo7aHpNt9uXtknwDFLzjg17m7iI4i1cknk9fSFg+acJvYMnwxKunzBmRZNCfd2ynZOYaa2e8452k9jD/Dag0Zt/1/jP4CN85Do2ZXDb/rj3yxgAMdW8r3icz7Pd9nSwRLUh2NQ3auArWP5DfaYXmha9+QkO9aHkTMfR4cW5+rBjdKo2nQ/0w249R/6q108YHhAO7MUB4a9s3m56mzW+AQKHrKwh9zWePn3uaTNf7EUk50ARH+BN2jP/YC6jNYFX+W4GSteYNPKqCTcWk0MlAUo+pk43IZGIovqUVUhv6UW8zab+HQN38gK49tF/EnuFAAAAAAAAAAA==', 'base64');

const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width">
  <link rel="stylesheet" href="/style.css">
  <title>ShotKit static benchmark</title>
</head>
<body>
  <header>
    <div class="eyebrow">STATIC RENDER BENCHMARK</div>
    <h1>同一份静态页面，<br><span>五个浏览器引擎。</span></h1>
    <p>HTML / CSS / SVG / WebP / MathML · no JavaScript · no iframe</p>
  </header>
  <main>
    <section class="metrics">
      <article><strong>1280 × 800</strong><small>viewport</small></article>
      <article><strong>Full page</strong><small>capture</small></article>
      <article><strong>PNG</strong><small>output</small></article>
      <article><strong>localhost</strong><small>network</small></article>
    </section>
    <section class="showcase">
      <div class="copy">
        <h2>真正参与截图的内容</h2>
        <p>渐变、阴影、圆角、Grid、Flex、中文排版与矢量图形全部进入同一次渲染。</p>
        <div class="tags"><span>HTML5</span><span>CSS Grid</span><span>WebP</span><span>SVG</span></div>
      </div>
      <img src="/sample.webp" width="320" height="200" alt="WebP decode fixture">
    </section>
    <section class="details">
      <article>
        <svg viewBox="0 0 120 120" aria-label="SVG fixture"><defs><linearGradient id="g"><stop stop-color="#7c9cff"/><stop offset="1" stop-color="#79e5c5"/></linearGradient></defs><circle cx="60" cy="60" r="52" fill="url(#g)"/><path d="M35 62l16 16 35-39" fill="none" stroke="white" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <h3>SVG vector</h3><p>内联矢量图参与布局与光栅化。</p>
      </article>
      <article>
        <div class="formula"><math><mrow><msup><mi>x</mi><mn>2</mn></msup><mo>+</mo><msup><mi>y</mi><mn>2</mn></msup><mo>=</mo><msup><mi>r</mi><mn>2</mn></msup></mrow></math></div>
        <h3>MathML</h3><p>数学排版能力保持开启。</p>
      </article>
      <article>
        <div class="bars"><i></i><i></i><i></i><i></i><i></i></div>
        <h3>CSS paint</h3><p>多层渐变、边框和阴影。</p>
      </article>
    </section>
  </main>
  <footer>ShotKit reproducible browser benchmark fixture</footer>
</body>
</html>`;

const css = `
*{box-sizing:border-box}html{background:#eef2f8;color:#172033;font-family:"Segoe UI","Microsoft YaHei",sans-serif}body{margin:0;min-height:1400px;background:radial-gradient(circle at 85% 5%,#ccd9ff 0,transparent 32%),linear-gradient(180deg,#f8faff,#e8edf6)}header,main,footer{width:min(1120px,calc(100% - 80px));margin:auto}header{padding:84px 0 52px}.eyebrow{font-weight:700;letter-spacing:.22em;color:#5672c7;font-size:13px}h1{margin:18px 0;font-size:66px;line-height:1.04;letter-spacing:-.045em}h1 span{color:#627fe0}header p{font-size:18px;color:#68738a}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}.metrics article,.showcase,.details article{background:rgba(255,255,255,.76);border:1px solid rgba(255,255,255,.9);box-shadow:0 18px 50px rgba(38,55,91,.1);border-radius:22px}.metrics article{padding:22px}.metrics strong,.metrics small{display:block}.metrics strong{font-size:19px}.metrics small{margin-top:5px;color:#7d879b}.showcase{margin-top:22px;padding:38px;display:flex;align-items:center;justify-content:space-between;gap:40px}.showcase h2{font-size:34px;margin:0 0 10px}.showcase p{max-width:570px;color:#637086;line-height:1.7}.showcase img{border-radius:16px;object-fit:cover;box-shadow:0 14px 32px rgba(49,65,104,.18)}.tags{display:flex;gap:9px}.tags span{background:#e7edff;color:#526bb6;padding:8px 12px;border-radius:999px;font-size:13px;font-weight:650}.details{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin-top:22px}.details article{padding:30px;min-height:310px}.details svg{width:104px;height:104px}.details h3{font-size:21px;margin:24px 0 8px}.details p{color:#707b90;line-height:1.55}.formula{height:104px;display:flex;align-items:center;font-size:28px;color:#526bb6}.bars{height:104px;display:flex;align-items:end;gap:9px}.bars i{display:block;width:26px;border-radius:8px 8px 3px 3px;background:linear-gradient(#7997f5,#6ad7bd)}.bars i:nth-child(1){height:34px}.bars i:nth-child(2){height:70px}.bars i:nth-child(3){height:48px}.bars i:nth-child(4){height:92px}.bars i:nth-child(5){height:62px}footer{padding:54px 0 70px;color:#8490a5;text-align:center}
`;

export function startFixtureServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      if (request.url === '/style.css') {
        response.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' });
        response.end(css);
        return;
      }
      if (request.url === '/sample.webp') {
        response.writeHead(200, { 'content-type': 'image/webp', 'cache-control': 'no-store' });
        response.end(webp);
        return;
      }
      if (request.url === '/' || request.url === '/index.html') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(html);
        return;
      }
      response.writeHead(404);
      response.end('not found');
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise((done, fail) => server.close((error) => error ? fail(error) : done())),
      });
    });
  });
}
