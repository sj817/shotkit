import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';

import { launch } from '../dist/index.mjs';

if (typeof globalThis.gc !== 'function')
  throw new Error('native-soak.mjs requires node --expose-gc');

async function threadCount() {
  try {
    return (await readdir('/proc/self/task')).length;
  } catch {
    return undefined;
  }
}

const activeHandles = () => process._getActiveHandles().length;
const shot = await launch();
const handlesBefore = activeHandles();
const threadsBefore = await threadCount();
let baselineRSS = 0;
let peakRSS = 0;

try {
  for (let iteration = 0; iteration < 1000; ++iteration) {
    const result = await shot.screenshotHTML(
      '<!doctype html><style>html,body{margin:0;background:#2468ac}</style>',
      { width: 160, height: 90 },
    );
    assert.ok(result.bytes > 8);
    if (iteration % 20 === 19)
      globalThis.gc();
    const rss = process.memoryUsage().rss;
    if (iteration === 20)
      baselineRSS = rss;
    peakRSS = Math.max(peakRSS, rss);
  }

  globalThis.gc();
  const growth = Math.max(0, peakRSS - baselineRSS);
  assert.ok(growth < 64 * 1024 * 1024, `RSS grew ${(growth / 1048576).toFixed(1)} MiB after warmup`);
  assert.ok(activeHandles() <= handlesBefore + 2, 'active handle count grew across the soak run');
  const threadsAfter = await threadCount();
  if (threadsBefore !== undefined && threadsAfter !== undefined)
    assert.ok(threadsAfter <= threadsBefore + 1, 'thread count grew across the soak run');
  console.log(`1000 native renders: peak growth ${(growth / 1048576).toFixed(1)} MiB`);
} finally {
  await shot.close();
}
