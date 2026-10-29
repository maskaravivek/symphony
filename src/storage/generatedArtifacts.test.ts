import test from 'node:test';
import assert from 'node:assert/strict';
import { generatedOutput } from './generatedArtifacts.js';

test('recognizes common generated caches and reports without treating local data as output', () => {
  for (const name of ['apps/app/tsconfig.tsbuildinfo', '.eslintcache', '.stylelintcache', '.DS_Store', 'npm-debug.log', 'yarn-debug.log', 'pnpm-debug.log', '.parcel-cache/', 'node_modules/.vite/', '.nuxt/', '.svelte-kit/', '__pycache__/module.pyc', '.pytest_cache/', '.mypy_cache/', '.ruff_cache/', '.angular/cache/', '.nx/cache/', '.wrangler/tmp/', '.expo/cache/', '.coverage', 'coverage.xml']) {
    assert.equal(generatedOutput(name), true, name);
  }
  for (const name of ['.env', '.env.local', '.npmrc', 'notes.log', 'backup.sql', '.wrangler/state/', '.nx/project.json', '.angular/config.json', 'src/main.ts', 'package.json', 'data.sqlite']) {
    assert.equal(generatedOutput(name), false, name);
  }
});
