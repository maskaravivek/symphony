import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dependencyHelperPath } from '../utils/runtimePaths.js';
const exec = promisify(execFile);

test('dependency reuse is invalidated by manifests, toolchain inputs, missing modules and failed installs', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-dependencies-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await exec('git', ['init', '-q'], { cwd: root });
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"fixture"}');
  await fs.writeFile(path.join(root, 'package-lock.json'), '{}');
  await exec('git', ['add', '.'], { cwd: root });
  const bin = path.join(root, 'bin'); await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'npm'), '#!/bin/sh\nif [ "$1" = --version ]; then echo 10; exit 0; fi\necho install >> installs\n[ "$FAIL_INSTALL" = 1 ] && exit 1\nmkdir -p node_modules\ntouch node_modules/.package-lock.json\n', { mode: 0o755 });
  const run = (env: Record<string, string> = {}) => exec(process.execPath, [dependencyHelperPath(), '--', 'npm', 'ci'], { cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env } });
  const count = async () => (await fs.readFile(path.join(root, 'installs'), 'utf8')).trim().split('\n').length;
  assert.match((await run()).stdout, /cold workspace/);
  assert.match((await run()).stdout, /Reusing dependencies/); assert.equal(await count(), 1);
  await fs.mkdir(path.join(root, 'scripts'));
  await fs.writeFile(path.join(root, 'scripts/symphony-native-check.mjs'), '// validation-only helper');
  assert.match((await run()).stdout, /Reusing dependencies/);
  assert.equal(await count(), 1, 'Native validation policy changes must not reinstall dependencies');
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"fixture","scripts":{"postinstall":"echo changed"}}');
  await run(); assert.equal(await count(), 2);
  await fs.rm(path.join(root, 'node_modules'), { recursive: true });
  await run(); assert.equal(await count(), 3);
  await assert.rejects(run({ SYMPHONY_FORCE_INSTALL: '1', FAIL_INSTALL: '1' }));
  await assert.rejects(fs.access(path.join(root, '.symphony', 'dependencies.json')));
  await run(); assert.equal(await count(), 5);
  await run({ NODE_ENV: 'production' }); assert.equal(await count(), 6);
});


test('dependency helper restores the selected Node after shell PATH drift and pins child scripts', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-node-selection-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await exec('git', ['init', '-q'], { cwd: root });
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"fixture"}');
  await exec('git', ['add', '.'], { cwd: root });
  const selected = path.join(root, 'selected'), drifted = path.join(root, 'drifted');
  await fs.mkdir(selected); await fs.mkdir(drifted);
  const node = path.join(selected, process.platform === 'win32' ? 'node.exe' : 'node');
  await fs.link(process.execPath, node).catch(() => fs.copyFile(process.execPath, node));
  await fs.writeFile(path.join(drifted, 'node'), '#!/bin/sh\necho wrong-node >&2\nexit 42\n', { mode: 0o755 });
  await fs.writeFile(path.join(drifted, 'npm'), `#!/usr/bin/env node
const fs = require('fs');
if (process.argv.includes('--version')) console.log('10');
else { fs.mkdirSync('node_modules', {recursive:true}); fs.writeFileSync('node_modules/.package-lock.json', '{}'); fs.writeFileSync('selected-node', process.execPath); }
`, { mode: 0o755 });
  const run = () => exec(process.execPath, [dependencyHelperPath(), '--', 'npm', 'ci'], { cwd: root,
    env: { ...process.env, SYMPHONY_NODE_EXECUTABLE: node, PATH: `${drifted}${path.delimiter}${process.env.PATH}` } });
  await run();
  assert.equal(await fs.readFile(path.join(root, 'selected-node'), 'utf8'), await fs.realpath(node));
  assert.match((await run()).stdout, /Reusing dependencies/);
});
