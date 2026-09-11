// A wrong "input" is one avoidable build; a wrong "not an input" is a release
// cut from stale bytes. So the closure and the hashing are pinned here, and
// the real repository is asked twice to prove the id is a function of the
// tree alone.
import assert from 'node:assert/strict';
import test from 'node:test';

import { CLOSURE, compute, fingerprint, nodeApiHeadersVersion } from './fingerprint.mjs';

const nul = '\0';
const listing = [`100644 blob ${'1'.repeat(40)}\tSource/WTF/wtf/Vector.h`, `100755 blob ${'2'.repeat(40)}\tscripts/build-shot.ps1`].join(nul) + nul;

test('the closure names what the build reads and nothing the docs or the SDK own', () => {
  for (const wanted of ['Source', 'shot', 'Tools', 'WebKitLibraries', 'CMakeLists.txt', 'vcpkg.json', 'tests/capi_thread_test.cpp', 'scripts/build-shot.ps1', 'scripts/slim-icu.ps1']) {
    assert.ok(CLOSURE.includes(wanted), `${wanted} is a build input`);
  }
  for (const excluded of ['docs', 'apps/node', 'apps/benchmark', 'ReadMe.md', 'AGENTS.md', 'scripts/release-notes.mjs', 'tests/leak_harness.cpp', 'upstream-sync']) {
    assert.ok(!CLOSURE.some((entry) => entry === excluded || entry.startsWith(`${excluded}/`)), `${excluded} is not a build input`);
  }
});

test('the id follows the entries and the extras, and nothing else', () => {
  const base = fingerprint(listing, { 'node-api-headers': '1.9.0', lto: 'full' });
  assert.match(base.id, /^[0-9a-f]{16}$/);
  assert.equal(base.full.length, 64);
  assert.equal(base.entries, 2);
  assert.equal(fingerprint(listing, { 'node-api-headers': '1.9.0', lto: 'full' }).id, base.id, 'deterministic');
  assert.notEqual(fingerprint(listing.replace('1'.repeat(40), '3'.repeat(40)), { 'node-api-headers': '1.9.0', lto: 'full' }).id, base.id, 'a blob change');
  assert.notEqual(fingerprint(listing.replace('100755', '100644'), { 'node-api-headers': '1.9.0', lto: 'full' }).id, base.id, 'a mode change');
  assert.notEqual(fingerprint(listing, { 'node-api-headers': '1.10.0', lto: 'full' }).id, base.id, 'a node-api-headers bump');
  assert.notEqual(fingerprint(listing, { 'node-api-headers': '1.9.0', lto: 'thin' }).id, base.id, 'the LTO mode');
  assert.throws(() => fingerprint('garbage' + nul, {}), /unexpected ls-tree record/);
});

test('the SDK contributes only its node-api-headers pin', () => {
  assert.match(nodeApiHeadersVersion(), /^\d+\.\d+\.\d+$/);
});

test('the real tree hashes the same twice and differently under thin LTO', () => {
  const a = compute({ ref: 'HEAD' });
  const b = compute({ ref: 'HEAD' });
  assert.equal(a.id, b.id);
  assert.ok(a.entries > 1000, `the closure holds ${a.entries} files`);
  assert.notEqual(compute({ ref: 'HEAD', lto: 'thin' }).id, a.id);
});
