import { spawn } from 'node:child_process';

export async function getGhAuthToken(options: { timeoutMs: number } = { timeoutMs: 5_000 }): Promise<string | null> {
  return await new Promise<string | null>((resolve) => {
    const child = spawn('gh auth token', {
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
      resolve(null);
    }, options.timeoutMs);
    timeout.unref();

    child.on('error', () => {
      clearTimeout(timeout);
      resolve(null);
    });

    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        resolve(null);
        return;
      }
      const token = stdout.trim();
      resolve(token.length > 0 ? token : null);
    });
  });
}

