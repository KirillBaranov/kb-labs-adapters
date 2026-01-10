import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  external: ['@kb-labs/core-platform', '@kb-labs/adapters-sqlite', 'better-sqlite3'],
  treeshake: true,
  splitting: false,
});
