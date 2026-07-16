import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const demoDirectory = path.dirname(fileURLToPath(import.meta.url));
const browserRoot = path.join(demoDirectory, '.browsers');
const npx = 'npx';

function run(command: string, args: string[], extraEnvironment: NodeJS.ProcessEnv = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: demoDirectory,
      env: { ...process.env, ...extraEnvironment },
      shell: process.platform === 'win32',
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

console.log('Installing Puppeteer Chrome and Firefox...');
const puppeteerEnvironment = {
  PUPPETEER_CACHE_DIR: path.join(browserRoot, 'puppeteer'),
};
await run(npx, ['puppeteer', 'browsers', 'install', 'chrome'], puppeteerEnvironment);
await run(npx, ['puppeteer', 'browsers', 'install', 'firefox'], puppeteerEnvironment);

console.log('Installing Playwright Chromium, Firefox, and WebKit...');
await run(npx, ['playwright', 'install', 'chromium', 'firefox', 'webkit'], {
  PLAYWRIGHT_BROWSERS_PATH: path.join(browserRoot, 'playwright'),
});

console.log(`Browsers installed under ${browserRoot}`);
