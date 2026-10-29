import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// The installed Yarn 1 promise queue, reduced only to remove Babel's Promise alias.
const source = `function queue(arr, promiseProducer) {
  var concurrency = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : Infinity;
  concurrency = Math.min(concurrency, arr.length);
  arr = arr.slice();
  var results = [];
  var total = arr.length;
  if (!total) return Promise.resolve(results);
  return new Promise(function (resolve, reject) {
    for (var i = 0; i < concurrency; i++) next();
    function next() {
      var item = arr.shift();
      var promise = promiseProducer(item);
      promise.then(function (result) {
        results.push(result); total--;
        if (total === 0) resolve(results);
        else { if (arr.length) { next(); } }
      }, reject);
    }
  });
}
/***/ }),`;
const moduleURL = new URL('../../bin/yarn-classic-queue.js', import.meta.url).href;

test('indexed Yarn queue handles every file once while preserving concurrency, errors and empty inputs', async () => {
  const { patchClassicQueue } = await import(moduleURL);
  const patched = patchClassicQueue(source);
  assert.doesNotMatch(patched, /arr\.shift\(/);
  const queue = vm.runInNewContext(patched.slice(0, patched.indexOf('\n/***/ }),')) + '; queue', { Promise });
  const items = Array.from({ length: 100000 }, (_, i) => i);
  let running = 0, maximum = 0;
  const seen = new Set<number>();
  const result = await queue(items, async (item: number) => {
    assert.ok(!seen.has(item)); seen.add(item);
    running++; maximum = Math.max(maximum, running);
    await Promise.resolve(); running--; return item;
  }, 4);
  assert.equal(seen.size, items.length);
  assert.equal(result.length, items.length);
  assert.equal(maximum, 4);
  assert.equal(items[0], 0);
  assert.equal((await queue([], async () => 0)).length, 0);
  await assert.rejects(queue([1], async () => { throw Error('copy failure'); }), /copy failure/);
  assert.throws(() => patchClassicQueue('unrecognized queue'), /Unsupported/);
});

test('Yarn runner creates a verified local copy and leaves the installed package unchanged', async t => {
  const { classicRunner } = await import(moduleURL);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-yarn-runner-'));
  const home = process.env.COREPACK_HOME;
  t.after(async () => { if (home === undefined) delete process.env.COREPACK_HOME; else process.env.COREPACK_HOME = home; await fs.rm(root, { recursive: true, force: true }); });
  process.env.COREPACK_HOME = root;
  const pkg = path.join(root, 'v1/yarn/1.22.22');
  await fs.mkdir(path.join(pkg, 'lib'), { recursive: true }); await fs.mkdir(path.join(pkg, 'bin'));
  await fs.writeFile(path.join(pkg, 'package.json'), '{"name":"yarn","version":"1.22.22"}');
  await fs.writeFile(path.join(pkg, 'lib/cli.js'), source);
  await fs.writeFile(path.join(pkg, 'bin/yarn.js'), '// Yarn fixture entry');
  const cache = path.join(root, 'toolchains');
  const entry = await classicRunner('1.22.22', cache);
  assert.equal(await classicRunner('1.22.22', cache), entry);
  assert.equal(await fs.readFile(path.join(pkg, 'lib/cli.js'), 'utf8'), source);
  assert.doesNotMatch(await fs.readFile(path.resolve(entry, '../../lib/cli.js'), 'utf8'), /arr\.shift\(/);
  assert.equal(await classicRunner('4.0.0', cache), null);
});
