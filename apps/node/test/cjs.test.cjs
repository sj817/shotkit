const assert = require('node:assert/strict');
const test = require('node:test');

// Self-reference by package name so the test exercises the published "exports"
// map rather than a build-output path that changes with the bundler.
const shotkit = require('@pixel.js/shotkit');
const { screenshot, stop } = shotkit;

test('CommonJS require entry works, named and default', async () => {
  try {
    assert.equal(typeof shotkit.default.screenshot, 'function');
    const result = await screenshot({ html: '<h1>CommonJS</h1>', viewport: { width: 240, height: 120 } });
    assert.equal(result.image[0], 0x89);
    assert.ok(result.stats.bytes > 8);
  } finally {
    await stop();
  }
});
