import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec = promisify(execFile);
const helper = path.resolve('.agents/skills/symphony-onboard-repo/scripts/native-check.mjs');

test('side-project native checks skip absent infrastructure but preserve actual code failures', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-native-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  await fs.mkdir(path.join(root, 'jdk/bin'), {recursive: true});
  await fs.writeFile(path.join(root, 'jdk/bin/java'), '#!/bin/sh\nexit 0\n', {mode: 0o755});
  const env = {...process.env, JAVA_HOME: path.join(root, 'jdk'), ANDROID_HOME: root};
  const run = (args: string[], extra = {}) => exec(process.execPath, [helper, '--platform', 'android', ...args], {cwd: root, env: {...env, ...extra}});
  assert.match((await run(['--probe'], {JAVA_HOME: '/missing-jdk'})).stdout, /skipped.*Java unavailable/);
  assert.match((await run(['--probe', '--require-file', 'missing-config'])).stdout, /skipped.*configuration/);
  assert.match((await run(['--', process.execPath, '-e', 'console.error("File google-services.json is missing");process.exit(1)'])).stdout, /skipped.*configuration/);
  await assert.rejects(run(['--', process.execPath, '-e', 'console.error("Compilation error: unresolved reference");process.exit(3)']), (error: any) => error.code === 3);
  assert.match((await run(['--', process.execPath, '-e', 'console.log("tests passed")'])).stdout, /android: passed/);
  await assert.rejects(run(['--', '/missing-command']));
  const results = (await fs.readFile(path.join(root, '.symphony/native-checks.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(results.map(result => result.status), ['skipped', 'skipped', 'skipped', 'failed', 'passed']);
});
