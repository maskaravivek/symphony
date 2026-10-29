/** Only ignored, known tool output is eligible; caller still checks ownership and tracked files. */
export function generatedOutput(name: string): boolean {
  return /(^|\/)(\.next|\.open-next|\.turbo|\.gradle|dist|build|coverage|test-results|playwright-report|blob-report)(\/|$)/.test(name)
    || /(^|\/)yarn-error\.log$/.test(name);
}
