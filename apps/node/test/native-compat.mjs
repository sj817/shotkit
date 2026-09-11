import assert from 'node:assert/strict';

import { screenshot, stop } from '../dist/index.mjs';

try {
  const result = await screenshot({
    html: '<!doctype html><style>body{margin:0;background:#246;color:white}</style><h1>N-API v8</h1>',
    viewport: { width: 240, height: 120 },
  });
  assert.deepEqual([...result.image.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(result.stats.bytes, result.image.length);
} finally {
  await stop();
}

console.log(`Node ${process.version}: native N-API smoke passed`);
