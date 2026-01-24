import { defineConfig } from 'tsup';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export default defineConfig({
  entry: ['src/index.ts', 'src/manifest.ts'],
  format: ['esm'],
  dts: {
    compilerOptions: {
      skipLibCheck: true,
    },
  },
  clean: true,
  external: ['@kb-labs/core-platform', '@kb-labs/adapters-sqlite', 'better-sqlite3'],
  treeshake: true,
  splitting: false,
  onSuccess: async () => {
    // Copy schema.sql to dist
    const srcSchema = join(process.cwd(), 'src/schema.sql');
    const distSchema = join(process.cwd(), 'dist/schema.sql');

    mkdirSync(dirname(distSchema), { recursive: true });
    copyFileSync(srcSchema, distSchema);

    console.log('✓ Copied schema.sql to dist/');
  },
});
