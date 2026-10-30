#!/usr/bin/env node
import { nodeToolchainPath } from './node-toolchain.js';
import { fileURLToPath } from 'node:url';
import { classicRunner } from './yarn-classic-queue.js';
// Kept as a standalone entry point so hooks and agents use the same install contract.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
const args = process.argv.slice(2).filter((value, index) => !(index === 0 && value === '--'));
const [command] = args;
if (!['npm', 'yarn'].includes(command) || !args.includes(command === 'npm' ? 'ci' : 'install')) throw new Error('Usage: symphony-dependencies.js -- npm ci | yarn install [flags]');
// Login shells can replace PATH after Symphony has selected its runtime.
const selectedNode = process.env.SYMPHONY_NODE_EXECUTABLE ?? process.execPath;
if (await fs.realpath(selectedNode) !== await fs.realpath(process.execPath)) {
  const child = spawnSync(selectedNode, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { env: process.env, stdio: 'inherit' });
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}
const toolchain = await nodeToolchainPath();
process.env.PATH = `${toolchain}${path.delimiter}${process.env.PATH ?? ''}`;
console.log(`Using Node ${process.version} from ${process.execPath}`);
const cwd = process.cwd();
const managerVersion = execFileSync(command, ['--version'], { encoding: 'utf8' }).trim();
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\0').filter(name =>
  // Symphony's native validation wrapper is never an installation input.
  name !== 'scripts/symphony-native-check.mjs' && (
    /(^|\/)(package.json|yarn.lock|package-lock.json|npm-shrinkwrap.json|\.npmrc|\.yarnrc|\.yarnrc.yml)$/.test(name) || /(^|\/)(scripts|\.yarn)\//.test(name)));
const hash = createHash('sha256').update(JSON.stringify({ args, node: process.version, platform: process.platform, arch: process.arch,
  manager: managerVersion, cwd: path.relative(root, cwd), nodeEnv: process.env.NODE_ENV ?? '', installEnv: Object.fromEntries(['npm_config_omit', 'npm_config_production', 'npm_config_ignore_scripts', 'YARN_PRODUCTION', 'npm_config_arch', 'npm_config_platform'].map(key => [key, process.env[key] ?? ''])) }));
for (const file of files.sort()) { hash.update(file); hash.update(await fs.readFile(path.join(root, file)).catch(() => Buffer.from('<missing>'))); }
const fingerprint = hash.digest('hex');
const directory = path.join(cwd, '.symphony'), stamp = path.join(directory, 'dependencies.json');
const previous = await fs.readFile(stamp, 'utf8').then(JSON.parse).catch(() => null);
const modules = await fs.lstat(path.join(cwd, 'node_modules')).catch(() => null);
const integrityFile = path.join(cwd, 'node_modules', command === 'npm' ? '.package-lock.json' : '.yarn-integrity');
const integrity = await fs.readFile(integrityFile).then(bytes => createHash('sha256').update(bytes).digest('hex'), () => null);
if (process.env.SYMPHONY_FORCE_INSTALL !== '1' && previous?.fingerprint === fingerprint && modules?.isDirectory() && integrity && previous.integrity === integrity) {
  console.log('Reusing dependencies: manifests, lockfiles, install scripts, toolchain and install mode are unchanged.');
} else {
  const reason = process.env.SYMPHONY_FORCE_INSTALL === '1' ? 'forced' : !modules?.isDirectory() ? 'cold workspace (node_modules missing)' : !previous ? 'install stamp missing' : previous.fingerprint !== fingerprint ? 'dependency inputs or toolchain changed' : 'integrity marker changed or missing';
  console.log(`Installing dependencies: ${reason}.`);
  const startedAt = Date.now();
  await fs.mkdir(directory, { recursive: true });
  // Invalidate before installing: a failed install must never leave a valid old stamp.
  await fs.rm(stamp, { force: true });
  const runner = command === 'yarn' ? await classicRunner(managerVersion) : null;
  if (runner) console.log('Using Symphony Yarn Classic runner with an indexed file-copy queue.');
  const child = spawn(runner ? process.execPath : command, runner ? [runner, ...args.slice(1)] : args.slice(1), { cwd, env: process.env, stdio: ['ignore', 'inherit', 'inherit'] });
  const exit = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code, signal) => resolve({ code, signal })); });
  if (exit.code !== 0 || exit.signal) process.exit(exit.code || 1);
  if (!(await fs.lstat(path.join(cwd, 'node_modules')).then(s => s.isDirectory(), () => false))) throw new Error('Install completed without node_modules');
  const temporary = `${stamp}.${process.pid}.tmp`;
  const installedIntegrity = await fs.readFile(integrityFile).then(bytes => createHash('sha256').update(bytes).digest('hex'), () => null);
  await fs.writeFile(temporary, JSON.stringify({ fingerprint, integrity: installedIntegrity }), { mode: 0o600 });
  await fs.rename(temporary, stamp);
  console.log(`Dependency installation completed in ${((Date.now() - startedAt) / 1000).toFixed(1)}s; matching subsequent runs reuse this workspace.`);
}
