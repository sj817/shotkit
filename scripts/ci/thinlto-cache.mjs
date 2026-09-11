// Report actual linker-cache bytes before and after a thin build. The cache
// lives inside CCACHE_DIR so the existing ccache artifact persists both.
// File counts describe the directory, not linker hit/miss statistics.
import { appendFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const phase = process.argv[2];
if (!['restored', 'built'].includes(phase)) throw new Error('expected restored or built');
if (!process.env.CCACHE_DIR) throw new Error('CCACHE_DIR is required');
const directory = path.join(process.env.CCACHE_DIR, 'thinlto');
mkdirSync(directory, { recursive: true });
if (phase === 'restored' && process.env.GITHUB_ENV) {
  appendFileSync(process.env.GITHUB_ENV, `SHOT_THINLTO_CACHE_DIR=${directory}\n`);
}

let files = 0;
let bytes = 0;
function measure(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) measure(file);
    else if (entry.isFile()) {
      files++;
      bytes += statSync(file).size;
    }
  }
}
measure(directory);
console.log(`THINLTO_CACHE ${JSON.stringify({ phase, directory, files, bytes })}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `ThinLTO cache (${phase}): ${bytes} bytes, ${files} files.\n\n`);
}
