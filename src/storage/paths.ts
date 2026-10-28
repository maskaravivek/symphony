import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/** Reject redirected paths, allowing macOS's standard /var and /tmp system aliases. */
export async function safeStoragePath(root: string): Promise<boolean> {
  const resolved = path.resolve(root);
  if (resolved === path.parse(resolved).root || resolved === os.homedir()) return false;
  const expected = process.platform === 'darwin' ? resolved.replace(/^\/(?:var|tmp)(?=\/|$)/, '/private$&') : resolved;
  return await fs.realpath(resolved).then(real => real === expected, () => false);
}
