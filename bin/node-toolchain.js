import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** Expose only Node, preserving PATH resolution of the repo's package manager. */
export async function nodeToolchainPath(executable = process.execPath) {
  const target = await fs.realpath(executable);
  const key = createHash('sha256').update(target).update(process.version).digest('hex').slice(0, 16);
  const directory = fileURLToPath(new URL(`../.symphony/toolchains/node-${key}/`, import.meta.url));
  const entry = path.join(directory, process.platform === 'win32' ? 'node.exe' : 'node');
  await fs.mkdir(directory, { recursive: true });
  try {
    if (process.platform === 'win32') await fs.copyFile(target, entry, constants.COPYFILE_EXCL);
    else await fs.symlink(target, entry);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (process.platform !== 'win32' && await fs.realpath(entry) !== target) throw new Error('Node toolchain cache points to a different executable');
  }
  return directory;
}
