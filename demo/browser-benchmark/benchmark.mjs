import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { startFixtureServer } from './lib/fixture.mjs';
import { processTreeRSS } from './lib/process-tree.mjs';

const demoDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(demoDirectory, '..', '..');
const browserRoot = path.join(demoDirectory, '.browsers');
const outputDirectory = path.join(demoDirectory, 'output');
const resultDirectory = path.join(demoDirectory, 'results');
const shotDistribution = process.env.SHOT_DIST || path.join(repositoryRoot, 'WebKitBuild', 'shot-dist');
const shotCLI = process.env.SHOTCLI || path.join(shotDistribution, process.platform === 'win32' ? 'shotcli.exe' : 'shotcli');

process.env.PUPPETEER_CACHE_DIR ||= path.join(browserRoot, 'puppeteer');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(browserRoot, 'playwright');

const puppeteer = (await import('puppeteer')).default;
const playwright = await import('playwright');

function parseArguments(argv) {
  const options = { coldIterations: 5, warmup: 3, iterations: 20 };
  for (let index = 0; index < argv.length; ++index) {
    const value = argv[index];
    const nextInteger = () => {
      const number = Number(argv[++index]);
      if (!Number.isInteger(number) || number < 1)
        throw new Error(`${value} requires a positive integer`);
      return number;
    };
    if (value === '--cold-iterations')
      options.coldIterations = nextInteger();
    else if (value === '--warmup')
      options.warmup = nextInteger();
    else if (value === '--iterations')
      options.iterations = nextInteger();
    else
      throw new Error(`unknown argument: ${value}`);
  }
  return options;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(values) {
  return {
    mean_ms: values.reduce((sum, value) => sum + value, 0) / values.length,
    median_ms: percentile(values, 0.5),
    p95_ms: percentile(values, 0.95),
    min_ms: Math.min(...values),
    max_ms: Math.max(...values),
  };
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr?.on('data', (chunk) => stderr += chunk);
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`process exited with ${code}: ${stderr.trim()}`)));
  });
}

class ShotServer {
  constructor(executable) {
    this.child = spawn(executable, ['--serve'], { cwd: path.dirname(executable), stdio: ['pipe', 'pipe', 'pipe'] });
    this.exitPromise = waitForExit(this.child);
    this.lines = [];
    this.waiters = [];
    this.stderr = '';
    this.child.stderr.on('data', (chunk) => this.stderr += chunk);
    const reader = createInterface({ input: this.child.stdout });
    reader.on('line', (line) => {
      const waiter = this.waiters.shift();
      if (waiter)
        waiter.resolve(line);
      else
        this.lines.push(line);
    });
    this.child.once('error', (error) => {
      for (const waiter of this.waiters.splice(0))
        waiter.reject(error);
    });
  }

  nextLine() {
    if (this.lines.length)
      return Promise.resolve(this.lines.shift());
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  async ready() {
    const response = JSON.parse(await this.nextLine());
    if (!response.ready)
      throw new Error(response.error || 'ShotKit server failed to start');
  }

  async render(request) {
    this.child.stdin.write(`${JSON.stringify(request)}\n`);
    const response = JSON.parse(await this.nextLine());
    if (!response.ok)
      throw new Error(response.error || `ShotKit status ${response.status}`);
    return response;
  }

  async close() {
    this.child.stdin.write(`${JSON.stringify({ op: 'shutdown' })}\n`);
    await this.nextLine();
    await this.exitPromise;
  }
}

function browserAdapter({ id, framework, engine, launch, render, executablePath }) {
  let browser;
  let version;
  let actualExecutable;
  return {
    id,
    framework,
    engine,
    async coldRender(url, output) {
      const instance = await launch();
      version ||= await instance.version();
      actualExecutable ||= instance.process?.()?.spawnfile || executablePath?.();
      try {
        await render(instance, url, output);
      } finally {
        await instance.close();
      }
    },
    async startWarm() {
      browser = await launch();
      version ||= await browser.version();
      actualExecutable ||= browser.process?.()?.spawnfile || executablePath?.();
    },
    async warmRender(url, output) {
      await render(browser, url, output);
    },
    async stopWarm() {
      await browser.close();
    },
    details() {
      return { version, executable: actualExecutable };
    },
  };
}

async function renderPuppeteer(browser, url, output) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  try {
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    await page.goto(url, { waitUntil: 'load' });
    await page.screenshot({ path: output, type: 'png', fullPage: true });
  } finally {
    await context.close();
  }
}

async function renderPlaywright(browser, url, output) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'load' });
    await page.screenshot({ path: output, type: 'png', fullPage: true });
  } finally {
    await context.close();
  }
}

function createAdapters() {
  const adapters = [
    browserAdapter({
      id: 'puppeteer-chrome', framework: 'Puppeteer', engine: 'Chrome',
      launch: () => puppeteer.launch({ browser: 'chrome', headless: true }),
      render: renderPuppeteer,
    }),
    browserAdapter({
      id: 'puppeteer-firefox', framework: 'Puppeteer', engine: 'Firefox',
      launch: () => puppeteer.launch({ browser: 'firefox', headless: true }),
      render: renderPuppeteer,
    }),
    ...[
      ['chromium', 'Chromium', playwright.chromium],
      ['firefox', 'Firefox', playwright.firefox],
      ['webkit', 'WebKit', playwright.webkit],
    ].map(([id, name, browserType]) => browserAdapter({
      id: `playwright-${id}`, framework: 'Playwright', engine: name,
      launch: () => browserType.launch({ headless: true }),
      render: renderPlaywright,
      executablePath: () => browserType.executablePath(),
    })),
  ];

  let server;
  adapters.push({
    id: 'shotkit', framework: 'ShotKit', engine: 'WebCore/Skia',
    async coldRender(url, output) {
      const child = spawn(shotCLI, ['--url', url, '--out', output, '--width', '1280', '--height', '800', '--full-page', '--format', 'png'], {
        cwd: path.dirname(shotCLI), stdio: ['ignore', 'ignore', 'pipe'],
      });
      await waitForExit(child);
    },
    async startWarm() {
      server = new ShotServer(shotCLI);
      await server.ready();
    },
    async warmRender(url, output) {
      await server.render({ url, out: output, width: 1280, height: 800, full_page: true, format: 'png' });
    },
    async stopWarm() {
      await server.close();
    },
    details() {
      return { version: 'shotkit', executable: shotCLI };
    },
  });
  return adapters;
}

async function directorySize(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory())
      total += await directorySize(entryPath);
    else if (entry.isFile())
      total += (await stat(entryPath)).size;
  }
  return total;
}

function installDirectory(executable, adapter) {
  if (adapter.framework === 'ShotKit')
    return shotDistribution;
  const base = path.join(browserRoot, adapter.framework === 'Puppeteer' ? 'puppeteer' : 'playwright');
  let current = path.resolve(executable);
  while (path.dirname(current) !== path.resolve(base) && current !== path.dirname(current))
    current = path.dirname(current);
  return path.dirname(current) === path.resolve(base) ? current : path.dirname(executable);
}

function markdownReport(report) {
  const number = (value, digits = 1) => value.toFixed(digits);
  const rows = report.results.map((result) => `| ${result.framework} | ${result.engine} | ${result.version} | ${number(result.cold.median_ms)} | ${number(result.cold.p95_ms)} | ${number(result.warm.median_ms)} | ${number(result.warm.p95_ms)} | ${number(result.cold.median_ms / result.warm.median_ms, 2)}× | ${number(result.resident_rss_mb)} | ${number(result.install_mb)} |`);
  return `# ShotKit / Puppeteer / Playwright 基准报告

生成时间：${report.generated_at}

| 框架 | 引擎 | 版本 | 冷启动中位数 ms | 冷启动 P95 ms | 热启动中位数 ms | 热启动 P95 ms | 冷/热加速比 | 热进程 RSS MB | 引擎/分发体积 MB |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
${rows.join('\n')}

## 测试口径

- 主机：${report.system.platform} ${report.system.release}，${report.system.cpu}，${report.system.memory_gb} GB RAM，Node ${report.system.node}。
- 页面：本机 HTTP，1280×800、DPR 1、full-page PNG；静态 HTML/CSS/SVG/WebP/MathML，不含 JavaScript 和 iframe。
- 冷启动：每张图启动并关闭一个全新浏览器/ShotKit 进程，共 ${report.options.coldIterations} 次；操作系统文件缓存保持自然热态。
- 热启动：进程常驻；浏览器每次新建并关闭隔离 Context + Page，ShotKit 每次在同一 renderer 中创建独立页面和网络状态，共 ${report.options.iterations} 次，另有 ${report.options.warmup} 次不计入预热。
- 延迟包含页面加载、布局、光栅化、PNG 编码和磁盘写入。热启动不包含常驻进程的首次启动。
- RSS 是热测试完成后、空闲状态下相对基准进程的整棵子进程树增量；内存采样不在计时区间内。
- 体积为对应浏览器引擎安装目录；ShotKit 为完整 shot-dist。Puppeteer/Playwright 共享的 Node 依赖未分摊到单个引擎。

原始数据见 [latest.json](./latest.json)。
`;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  await mkdir(outputDirectory, { recursive: true });
  await mkdir(resultDirectory, { recursive: true });
  await stat(shotCLI);
  const fixture = await startFixtureServer();
  const results = [];
  try {
    for (const adapter of createAdapters()) {
      console.log(`\n[${adapter.framework} / ${adapter.engine}] cold`);
      const coldValues = [];
      const coldOutput = path.join(outputDirectory, `${adapter.id}-cold.png`);
      for (let index = 0; index < options.coldIterations; ++index) {
        const start = performance.now();
        await adapter.coldRender(fixture.url, coldOutput);
        const elapsed = performance.now() - start;
        coldValues.push(elapsed);
        console.log(`  ${index + 1}/${options.coldIterations}: ${elapsed.toFixed(1)} ms`);
      }

      await new Promise((resolve) => setTimeout(resolve, 300));
      const baselineRSS = await processTreeRSS();
      await adapter.startWarm();
      const warmOutput = path.join(outputDirectory, `${adapter.id}-warm.png`);
      for (let index = 0; index < options.warmup; ++index)
        await adapter.warmRender(fixture.url, warmOutput);

      console.log(`[${adapter.framework} / ${adapter.engine}] warm`);
      const warmValues = [];
      for (let index = 0; index < options.iterations; ++index) {
        const start = performance.now();
        await adapter.warmRender(fixture.url, warmOutput);
        const elapsed = performance.now() - start;
        warmValues.push(elapsed);
        console.log(`  ${index + 1}/${options.iterations}: ${elapsed.toFixed(1)} ms`);
      }
      const residentRSS = Math.max(0, await processTreeRSS() - baselineRSS);
      const details = adapter.details();
      const installPath = installDirectory(details.executable, adapter);
      const installBytes = await directorySize(installPath);
      const outputBytes = (await stat(warmOutput)).size;
      await adapter.stopWarm();

      results.push({
        id: adapter.id,
        framework: adapter.framework,
        engine: adapter.engine,
        version: details.version,
        executable: details.executable,
        install_path: installPath,
        install_mb: installBytes / 1048576,
        output_bytes: outputBytes,
        resident_rss_mb: residentRSS / 1048576,
        cold_samples_ms: coldValues,
        warm_samples_ms: warmValues,
        cold: summarize(coldValues),
        warm: summarize(warmValues),
      });
    }
  } finally {
    await fixture.close();
  }

  const packageJSON = JSON.parse(await readFile(path.join(demoDirectory, 'package.json'), 'utf8'));
  const report = {
    generated_at: new Date().toISOString(),
    options,
    fixture: { viewport: '1280x800', dpr: 1, full_page: true, format: 'PNG' },
    frameworks: {
      puppeteer: packageJSON.devDependencies.puppeteer,
      playwright: packageJSON.devDependencies.playwright,
    },
    system: {
      platform: os.platform(), release: os.release(), cpu: os.cpus()[0].model,
      memory_gb: Number((os.totalmem() / 1073741824).toFixed(1)), node: process.version,
    },
    results,
  };
  await writeFile(path.join(resultDirectory, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(resultDirectory, 'latest.md'), markdownReport(report));
  console.log(`\nReport: ${path.join(resultDirectory, 'latest.md')}`);
}

await main();
