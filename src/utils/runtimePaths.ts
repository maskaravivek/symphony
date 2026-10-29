import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function dependencyHelperPath(): string {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  while (directory !== path.dirname(directory)) {
    const candidate = path.join(directory, 'bin', 'symphony-dependencies.js');
    if (existsSync(candidate)) return candidate;
    directory = path.dirname(directory);
  }
  throw new Error('Symphony dependency helper is missing from this installation');
}


export function nodeRuntimeInstructions(): string {
  return `\n\n## Node toolchain\nSymphony selected Node ${process.version} at ${process.execPath}. Login shells may reset PATH. Before running package-manager, build or test commands in each shell, run export PATH="$(dirname "$SYMPHONY_NODE_EXECUTABLE"):$PATH". Use "$SYMPHONY_NODE_EXECUTABLE" for Node scripts. The dependency helper automatically restores this runtime and pins it for install scripts. Preserve the repository's packageManager version; do not change pins or ignore engine checks to work around shell drift.\n`;
}
