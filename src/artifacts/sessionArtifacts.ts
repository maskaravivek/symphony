import fs from 'node:fs/promises';
import path from 'node:path';

export async function pruneSessionArtifacts(
  root: string,
  options: { activeDir: string | null; maxSessions?: number; maxAgeDays?: number },
): Promise<void> {
  const maxSessions = options.maxSessions ?? 50;
  const cutoff = Date.now() - (options.maxAgeDays ?? 30) * 24 * 60 * 60 * 1000;
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return;
  }
  const entries = await Promise.all(names.map(async (name) => {
    const fullPath = path.join(root, name);
    const stat = await fs.stat(fullPath).catch(() => null);
    return stat?.isDirectory() ? { fullPath, mtimeMs: stat.mtimeMs } : null;
  }));
  const active = options.activeDir ? path.resolve(options.activeDir) : null;
  const sorted = entries.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const keep = new Set<string>();
  if (active) keep.add(active);
  for (const entry of sorted) {
    if (keep.size >= maxSessions) break;
    keep.add(path.resolve(entry.fullPath));
  }
  await Promise.all(sorted.map(async (entry) => {
    const resolved = path.resolve(entry.fullPath);
    if (resolved === active || (keep.has(resolved) && entry.mtimeMs >= cutoff)) return;
    await fs.rm(entry.fullPath, { recursive: true, force: true });
  }));
}

export function sessionArtifactDirectory(workspacePath: string, attempt: number, sessionId: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return path.join(workspacePath, '.symphony', 'runs', `${stamp}-${attempt}-${sessionId}`);
}
