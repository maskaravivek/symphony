import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { log } from '../utils/log.js';
import type { OrchestratorHeartbeat, RepoHeartbeat } from './dashboardTypes.js';

const HEARTBEAT_FILE = 'heartbeat.json';

export function repoHeartbeatPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.symphony', HEARTBEAT_FILE);
}

export function orchestratorHeartbeatPath(controlDir: string): string {
  return path.join(controlDir, '.symphony', HEARTBEAT_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readHeartbeatFile(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, 'utf8'));
    if (!isRecord(parsed) || parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function readRepoHeartbeat(workspaceRoot: string): Promise<RepoHeartbeat | null> {
  const parsed = await readHeartbeatFile(repoHeartbeatPath(workspaceRoot));
  if (!parsed || typeof parsed.tick_started_at !== 'string' || typeof parsed.tick_outcome !== 'string') return null;
  return parsed as unknown as RepoHeartbeat;
}

export async function readOrchestratorHeartbeat(controlDir: string): Promise<OrchestratorHeartbeat | null> {
  const parsed = await readHeartbeatFile(orchestratorHeartbeatPath(controlDir));
  if (!parsed || typeof parsed.updated_at !== 'string' || typeof parsed.pid !== 'number') return null;
  return parsed as unknown as OrchestratorHeartbeat;
}

async function writeHeartbeatFile(filePath: string, value: unknown, kind: string): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    log('warn', 'heartbeat_write_failed', {
      event: 'heartbeat_write_failed',
      heartbeat_kind: kind,
      heartbeat_path: filePath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Atomic tmp+rename write; never throws. */
export async function writeRepoHeartbeat(workspaceRoot: string, heartbeat: RepoHeartbeat): Promise<void> {
  try {
    await writeHeartbeatFile(repoHeartbeatPath(workspaceRoot), heartbeat, 'repo');
  } catch {
    // writeHeartbeatFile already logs; guard against logging failures too.
  }
}

/** Atomic tmp+rename write; never throws. */
export async function writeOrchestratorHeartbeat(controlDir: string, heartbeat: OrchestratorHeartbeat): Promise<void> {
  try {
    await writeHeartbeatFile(orchestratorHeartbeatPath(controlDir), heartbeat, 'orchestrator');
  } catch {
    // writeHeartbeatFile already logs; guard against logging failures too.
  }
}
