import assert from 'node:assert/strict';
import test from 'node:test';

import { signalRunProcess, spawnRunProcess } from './devProcess.js';

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('condition was not met before timeout');
}

test('force signaling a run process terminates its nested child process', { skip: process.platform === 'win32' }, async () => {
  const nestedScript = 'setInterval(() => {}, 1000)';
  const wrapperScript = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(nestedScript)}], { stdio: 'ignore' });
    process.stdout.write(String(child.pid) + '\\n');
    setInterval(() => {}, 1000);
  `;
  const runProcess = spawnRunProcess(process.execPath, ['-e', wrapperScript], { stdio: ['ignore', 'pipe', 'inherit'] });
  let nestedPid: number | null = null;

  try {
    const firstLine = await new Promise<string>((resolve, reject) => {
      let output = '';
      runProcess.stdout?.on('data', (chunk) => {
        output += String(chunk);
        const newline = output.indexOf('\n');
        if (newline !== -1) resolve(output.slice(0, newline));
      });
      runProcess.once('error', reject);
    });
    nestedPid = Number(firstLine);
    assert.ok(Number.isInteger(nestedPid) && nestedPid > 0);

    signalRunProcess(runProcess, 'SIGKILL');
    await waitFor(() => runProcess.exitCode !== null || runProcess.signalCode !== null);
    await waitFor(() => !isProcessAlive(nestedPid!));
  } finally {
    if (runProcess.pid && isProcessAlive(runProcess.pid)) process.kill(runProcess.pid, 'SIGKILL');
    if (nestedPid && isProcessAlive(nestedPid)) process.kill(nestedPid, 'SIGKILL');
  }
});
