import { execFileSync } from 'node:child_process';

import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: false,
  dts: false,
  bundle: true,
  // The dashboard UI is static HTML/CSS/JS served from dist/ui at runtime (see src/dashboard/static.ts).
  async onSuccess() {
    execFileSync('rm', ['-rf', 'dist/ui']);
    execFileSync('cp', ['-R', 'src/dashboard/ui', 'dist/ui']);
    // Development-only fixtures and unit tests do not ship.
    execFileSync('rm', ['-rf', 'dist/ui/mock']);
    execFileSync('find', ['dist/ui', '-name', '*.test.mjs', '-delete']);
  },
});
