import { defineConfig } from 'tsdown';

export default defineConfig({
  // Two entries: the SDK, and the `shotkit` bin. They share src/executable.ts.
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm', 'cjs'],
  platform: 'node',
  dts: true,
  sourcemap: true,
  clean: true,
  // src/executable.ts reads __dirname to find the package root, so the ESM
  // output needs the shim.
  shims: true,
  // The package ships dual formats plus a bin; let the build fail on manifest
  // mistakes rather than discovering them after a publish.
  publint: true,
});
