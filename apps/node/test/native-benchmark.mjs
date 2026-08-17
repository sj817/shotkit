import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';

import { launch } from '../dist/index.mjs';

const cliPath = process.argv[2];
if (!cliPath)
  throw new Error('usage: node native-benchmark.mjs <shotcli>');

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const endToEndTargetMs = 1;

const directory = await mkdtemp(path.join(tmpdir(), 'shotkit-benchmark-'));
const cliOutput = path.join(directory, 'cli.png');
const html = '<!doctype html><style>html,body{margin:0;background:linear-gradient(135deg,#2468ac,#f2a900)}.box{width:50%;height:50%;background:#fff8}</style><div class=box></div>';
const child = spawn(cliPath, ['--serve'], { cwd: path.dirname(cliPath), stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
const lines = createInterface({ input: child.stdout });
const responses = [];
let wake;
lines.on('line', (line) => {
  responses.push(JSON.parse(line));
  wake?.();
  wake = undefined;
});
const nextResponse = async () => {
  while (!responses.length)
    await new Promise((resolve) => { wake = resolve; });
  return responses.shift();
};

const ready = await nextResponse();
assert.equal(ready.ready, true, ready.error);
let id = 0;
async function cliRender() {
  const started = performance.now();
  child.stdin.write(`${JSON.stringify({ id: ++id, html, out: cliOutput, width: 640, height: 360, format: 'png' })}\n`);
  const response = await nextResponse();
  assert.equal(response.ok, true, response.error);
  const data = await readFile(cliOutput);
  return { elapsed: performance.now() - started, native: response.duration_ms, data };
}

const shot = await launch();
async function addonRender() {
  const started = performance.now();
  const result = await shot.screenshotHTML(html, { width: 640, height: 360 });
  return { elapsed: performance.now() - started, native: result.durationMs, data: result.data };
}

try {
  for (let index = 0; index < 10; ++index) {
    await cliRender();
    await addonRender();
  }

  const cliSamples = [];
  const addonSamples = [];
  for (let index = 0; index < 100; ++index) {
    cliSamples.push(await cliRender());
    addonSamples.push(await addonRender());
  }
  assert.deepEqual(addonSamples[0].data, cliSamples[0].data);

  const cliEndToEnd = median(cliSamples.map((sample) => sample.elapsed));
  const addonEndToEnd = median(addonSamples.map((sample) => sample.elapsed));
  const cliBinding = median(cliSamples.map((sample) => Math.max(0, sample.elapsed - sample.native)));
  const addonBinding = median(addonSamples.map((sample) => Math.max(0, sample.elapsed - sample.native)));
  const bindingReduction = cliBinding > 0 ? (cliBinding - addonBinding) / cliBinding : 0;
  const endToEndReduction = cliEndToEnd - addonEndToEnd;

  const large = await shot.screenshotHTML(html, { width: 3840, height: 2160 });
  const copySamples = [];
  for (let index = 0; index < 100; ++index) {
    const started = performance.now();
    Buffer.from(large.data);
    copySamples.push(performance.now() - started);
  }

  console.log(JSON.stringify({
    cliEndToEndMs: cliEndToEnd,
    addonEndToEndMs: addonEndToEnd,
    cliBindingMs: cliBinding,
    addonBindingMs: addonBinding,
    bindingReductionPercent: bindingReduction * 100,
    endToEndReductionMs: endToEndReduction,
    endToEndTargetMs,
    encodedBytes: large.data.length,
    avoidedBufferCopyMedianMs: median(copySamples),
  }, null, 2));

  assert.ok(bindingReduction >= 0.20, `binding overhead reduction ${(bindingReduction * 100).toFixed(1)}% is below 20%`);
  assert.ok(endToEndReduction > 0, `addon end-to-end time regressed by ${(-endToEndReduction).toFixed(2)}ms`);
  if (endToEndReduction < endToEndTargetMs)
    console.warn(`end-to-end reduction ${endToEndReduction.toFixed(2)}ms is below the ${endToEndTargetMs}ms performance target`);
} finally {
  await shot.close();
  child.stdin.write(`${JSON.stringify({ id: ++id, op: 'shutdown' })}\n`);
  child.stdin.end();
  await new Promise((resolve) => child.once('exit', resolve));
  await rm(directory, { recursive: true, force: true });
}
