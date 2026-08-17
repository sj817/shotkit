import assert from 'node:assert/strict';

import { launch } from '../dist/index.mjs';

const shot = await launch();
try {
  const result = await shot.screenshotHTML(
    '<!doctype html><style>body{margin:0;background:#246;color:white}</style><h1>N-API v8</h1>',
    { width: 240, height: 120 },
  );
  assert.deepEqual([...result.data.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(result.bytes, result.data.length);
} finally {
  await shot.close();
}

console.log(`Node ${process.version}: native N-API smoke passed`);
