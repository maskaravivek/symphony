/** Cache metadata contains no authored source; staged changes still require attention. */
export function disposableCacheFile(name: string): boolean {
  return /(^|\/)[^/]+\.tsbuildinfo$/.test(name)
    || /(^|\/)(\.eslintcache|\.stylelintcache|\.DS_Store)$/.test(name);
}

/** Only ignored, known tool output is eligible; caller still checks ownership and tracked files. */
export function generatedOutput(name: string): boolean {
  return disposableCacheFile(name)
    || /(^|\/)(\.next|\.open-next|\.turbo|\.gradle|dist|build|coverage|test-results|playwright-report|blob-report|\.parcel-cache|\.vite|\.vitest|\.svelte-kit|\.nuxt|\.output|\.astro|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache)(\/|$)/.test(name)
    || /(^|\/)(\.angular|\.nx|\.expo)\/cache(\/|$)/.test(name)
    || /(^|\/)\.wrangler\/tmp(\/|$)/.test(name)
    || /(^|\/)(yarn-error|yarn-debug|npm-debug|pnpm-debug|lerna-debug)\.log(?:\.\d+)?$/.test(name)
    || /(^|\/)(\.coverage(?:\.[^/]+)?|coverage\.xml|lcov\.info)$/.test(name);
}

/** Porcelain -z preserves spaces/newlines in paths. Renames and staged changes are never discarded. */
export function unstagedCacheChanges(porcelain: string): string[] {
  return porcelain.split('\0').filter(entry => entry.startsWith(' M ') || entry.startsWith(' D '))
    .map(entry => entry.slice(3)).filter(disposableCacheFile);
}
