const assert = require('node:assert/strict');
const test = require('node:test');

const { launch } = require('../dist/index.cjs');

test('CommonJS require entry works', async () => {
  const shot = await launch();
  try {
    const result = await shot.screenshotHTML('<h1>CommonJS</h1>', { width: 240, height: 120 });
    assert.equal(result.data[0], 0x89);
    assert.ok(result.bytes > 8);
  } finally {
    await shot.close();
  }
});
