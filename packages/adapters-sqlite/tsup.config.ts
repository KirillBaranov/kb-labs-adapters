import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/secure-sql.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
});
