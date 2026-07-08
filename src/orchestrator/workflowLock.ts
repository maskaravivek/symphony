import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface WorkflowLockOwner {
  pid: number;
  token: string;
  hostname: string;
  repo_id: string | null;
  owner: string | null;
  repo: string | null;
  workflow_path: string;
  acquired_at: string;
}

export interface WorkflowLock {
  workspace_root: string;
  lock_path: string;
  owner: WorkflowLockOwner;
  release: () => Promise<void>;
}

export type WorkflowLockResult =
  | { acquired: true; lock: WorkflowLock }
  | { acquired: false; lock_path: string; owner: WorkflowLockOwner | null };

function isProcessAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readOwner(lockPath: string): Promise<WorkflowLockOwner | null> {
  try {
    const raw = await fs.readFile(path.join(lockPath, 'owner.json'), 'utf8');
    return JSON.parse(raw) as WorkflowLockOwner;
  } catch {
    return null;
  }
}

async function releaseLock(lockPath: string, token: string): Promise<void> {
  const owner = await readOwner(lockPath);
  if (!owner || owner.token !== token) return;
  await fs.rm(lockPath, { recursive: true, force: true });
  await fs.rmdir(path.dirname(lockPath)).catch(() => undefined);
}

export async function acquireWorkflowLock(options: {
  workspaceRoot: string;
  repoId: string | null;
  owner: string | null;
  repo: string | null;
  workflowPath: string;
}): Promise<WorkflowLockResult> {
  const root = options.workspaceRoot;
  const lockPath = path.join(root, '.symphony', 'orchestrator.lock');
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  const token = randomUUID();
  const owner: WorkflowLockOwner = {
    pid: process.pid,
    token,
    hostname: os.hostname(),
    repo_id: options.repoId,
    owner: options.owner,
    repo: options.repo,
    workflow_path: options.workflowPath,
    acquired_at: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fs.mkdir(lockPath);
      await fs.writeFile(path.join(lockPath, 'owner.json'), `${JSON.stringify(owner, null, 2)}\n`, 'utf8');
      return {
        acquired: true,
        lock: {
          workspace_root: root,
          lock_path: lockPath,
          owner,
          release: () => releaseLock(lockPath, token),
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const existingOwner = await readOwner(lockPath);
      if (existingOwner && isProcessAlive(existingOwner.pid)) {
        return { acquired: false, lock_path: lockPath, owner: existingOwner };
      }
      await fs.rm(lockPath, { recursive: true, force: true });
    }
  }

  return { acquired: false, lock_path: lockPath, owner: await readOwner(lockPath) };
}
