import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { Browser as PlaywrightBrowser, BrowserType } from 'playwright';
import type { Browser as PuppeteerBrowser } from 'puppeteer';

import { startFixtureServer } from './lib/fixture.js';
import { processTreeRSS } from './lib/process-tree.js';

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

type Mode = 'cold' | 'warm';

interface BenchmarkOptions {
  trials: number;
  scenario?: string;
}

interface Scenario {
  id: string;
  label: string;
  url: string;
  kind: 'http-fixture' | 'remote-https' | 'local-file';
  allowFileURLs: boolean;
}

interface AdapterDetails {
  version: string;
  executable: string;
}

interface Adapter {
  id: string;
  framework: string;
  engine: string;
  coldRender(scenario: Scenario, output: string): Promise<void>;
  startWarm(): Promise<void>;
  warmRender(scenario: Scenario, output: string): Promise<void>;
  stopWarm(): Promise<void>;
  details(): AdapterDetails;
}

interface TrialSample {
  trial: number;
  ok: boolean;
  duration_ms: number;
  output?: string;
  output_bytes?: number;
  error?: string;
}

interface TrialResult {
  samples: TrialSample[];
  fastest_ms: number;
  fastest_trial: number;
  fastest_output: string;
  output_bytes: number;
}

interface ScenarioTimingResult {
  scenario_id: string;
  cold: TrialResult;
  warm: TrialResult;
}

interface EngineResult {
  id: string;
  framework: string;
  engine: string;
  version: string;
  executable: string;
  install_path: string;
  install_mb: number;
  resident_rss_mb: number;
  scenarios: ScenarioTimingResult[];
}

interface Report {
  schema_version: 2;
  generated_at: string;
  options: BenchmarkOptions;
  capture: { viewport: string; dpr: number; full_page: boolean; format: string };
  frameworks: { puppeteer: string; playwright: string; tsx: string; typescript: string };
  system: { platform: string; release: string; cpu: string; memory_gb: number; node: string };
  scenarios: Array<Omit<Scenario, 'allowFileURLs'>>;
  results: EngineResult[];
}

interface JSONResponse {
  ready?: boolean;
  ok?: boolean;
  status?: number;
  error?: string;
}

interface LineWaiter {
  resolve(line: string): void;
  reject(error: Error): void;
}

function parseArguments(argv: string[]): BenchmarkOptions {
  const options: BenchmarkOptions = { trials: 3 };
  for (let index = 0; index < argv.length; ++index) {
    const argument = argv[index];
    if (argument === '--trials') {
      const trials = Number(argv[++index]);
      if (!Number.isInteger(trials) || trials < 1)
        throw new Error('--trials requires a positive integer');
      options.trials = trials;
    } else if (argument === '--scenario') {
      const scenario = argv[++index];
      if (!scenario)
        throw new Error('--scenario requires fixture-http, example-com, or local-file');
      options.scenario = scenario;
    } else
      throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => stderr += chunk.toString());
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`process exited with ${code}: ${stderr.trim()}`)));
  });
}

class ShotServer {
  private readonly child;
  private readonly exitPromise: Promise<void>;
  private readonly lines: string[] = [];
  private readonly waiters: LineWaiter[] = [];

  constructor(executable: string) {
    this.child = spawn(executable, ['--serve'], { cwd: path.dirname(executable), stdio: ['pipe', 'pipe', 'pipe'] });
    this.exitPromise = waitForExit(this.child);
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

  private nextLine(): Promise<string> {
    const line = this.lines.shift();
    if (line !== undefined)
      return Promise.resolve(line);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  async ready(): Promise<void> {
    const response = JSON.parse(await this.nextLine()) as JSONResponse;
    if (!response.ready)
      throw new Error(response.error || 'ShotKit server failed to start');
  }

  async render(scenario: Scenario, output: string): Promise<void> {
    this.child.stdin.write(`${JSON.stringify({
      url: scenario.url,
      out: output,
      width: 1280,
      height: 800,
      full_page: true,
      format: 'png',
      allow_file_urls: scenario.allowFileURLs,
    })}\n`);
    const response = JSON.parse(await this.nextLine()) as JSONResponse;
    if (!response.ok)
      throw new Error(response.error || `ShotKit status ${response.status}`);
  }

  async close(): Promise<void> {
    this.child.stdin.write(`${JSON.stringify({ op: 'shutdown' })}\n`);
    await this.nextLine();
    await this.exitPromise;
  }
}

interface BrowserAdapterConfiguration<TBrowser extends { close(): Promise<void> }> {
  id: string;
  framework: string;
  engine: string;
  launch(): Promise<TBrowser>;
  render(browser: TBrowser, scenario: Scenario, output: string): Promise<void>;
  version(browser: TBrowser): Promise<string>;
  executable(browser: TBrowser): string | undefined;
}

function browserAdapter<TBrowser extends { close(): Promise<void> }>(configuration: BrowserAdapterConfiguration<TBrowser>): Adapter {
  let browser: TBrowser | undefined;
  let version: string | undefined;
  let actualExecutable: string | undefined;
  const captureDetails = async (instance: TBrowser): Promise<void> => {
    version ||= await configuration.version(instance);
    actualExecutable ||= configuration.executable(instance);
  };
  return {
    id: configuration.id,
    framework: configuration.framework,
    engine: configuration.engine,
    async coldRender(scenario, output) {
      const instance = await configuration.launch();
      await captureDetails(instance);
      try {
        await configuration.render(instance, scenario, output);
      } finally {
        await instance.close();
      }
    },
    async startWarm() {
      browser = await configuration.launch();
      await captureDetails(browser);
    },
    async warmRender(scenario, output) {
      if (!browser)
        throw new Error(`${configuration.id} warm browser is not running`);
      await configuration.render(browser, scenario, output);
    },
    async stopWarm() {
      if (browser)
        await browser.close();
      browser = undefined;
    },
    details() {
      if (!version || !actualExecutable)
        throw new Error(`${configuration.id} did not expose version/executable details`);
      return { version, executable: actualExecutable };
    },
  };
}

async function renderPuppeteer(browser: PuppeteerBrowser, scenario: Scenario, output: string): Promise<void> {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  try {
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    await page.goto(scenario.url, { waitUntil: 'load', timeout: 30_000 });
    await page.screenshot({ path: output, type: 'png', fullPage: true });
  } finally {
    await context.close();
  }
}

async function renderPlaywright(browser: PlaywrightBrowser, scenario: Scenario, output: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  try {
    await page.goto(scenario.url, { waitUntil: 'load', timeout: 30_000 });
    await page.screenshot({ path: output, type: 'png', fullPage: true });
  } finally {
    await context.close();
  }
}

function playwrightAdapter(id: string, name: string, browserType: BrowserType): Adapter {
  return browserAdapter({
    id: `playwright-${id}`,
    framework: 'Playwright',
    engine: name,
    launch: () => browserType.launch({ headless: true }),
    render: renderPlaywright,
    version: async (browser) => browser.version(),
    executable: () => browserType.executablePath(),
  });
}

function createAdapters(): Adapter[] {
  const adapters: Adapter[] = [
    browserAdapter({
      id: 'puppeteer-chrome', framework: 'Puppeteer', engine: 'Chrome',
      launch: () => puppeteer.launch({ browser: 'chrome', headless: true }),
      render: renderPuppeteer,
      version: (browser) => browser.version(),
      executable: (browser) => browser.process()?.spawnfile,
    }),
    browserAdapter({
      id: 'puppeteer-firefox', framework: 'Puppeteer', engine: 'Firefox',
      launch: () => puppeteer.launch({ browser: 'firefox', headless: true }),
      render: renderPuppeteer,
      version: (browser) => browser.version(),
      executable: (browser) => browser.process()?.spawnfile,
    }),
    playwrightAdapter('chromium', 'Chromium', playwright.chromium),
    playwrightAdapter('firefox', 'Firefox', playwright.firefox),
    playwrightAdapter('webkit', 'WebKit', playwright.webkit),
  ];

  let server: ShotServer | undefined;
  adapters.push({
    id: 'shotkit', framework: 'ShotKit', engine: 'WebCore/Skia',
    async coldRender(scenario, output) {
      const args = ['--url', scenario.url, '--out', output, '--width', '1280', '--height', '800', '--full-page', '--format', 'png'];
      if (scenario.allowFileURLs)
        args.push('--allow-file-urls');
      const child = spawn(shotCLI, args, { cwd: path.dirname(shotCLI), stdio: ['ignore', 'ignore', 'pipe'] });
      await waitForExit(child);
    },
    async startWarm() {
      server = new ShotServer(shotCLI);
      await server.ready();
    },
    async warmRender(scenario, output) {
      if (!server)
        throw new Error('ShotKit warm server is not running');
      await server.render(scenario, output);
    },
    async stopWarm() {
      if (server)
        await server.close();
      server = undefined;
    },
    details() {
      return { version: 'shotkit', executable: shotCLI };
    },
  });
  return adapters;
}

async function directorySize(directory: string): Promise<number> {
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

function installDirectory(executable: string, adapter: Adapter): string {
  if (adapter.framework === 'ShotKit')
    return shotDistribution;
  const base = path.resolve(browserRoot, adapter.framework === 'Puppeteer' ? 'puppeteer' : 'playwright');
  let current = path.resolve(executable);
  while (path.dirname(current) !== base && current !== path.dirname(current))
    current = path.dirname(current);
  return path.dirname(current) === base ? current : path.dirname(executable);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runTrials(adapter: Adapter, scenario: Scenario, mode: Mode, trials: number): Promise<TrialResult> {
  const samples: TrialSample[] = [];
  for (let index = 0; index < trials; ++index) {
    const output = path.join(outputDirectory, `${adapter.id}-${scenario.id}-${mode}-${index + 1}.png`);
    const start = performance.now();
    try {
      if (mode === 'cold')
        await adapter.coldRender(scenario, output);
      else
        await adapter.warmRender(scenario, output);
      const duration = performance.now() - start;
      const outputBytes = (await stat(output)).size;
      samples.push({ trial: index + 1, ok: true, duration_ms: duration, output, output_bytes: outputBytes });
      console.log(`    ${index + 1}/${trials}: ${duration.toFixed(1)} ms`);
    } catch (error) {
      const duration = performance.now() - start;
      const message = errorMessage(error);
      samples.push({ trial: index + 1, ok: false, duration_ms: duration, error: message });
      console.log(`    ${index + 1}/${trials}: FAILED (${message})`);
    }
  }

  const successful = samples.filter((sample): sample is TrialSample & Required<Pick<TrialSample, 'output' | 'output_bytes'>> => sample.ok && !!sample.output && sample.output_bytes !== undefined);
  if (!successful.length)
    throw new Error(`${adapter.id}/${scenario.id}/${mode}: all ${trials} trials failed`);
  const fastest = successful.reduce((best, sample) => sample.duration_ms < best.duration_ms ? sample : best);
  const fastestOutput = path.join(outputDirectory, `${adapter.id}-${scenario.id}-${mode}-fastest.png`);
  await copyFile(fastest.output, fastestOutput);
  return {
    samples,
    fastest_ms: fastest.duration_ms,
    fastest_trial: fastest.trial,
    fastest_output: fastestOutput,
    output_bytes: fastest.output_bytes,
  };
}

function markdownReport(report: Report): string {
  const number = (value: number, digits = 1): string => value.toFixed(digits);
  const sections = report.scenarios.map((scenario) => {
    const rows = report.results.map((engine) => {
      const timing = engine.scenarios.find((item) => item.scenario_id === scenario.id);
      if (!timing)
        throw new Error(`missing ${engine.id}/${scenario.id} report result`);
      return `| ${engine.framework} | ${engine.engine} | ${engine.version} | ${number(timing.cold.fastest_ms)} | ${number(timing.warm.fastest_ms)} | ${number(timing.cold.fastest_ms / timing.warm.fastest_ms, 2)}× |`;
    });
    return `## ${scenario.label}\n\n地址：\`${scenario.url}\`\n\n| 框架 | 引擎 | 版本 | 冷启动最快 ms | 常驻热启动最快 ms | 冷/热比 |\n|---|---|---:|---:|---:|---:|\n${rows.join('\n')}`;
  });
  const footprintRows = report.results.map((engine) => `| ${engine.framework} | ${engine.engine} | ${number(engine.resident_rss_mb)} | ${number(engine.install_mb)} |`);
  return `# ShotKit / Puppeteer / Playwright 三场景基准报告

生成时间：${report.generated_at}

每个“引擎 × 场景 × 冷/热”独立截图 ${report.options.trials} 次，表格取成功样本中的最快结果；三次原始数据完整保存在 JSON 中。

${sections.join('\n\n')}

## 常驻内存与安装体积

| 框架 | 引擎 | 热进程 RSS MB | 引擎/分发体积 MB |
|---|---|---:|---:|
${footprintRows.join('\n')}

## 测试口径

- 主机：${report.system.platform} ${report.system.release}，${report.system.cpu}，${report.system.memory_gb} GB RAM，Node ${report.system.node}。
- 截图：1280×800、DPR 1、full-page PNG；页面加载等待条件统一为 \`load\`。
- 冷启动：每张图启动并关闭一个全新浏览器/ShotKit 进程；操作系统文件缓存保持自然热态。
- 热启动：进程常驻；浏览器每次新建并关闭隔离 Context + Page，ShotKit 每次在同一 renderer 中创建独立页面和网络状态。
- 延迟包含进程启动（仅冷测）、页面加载、布局、光栅化、PNG 编码和磁盘写入。
- \`https://example.com/\` 使用真实公网，三次取最快用于降低瞬时网络抖动影响，并不消除线路差异。
- RSS 是全部热场景完成后、空闲状态下相对基准进程的整棵子进程树增量；内存采样不在计时区间内。
- 体积为对应浏览器引擎安装目录；ShotKit 为完整 shot-dist。Puppeteer/Playwright 共享的 Node 依赖未分摊到单个引擎。

原始数据见 [latest.json](./latest.json)。
`;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  await mkdir(outputDirectory, { recursive: true });
  await mkdir(resultDirectory, { recursive: true });
  await stat(shotCLI);
  const fixture = await startFixtureServer();
  const allScenarios: Scenario[] = [
    { id: 'fixture-http', label: '场景一：本机 HTTP 静态页', url: fixture.url, kind: 'http-fixture', allowFileURLs: false },
    { id: 'example-com', label: '场景二：公网 example.com', url: 'https://example.com/', kind: 'remote-https', allowFileURLs: false },
    { id: 'local-file', label: '场景三：本地 file:// 页面', url: pathToFileURL(path.join(demoDirectory, 'fixtures', 'local.html')).href, kind: 'local-file', allowFileURLs: true },
  ];
  const scenarios = options.scenario ? allScenarios.filter((scenario) => scenario.id === options.scenario) : allScenarios;
  if (!scenarios.length)
    throw new Error(`unknown scenario '${options.scenario}'; expected fixture-http, example-com, or local-file`);

  const results: EngineResult[] = [];
  try {
    for (const adapter of createAdapters()) {
      console.log(`\n[${adapter.framework} / ${adapter.engine}]`);
      const scenarioResults = new Map<string, Partial<ScenarioTimingResult>>();
      for (const scenario of scenarios) {
        console.log(`  ${scenario.label} / cold (best of ${options.trials})`);
        scenarioResults.set(scenario.id, {
          scenario_id: scenario.id,
          cold: await runTrials(adapter, scenario, 'cold', options.trials),
        });
      }

      await new Promise((resolve) => setTimeout(resolve, 300));
      const baselineRSS = await processTreeRSS();
      await adapter.startWarm();
      try {
        for (const scenario of scenarios) {
          console.log(`  ${scenario.label} / warm (best of ${options.trials})`);
          const partial = scenarioResults.get(scenario.id);
          if (!partial)
            throw new Error(`missing cold result for ${scenario.id}`);
          partial.warm = await runTrials(adapter, scenario, 'warm', options.trials);
        }
        const residentRSS = Math.max(0, await processTreeRSS() - baselineRSS);
        const details = adapter.details();
        const installPath = installDirectory(details.executable, adapter);
        const installBytes = await directorySize(installPath);
        const completeScenarios = [...scenarioResults.values()].map((result) => {
          if (!result.scenario_id || !result.cold || !result.warm)
            throw new Error(`${adapter.id}: incomplete scenario result`);
          return result as ScenarioTimingResult;
        });
        results.push({
          id: adapter.id,
          framework: adapter.framework,
          engine: adapter.engine,
          version: details.version,
          executable: details.executable,
          install_path: installPath,
          install_mb: installBytes / 1048576,
          resident_rss_mb: residentRSS / 1048576,
          scenarios: completeScenarios,
        });
      } finally {
        await adapter.stopWarm();
      }
    }
  } finally {
    await fixture.close();
  }

  const packageJSON = JSON.parse(await readFile(path.join(demoDirectory, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> };
  const report: Report = {
    schema_version: 2,
    generated_at: new Date().toISOString(),
    options,
    capture: { viewport: '1280x800', dpr: 1, full_page: true, format: 'PNG' },
    frameworks: {
      puppeteer: packageJSON.devDependencies.puppeteer,
      playwright: packageJSON.devDependencies.playwright,
      tsx: packageJSON.devDependencies.tsx,
      typescript: packageJSON.devDependencies.typescript,
    },
    system: {
      platform: os.platform(), release: os.release(), cpu: os.cpus()[0].model,
      memory_gb: Number((os.totalmem() / 1073741824).toFixed(1)), node: process.version,
    },
    scenarios: scenarios.map(({ allowFileURLs: _allowFileURLs, ...scenario }) => scenario),
    results,
  };
  await writeFile(path.join(resultDirectory, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(resultDirectory, 'latest.md'), markdownReport(report));
  console.log(`\nReport: ${path.join(resultDirectory, 'latest.md')}`);
}

await main();
