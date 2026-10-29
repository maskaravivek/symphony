import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RunState } from '../status/runState.js';

const file = (workspace: string) => path.join(path.dirname(workspace), '.symphony', 'preparations', `${path.basename(workspace)}.json`);
export function preparationAlive(state: RunState): boolean {
  if (!state.worker_pid) return false;
  try { process.kill(state.worker_pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
export async function readPreparation(workspace: string): Promise<RunState | null> {
  try {
    const state = JSON.parse(await fs.readFile(file(workspace), 'utf8')) as RunState;
    if (state.status !== 'preparing' || !state.issue_id || !Number.isSafeInteger(state.worker_pid)) throw new Error('Invalid workspace preparation lease');
    return state;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export async function hasLivePreparation(workspace: string): Promise<boolean> {
  try { const state = await readPreparation(workspace); return state ? preparationAlive(state) : false; }
  catch { return true; } // Unknown leases require attention, never destructive reuse.
}
export async function writePreparation(workspace: string, state: RunState): Promise<void> {
  await fs.mkdir(path.dirname(file(workspace)), { recursive: true });
  const temporary = `${file(workspace)}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
  await fs.rename(temporary, file(workspace));
}
export async function clearPreparation(workspace: string, sessionId: string): Promise<void> {
  if ((await readPreparation(workspace))?.session_id === sessionId) await fs.rm(file(workspace), { force: true });
}
