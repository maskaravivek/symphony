import { execFile, spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

import { startDashboardServer, type StartedDashboardServer } from './dashboard/server.js';

interface DevRunConfig {
  runArgs: string[];
  dashboard: {
    config?: string;
    workflow?: string;
  };
}

function valueAfter(args: string[], longName: string, shortName: string): string | null {
  let value: string | null = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === longName || arg === shortName) {
      value = args[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (arg.startsWith(`${longName}=`)) value = arg.slice(longName.length + 1);
  }
  return value;
}

function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function parseNonNegativeIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function resolveDevRunConfig(argv: string[]): DevRunConfig {
  const runArgs = argv[0] === 'run' ? argv.slice(1) : ['--config', './symphony.config.yml', ...argv];
  const config = valueAfter(runArgs, '--config', '-c');
  const workflow = valueAfter(runArgs, '--workflow', '-w') ?? 'WORKFLOW.md';
  return {
    runArgs,
    dashboard: config ? { config } : { workflow },
  };
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = execFile(command, args, (err) => {
    if (!err) return;
    // eslint-disable-next-line no-console
    console.warn(`Could not open dashboard in browser: ${err.message}`);
  });
  child.unref();
}

function startRunProcess(runArgs: string[]): ChildProcess {
  const tsxPath = path.resolve('node_modules/tsx/dist/cli.mjs');
  return spawn(process.execPath, [tsxPath, 'src/index.ts', 'run', ...runArgs], {
    stdio: 'inherit',
    env: process.env,
  });
}

async function closeDashboard(started: StartedDashboardServer | null): Promise<void> {
  if (!started) return;
  await new Promise<void>((resolve) => started.server.close(() => resolve()));
}

async function main(): Promise<void> {
  const config = resolveDevRunConfig(process.argv.slice(2));
  const dashboard = await startDashboardServer({
    ...config.dashboard,
    host: process.env.SYMPHONY_DASHBOARD_HOST ?? '127.0.0.1',
    port: parseNonNegativeIntegerEnv('SYMPHONY_DASHBOARD_PORT', 3766),
    refreshMs: parsePositiveIntegerEnv('SYMPHONY_DASHBOARD_REFRESH_MS', 5000),
  });

  // eslint-disable-next-line no-console
  console.log(`Symphony dashboard: ${dashboard.url}`);
  openBrowser(dashboard.url);

  const runProcess = startRunProcess(config.runArgs);
  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    runProcess.kill(signal);
  };

  process.once('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    shutdown('SIGTERM');
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    runProcess.on('error', reject);
    runProcess.on('exit', (code, signal) => {
      if (signal) resolve(signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
      else resolve(code ?? 0);
    });
  });

  await closeDashboard(dashboard);
  process.exitCode = exitCode;
}

await main();
