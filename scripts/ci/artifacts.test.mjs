// The lookup decides what a release ships, so every rule that keeps the
// wrong bytes out is pinned here: a fork's upload is not an engine, an
// archive without the node runtime from the same run is not an engine, and
// an upload from a workflow that does not build engines is not one either.
import assert from 'node:assert/strict';
import test from 'node:test';

import { downloadArguments, findEngine, findOne, listByName, names, plan, planOutputs, trusted } from './artifacts.mjs';

const REPO = 100;
const FORK = 200;
const FP = '8f3fb32d581651f7';
let nextId = 1;

function record(name, run, extra = {}) {
  return {
    id: nextId++, name, size_in_bytes: 1, expired: extra.expired ?? false,
    created_at: extra.at ?? `2026-09-${String((run % 28) + 1).padStart(2, '0')}T00:00:00Z`,
    expires_at: '2026-12-01T00:00:00Z',
    workflow_run: { id: run, repository_id: REPO, head_repository_id: extra.head ?? REPO, head_branch: 'main', head_sha: 'abc' },
  };
}

// A stub of the two routes the module reads.
function api(records, runs = {}) {
  return async (route) => {
    const list = /^actions\/artifacts\?name=([^&]+)&per_page=100&page=(\d+)$/.exec(route);
    if (list) {
      const matching = records.filter((r) => r.name === decodeURIComponent(list[1]));
      return { total_count: matching.length, artifacts: Number(list[2]) === 1 ? matching : [] };
    }
    const run = /^actions\/runs\/(\d+)$/.exec(route);
    if (run) return { path: runs[Number(run[1])] ?? '.github/workflows/build-linux.yml' };
    throw new Error(`unexpected route ${route}`);
  };
}

test('trust: this repository or this run; never a fork, never expired', () => {
  assert.equal(trusted(record('x', 1)), true);
  assert.equal(trusted(record('x', 1, { head: FORK })), false);
  assert.equal(trusted(record('x', 1, { head: FORK }), 1), true, 'a fork PR may use what its own run built');
  assert.equal(trusted(record('x', 1, { head: FORK }), 2), false);
  assert.equal(trusted(record('x', 1, { expired: true })), false);
  assert.equal(trusted({ ...record('x', 1), workflow_run: null }), false);
});

test('listByName drops expired records and orders newest first', async () => {
  const records = [record('a', 1, { at: '2026-09-01T00:00:00Z' }), record('a', 2, { at: '2026-09-03T00:00:00Z' }), record('a', 3, { expired: true }), record('b', 4)];
  assert.deepEqual((await listByName(api(records), 'a')).map((r) => r.workflow_run.id), [2, 1]);
});

test('findOne skips uploads from workflows that do not build engines', async () => {
  const records = [record('ccache-linux-x64', 5, { at: '2026-09-05T00:00:00Z' }), record('ccache-linux-x64', 4, { at: '2026-09-04T00:00:00Z' })];
  assert.equal((await findOne(api(records, { 5: '.github/workflows/node.yml' }), 'ccache-linux-x64'))?.workflow_run.id, 4);
  assert.equal(await findOne(api([]), 'ccache-linux-x64'), null);
});

test('an engine counts only with its node runtime from the same trusted run', async () => {
  const n = names('linux', 'x64', FP);
  assert.deepEqual(n, { engine: `engine-linux-x64-${FP}`, node: `engine-node-linux-x64-${FP}` });
  const records = [
    record(n.engine, 1, { at: '2026-09-01T00:00:00Z' }), record(n.node, 1, { at: '2026-09-01T00:00:00Z' }),
    record(n.engine, 2, { at: '2026-09-02T00:00:00Z' }), record(n.node, 2, { at: '2026-09-02T00:00:00Z' }),
    record(n.engine, 3, { at: '2026-09-03T00:00:00Z' }),   // archive only: half a platform
  ];
  assert.equal((await findEngine(api(records), 'linux', 'x64', FP))?.runId, 2);
  const forked = [...records, record(n.engine, 4, { head: FORK, at: '2026-09-04T00:00:00Z' }), record(n.node, 4, { head: FORK, at: '2026-09-04T00:00:00Z' })];
  assert.equal((await findEngine(api(forked), 'linux', 'x64', FP))?.runId, 2);
  assert.equal((await findEngine(api(forked), 'linux', 'x64', FP, 4))?.runId, 4);
  const crossed = [record(n.engine, 5), record(n.node, 6)];
  assert.equal(await findEngine(api(crossed), 'linux', 'x64', FP), null);
  const stray = [record(n.engine, 7), record(n.node, 7)];
  assert.equal(await findEngine(api(stray, { 7: '.github/workflows/commit-lint.yml' }), 'linux', 'x64', FP), null);
  assert.equal((await findEngine(api(stray, { 7: '.github/workflows/preview.yml' }), 'linux', 'x64', FP))?.runId, 7);
});

test('plan lists what each OS still has to build, and --force builds everything', async () => {
  const have = [['linux', 'x64'], ['macos', 'x64'], ['macos', 'arm64']];
  const records = have.flatMap(([os, arch], i) => [record(names(os, arch, FP).engine, i + 1), record(names(os, arch, FP).node, i + 1)]);
  const result = await plan(api(records), FP, false);
  assert.deepEqual(result.build, { windows: ['x64', 'arm64'], linux: ['arm64'], macos: [] });
  assert.deepEqual(result.missing, ['windows-x64', 'windows-arm64', 'linux-arm64']);
  assert.equal(planOutputs(result), `fingerprint=${FP}\nwindows=["x64","arm64"]\nlinux=["arm64"]\nmacos=[]\nbuild=true\nmissing=windows-x64,windows-arm64,linux-arm64\ncomplete=false\n`);
  assert.equal((await plan(api(records), FP, true)).missing.length, 6);
  const all = OSES_ALL().flatMap(([os, arch], i) => [record(names(os, arch, FP).engine, i + 10), record(names(os, arch, FP).node, i + 10)]);
  const done = await plan(api(all), FP, false);
  assert.deepEqual([done.complete, done.build], [true, { windows: [], linux: [], macos: [] }]);
  assert.match(planOutputs(done), /build=false\nmissing=\ncomplete=true\n$/);
});

function OSES_ALL() {
  return ['windows', 'linux', 'macos'].flatMap((os) => ['x64', 'arm64'].map((arch) => [os, arch]));
}

test('download fetches from the run that uploaded the artifact', () => {
  const record = { id: 9, name: 'ccache-linux-x64', workflow_run: { id: 34578049899 } };
  assert.deepEqual(
    downloadArguments('sj817/shotkit', record, 'ccache-linux-x64', '/tmp/ccache-dl'),
    ['run', 'download', '34578049899', '-R', 'sj817/shotkit', '-n', 'ccache-linux-x64', '-D', '/tmp/ccache-dl'],
  );
});
