import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Last-resort repo health derived from the orchestrator's structured logs. Only consulted for a
 * repo whose heartbeat file is missing (older orchestrators). Reads a bounded tail of today's log.
 */
export interface RepoLogFallback {
  last_poll_at: string | null;
  capacity_remaining: number | null;
  protected_workspaces: Array<{ path: string; issue_number: number | null; reason: string }>;
}

const TAIL_BYTES = 512 * 1024;
const CACHE_TTL_MS = 15_000;
const PROTECTED_RECENT_MS = 30 * 60_000;
const cache = new Map<string, { at: number; value: Promise<Map<string, RepoLogFallback>> }>();

async function readTail(file: string, bytes: number): Promise<string> {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8');
    // Drop the first partial line when starting mid-file.
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    await handle.close();
  }
}

async function load(controlDir: string, now: Date): Promise<Map<string, RepoLogFallback>> {
  const result = new Map<string, RepoLogFallback>();
  const file = path.join(controlDir, '.symphony', 'logs', `symphony-${now.toISOString().slice(0, 10)}.jsonl`);
  const text = await readTail(file, TAIL_BYTES).catch(() => '');
  const entry = (repoId: string): RepoLogFallback => {
    let value = result.get(repoId);
    if (!value) {
      value = { last_poll_at: null, capacity_remaining: null, protected_workspaces: [] };
      result.set(repoId, value);
    }
    return value;
  };
  const protectedSeen = new Map<string, Map<string, { path: string; issue_number: number | null; reason: string }>>();
  for (const line of text.split('\n')) {
    if (!line.includes('candidate_poll_') && !line.includes('terminal_workspace_clean_failed')) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const repoId = typeof record.repo_id === 'string' ? record.repo_id : 'default';
    const event = typeof record.event === 'string' ? record.event : record.message;
    if (event === 'candidate_poll_completed' || event === 'candidate_poll_empty') {
      const value = entry(repoId);
      value.last_poll_at = typeof record.ts === 'string' ? record.ts : value.last_poll_at;
      value.capacity_remaining = typeof record.capacity_remaining === 'number' ? record.capacity_remaining : value.capacity_remaining;
    } else if (
      event === 'terminal_workspace_clean_failed' &&
      typeof record.workspace_path === 'string' &&
      /protected/i.test(String(record.error ?? '')) &&
      // The sweep logs this every tick while the workspace stays protected; older lines may be resolved.
      now.getTime() - Date.parse(String(record.ts)) < PROTECTED_RECENT_MS
    ) {
      const seen = protectedSeen.get(repoId) ?? new Map();
      seen.set(record.workspace_path, {
        path: record.workspace_path,
        issue_number: typeof record.issue_number === 'number' ? record.issue_number : null,
        reason: String(record.error),
      });
      protectedSeen.set(repoId, seen);
    }
  }
  for (const [repoId, seen] of protectedSeen) entry(repoId).protected_workspaces = [...seen.values()];
  return result;
}

export async function readLogFallback(controlDir: string, now = new Date()): Promise<Map<string, RepoLogFallback>> {
  const hit = cache.get(controlDir);
  if (hit && now.getTime() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = load(controlDir, now).catch(() => new Map<string, RepoLogFallback>());
  cache.set(controlDir, { at: now.getTime(), value });
  return value;
}
