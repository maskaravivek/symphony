import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** Yarn 1's copy queue shifts a potentially enormous array for every file. */
export function patchClassicQueue(source) {
  const start = source.indexOf('function queue(arr, promiseProducer) {');
  const end = source.indexOf('\n/***/ }),', start);
  if (start < 0 || end < 0) throw new Error('Unsupported Yarn Classic queue implementation');
  let queue = source.slice(start, end);
  const changes = [
    ['var total = arr.length;', 'var total = arr.length;\n  var cursor = 0;'],
    ['var item = arr.shift();', 'var item = arr[cursor++];'],
    ['if (arr.length) {', 'if (cursor < arr.length) {'],
  ];
  for (const [before, after] of changes) {
    if (queue.split(before).length !== 2) throw new Error('Unsupported Yarn Classic queue implementation');
    queue = queue.replace(before, after);
  }
  return source.slice(0, start) + queue + source.slice(end);
}

export async function classicRunner(version, cacheDirectory) {
  if (!/^1\.22\.\d+$/.test(version)) return null;
  const homes = [process.env.COREPACK_HOME,
    path.join(os.homedir(), '.cache', 'node', 'corepack'),
    path.join(os.homedir(), 'Library', 'Caches', 'node', 'corepack'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'node', 'corepack')].filter(Boolean);
  const candidates = homes.map(home => path.join(home, 'v1', 'yarn', version));
  // Also support a standalone/global Yarn executable rather than Corepack.
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    const executable = await fs.realpath(path.join(directory, 'yarn')).catch(() => null);
    if (executable) candidates.push(path.dirname(path.dirname(executable)));
  }
  let root, original;
  for (const candidate of candidates) {
    const pkg = await fs.readFile(path.join(candidate, 'package.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (pkg?.name !== 'yarn' || pkg.version !== version) continue;
    const source = await fs.readFile(path.join(candidate, 'lib', 'cli.js'), 'utf8').catch(() => null);
    if (source) { root = candidate; original = source; break; }
  }
  if (!root) throw new Error(`Cannot locate Yarn ${version} source for the bounded-copy queue runner`);
  const patched = patchClassicQueue(original);
  const digest = createHash('sha256').update(patched).digest('hex');
  const cache = cacheDirectory ?? fileURLToPath(new URL('../.symphony/toolchains', import.meta.url));
  const destination = path.join(cache, `yarn-${version}-${digest.slice(0, 16)}`);
  const entry = path.join(destination, 'bin', 'yarn.js');
  const cached = await fs.readFile(path.join(destination, 'lib', 'cli.js'), 'utf8').catch(() => null);
  if (cached === patched && await fs.access(entry).then(() => true, () => false)) return entry;
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await fs.mkdir(path.join(temporary, 'bin'), { recursive: true });
  await fs.mkdir(path.join(temporary, 'lib'));
  try {
    await fs.copyFile(path.join(root, 'package.json'), path.join(temporary, 'package.json'));
    await fs.copyFile(path.join(root, 'bin', 'yarn.js'), path.join(temporary, 'bin', 'yarn.js'));
    await fs.writeFile(path.join(temporary, 'lib', 'cli.js'), patched);
    const license = await fs.readFile(path.join(root, 'LICENSE')).catch(() => null);
    if (license) await fs.writeFile(path.join(temporary, 'LICENSE'), license);
    await fs.rename(temporary, destination).catch(async error => {
      if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error;
      const existing = await fs.readFile(path.join(destination, 'lib', 'cli.js'), 'utf8');
      if (existing !== patched) throw new Error('Yarn runner cache failed verification');
    });
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  return entry;
}
