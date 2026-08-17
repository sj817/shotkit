import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  platform: 'node',
  dts: true,
  sourcemap: true,
  clean: true,
  // src/native.ts reads __dirname to find the package root, so the ESM output
  // needs the shim.
  shims: true,
  // The package ships dual module formats; let the build fail on manifest
  // mistakes rather than discovering them after a publish.
  publint: true,
});
