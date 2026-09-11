// Find the engine and cache artifacts by name, with the trust rules every
// consumer applies.
//
// The artifacts API lists every artifact in the repository, including what
// a fork's pull request uploaded, and a fork can name an upload anything.
// So a record counts only when the run that made it ran from this
// repository's own code -- head repository equals repository -- or when it
// is the current run's own upload, which a fork PR needs to verify what it
// just built. The chosen run must also be one of the workflows that build
// engines, so a stray upload from another workflow is never mistaken for
// one.
//
//   node scripts/ci/artifacts.mjs find --name <n> [--name <n2> ...] [--require-all]
//   node scripts/ci/artifacts.mjs plan --fingerprint <fp> [--force]
//   node scripts/ci/artifacts.mjs newest --prefix <p>
//
// Every subcommand writes its result to $GITHUB_OUTPUT when set, and `find`
// and `plan` add a table to $GITHUB_STEP_SUMMARY. Environment:
// GITHUB_TOKEN (or GH_TOKEN), GITHUB_REPOSITORY, GITHUB_RUN_ID.

import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RETENTION_DAYS = 90;
export const OSES = ['windows', 'linux', 'macos'];
export const ARCHES = ['x64', 'arm64'];
export const PRODUCERS = new Set([
  '.github/workflows/build.yml', '.github/workflows/build-windows.yml', '.github/workflows/build-linux.yml',
  '.github/workflows/build-macos.yml', '.github/workflows/preview.yml', '.github/workflows/publish.yml',
  '.github/workflows/refresh.yml',
]);

export const names = (os, arch, fingerprint) => ({
  engine: `engine-${os}-${arch}-${fingerprint}`,
  node: `engine-node-${os}-${arch}-${fingerprint}`,
});

export function trusted(record, currentRunId) {
  if (record.expired || !record.workflow_run) return false;
  if (currentRunId !== undefined && record.workflow_run.id === currentRunId) return true;
  return record.workflow_run.head_repository_id === record.workflow_run.repository_id;
}

const newestFirst = (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at);

/** Non-expired artifacts with exactly this name, newest first. */
export async function listByName(api, name) {
  const records = [];
  for (let page = 1; page <= 10; page++) {
    const result = await api(`actions/artifacts?name=${encodeURIComponent(name)}&per_page=100&page=${page}`);
    records.push(...result.artifacts);
    if (records.length >= result.total_count || result.artifacts.length === 0) break;
  }
  return records.filter((r) => !r.expired).sort(newestFirst);
}

async function producedByBuildWorkflow(api, runId) {
  const run = await api(`actions/runs/${runId}`);
  return typeof run.path === 'string' && PRODUCERS.has(run.path);
}

/** The newest trusted artifact with this name, or null. */
export async function findOne(api, name, currentRunId) {
  for (const record of (await listByName(api, name)).filter((r) => trusted(r, currentRunId))) {
    if (await producedByBuildWorkflow(api, record.workflow_run.id)) return record;
  }
  return null;
}

// An engine counts only when its archive and its node runtime come from the
// same trusted run; half a platform is not a platform.
export async function findEngine(api, os, arch, fingerprint, currentRunId) {
  const n = names(os, arch, fingerprint);
  const engines = (await listByName(api, n.engine)).filter((r) => trusted(r, currentRunId));
  const nodes = (await listByName(api, n.node)).filter((r) => trusted(r, currentRunId));
  for (const engine of engines) {
    const node = nodes.find((r) => r.workflow_run.id === engine.workflow_run.id);
    if (!node) continue;
    if (!(await producedByBuildWorkflow(api, engine.workflow_run.id))) continue;
    return { runId: engine.workflow_run.id, engine, node };
  }
  return null;
}

/** Which architectures each OS still has to build at this fingerprint. */
export async function plan(api, fingerprint, force, currentRunId) {
  const build = { windows: [], linux: [], macos: [] };
  const present = [];
  for (const os of OSES) {
    for (const arch of ARCHES) {
      const found = force ? null : await findEngine(api, os, arch, fingerprint, currentRunId);
      if (found) present.push({ os, arch, runId: found.runId });
      else build[os].push(arch);
    }
  }
  const missing = OSES.flatMap((os) => build[os].map((arch) => `${os}-${arch}`));
  return { fingerprint, build, present, missing, complete: missing.length === 0 };
}

export function planOutputs(result) {
  const lines = [`fingerprint=${result.fingerprint}`];
  for (const os of OSES) lines.push(`${os}=${JSON.stringify(result.build[os])}`);
  lines.push(`build=${!result.complete}`, `missing=${result.missing.join(',')}`, `complete=${result.complete}`);
  return lines.join('\n') + '\n';
}

// --- the command line -------------------------------------------------------

export function githubApi(repo, token) {
  return async (route, init = {}) => {
    let last;
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await fetch(`https://api.github.com/repos/${repo}/${route}`, {
        method: init.method ?? 'GET',
        headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) return response.status === 204 ? null : response.json();
      last = new Error(`GitHub API ${response.status} ${response.statusText} for ${route}`);
      if (response.status < 500 && response.status !== 429) throw last;
      await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
    }
    throw last;
  };
}

function environment() {
  const repo = process.env.GITHUB_REPOSITORY ?? 'sj817/shotkit';
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '';
  if (!token) throw new Error('GITHUB_TOKEN (or GH_TOKEN) is not set');
  const currentRunId = process.env.GITHUB_RUN_ID ? Number(process.env.GITHUB_RUN_ID) : undefined;
  return { repo, api: githubApi(repo, token), currentRunId };
}

function output(text) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, text);
}

function summary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
}

function values(flag) {
  const found = [];
  for (let i = 0; i < process.argv.length; i++) if (process.argv[i] === `--${flag}`) found.push(process.argv[i + 1]);
  return found.filter((v) => v !== undefined);
}

async function main() {
  const command = process.argv[2];
  const { repo, api, currentRunId } = environment();
  if (command === 'find') {
    const wanted = values('name');
    if (wanted.length === 0) throw new Error('find needs at least one --name');
    const found = [];
    const missing = [];
    for (const name of wanted) {
      const record = await findOne(api, name, currentRunId);
      if (record) found.push({ name, record });
      else missing.push(name);
    }
    for (const { name, record } of found) console.log(`${name}: run ${record.workflow_run.id}, artifact ${record.id}, ${(record.size_in_bytes / 1e6).toFixed(1)} MB, expires ${record.expires_at}`);
    for (const name of missing) console.log(`${name}: not found`);
    output(`ids=${found.map((f) => f.record.id).join(',')}\nfound=${missing.length === 0}\nmissing=${missing.join(',')}\n`);
    summary(`| artifact | source |\n| --- | --- |\n${wanted.map((name) => {
      const hit = found.find((f) => f.name === name);
      return `| ${name} | ${hit ? `[run ${hit.record.workflow_run.id}](https://github.com/${repo}/actions/runs/${hit.record.workflow_run.id})` : 'not found'} |`;
    }).join('\n')}\n\n`);
    if (missing.length > 0 && process.argv.includes('--require-all')) throw new Error(`missing artifacts: ${missing.join(', ')}`);
    return;
  }
  if (command === 'plan') {
    const fingerprint = values('fingerprint')[0];
    if (!/^[0-9a-f]{16}$/.test(fingerprint ?? '')) throw new Error('plan needs --fingerprint <16 hex>');
    const result = await plan(api, fingerprint, process.argv.includes('--force'), currentRunId);
    for (const os of OSES) for (const arch of ARCHES) {
      const hit = result.present.find((p) => p.os === os && p.arch === arch);
      console.log(`  ${`${os}-${arch}`.padEnd(14)} ${hit ? `run ${hit.runId}` : 'to build'}`);
    }
    output(planOutputs(result));
    summary(`### engine ${fingerprint}\n\n| platform | engine + node runtime |\n| --- | --- |\n${OSES.flatMap((os) => ARCHES.map((arch) => {
      const hit = result.present.find((p) => p.os === os && p.arch === arch);
      return `| ${os}-${arch} | ${hit ? `[run ${hit.runId}](https://github.com/${repo}/actions/runs/${hit.runId})` : 'to build'} |`;
    })).join('\n')}\n\n`);
    return;
  }
  if (command === 'newest') {
    const prefix = values('prefix')[0];
    if (!prefix) throw new Error('newest needs --prefix');
    const records = [];
    for (let page = 1; page <= 20; page++) {
      const result = await api(`actions/artifacts?per_page=100&page=${page}`);
      records.push(...result.artifacts.filter((r) => r.name.startsWith(prefix) && trusted(r, currentRunId)));
      if (result.artifacts.length < 100) break;
    }
    records.sort(newestFirst);
    const record = records[0];
    if (!record) throw new Error(`no trusted artifact named ${prefix}*`);
    console.log(`${record.name}: run ${record.workflow_run.id}, artifact ${record.id}, expires ${record.expires_at}`);
    output(`name=${record.name}\nid=${record.id}\nrun_id=${record.workflow_run.id}\n`);
    return;
  }
  throw new Error('usage: artifacts.mjs <find|plan|newest> ...');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
