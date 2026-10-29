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
