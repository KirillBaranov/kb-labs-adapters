import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/manifest.ts'],
  format: ['esm'],
  dts: {
    compilerOptions: {
      skipLibCheck: true,
    },
  },
  clean: true,
  external: ['@kb-labs/core-platform'],
  treeshake: true,
  splitting: false,
});
