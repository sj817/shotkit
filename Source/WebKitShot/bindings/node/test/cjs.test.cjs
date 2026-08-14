const assert = require('node:assert/strict');
const test = require('node:test');

// Self-reference by package name so the test exercises the published "exports"
// map rather than a build-output path that changes with the bundler.
const { launch } = require('@shotkit/node');

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
