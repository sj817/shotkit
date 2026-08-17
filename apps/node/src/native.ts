import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { isMainThread } from 'node:worker_threads';

import { ShotKitError } from './error.js';

export interface NativeRenderRequest {
  kind: 'url' | 'html';
  input: string | Buffer;
  width: number;
  height: number;
  scale: number;
  fullPage: boolean;
  timeoutMs: number;
  allowFileURLs: boolean;
  format: number;
  quality: number;
  userAgent: string;
  baseURL: string;
  mimeType: string;
  selector: string;
}

export interface NativeRenderResult {
  data: Buffer;
  bytes: number;
  durationMs: number;
}

export interface NativeBinding {
  initialize(): Promise<void>;
  render(request: NativeRenderRequest): Promise<NativeRenderResult>;
}

const packageDirectory = path.dirname(__dirname);
export const platformKey = `${process.platform}-${process.arch}`;

function installedPlatformDirectory(requireFromPackage: NodeJS.Require): string | undefined {
  try {
    return path.dirname(requireFromPackage.resolve(`@shotkit/${platformKey}/package.json`));
  } catch {
    return undefined;
  }
}

function repositoryRoot(): string | undefined {
  let directory = packageDirectory;
  for (let depth = 0; depth < 6; ++depth) {
    if (existsSync(path.join(directory, 'WebKitBuild')) && existsSync(path.join(directory, 'shot')))
      return directory;
    const parent = path.dirname(directory);
    if (parent === directory)
      break;
    directory = parent;
  }
  return undefined;
}

export function resolveNativeAddon(): string {
  const requireFromPackage = createRequire(path.join(packageDirectory, 'package.json'));
  const installed = installedPlatformDirectory(requireFromPackage);
  const root = repositoryRoot();
  const candidates = [
    process.env.SHOTKIT_NATIVE_PATH,
    installed && path.join(installed, 'shot.node'),
    path.join(packageDirectory, 'npm', platformKey, 'shot.node'),
    root && path.join(root, 'WebKitBuild', 'shot', 'bin', 'shot.node'),
  ].filter((candidate): candidate is string => !!candidate).map((candidate) => path.resolve(candidate));

  for (const candidate of candidates) {
    if (existsSync(candidate))
      return candidate;
  }
  throw new ShotKitError(`shot.node not found for ${platformKey}; install @shotkit/${platformKey} or set SHOTKIT_NATIVE_PATH`);
}

let cachedBinding: NativeBinding | undefined;

export function loadNativeBinding(): NativeBinding {
  if (!isMainThread)
    throw new ShotKitError('@shotkit/node 0.2 only supports the main Node environment; worker_threads are not supported');
  if (cachedBinding)
    return cachedBinding;
  const requireFromPackage = createRequire(path.join(packageDirectory, 'package.json'));
  try {
    cachedBinding = requireFromPackage(resolveNativeAddon()) as NativeBinding;
    return cachedBinding;
  } catch (error) {
    if (error instanceof ShotKitError)
      throw error;
    throw new ShotKitError(`failed to load shot.node: ${error instanceof Error ? error.message : String(error)}`);
  }
}
