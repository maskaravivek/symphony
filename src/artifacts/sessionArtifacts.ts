import { safeStoragePath } from '../storage/paths.js';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function pruneSessionArtifacts(
  root: string,
  options: { activeDir: string | null; issueIdentifier?: string; maxSessions?: number; maxAgeDays?: number; maxBytes?: number },
): Promise<void> {
  const maxSessions = options.maxSessions ?? 50;
  const cutoff = Date.now() - (options.maxAgeDays ?? 30) * 24 * 60 * 60 * 1000;
  // Artifact roots and entries must not redirect retention into another directory.
  if (!(await safeStoragePath(root))) return;
  async function size(file: string): Promise<number> {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) return 0;
    if (!stat.isDirectory()) return stat.size;
    let total = 0;
    for (const name of await fs.readdir(file)) total += await size(path.join(file, name));
    return total;
  }
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return;
  }
  const entries = await Promise.all(names.map(async (name) => {
    const fullPath = path.join(root, name);
    const stat = await fs.lstat(fullPath).catch(() => null);
    if (!stat?.isDirectory()) return null;
    const issueIdentifier = await fs.readFile(path.join(fullPath, 'manifest.json'), 'utf8')
      .then((raw) => (JSON.parse(raw) as { issue_identifier?: string }).issue_identifier ?? null)
      .catch(() => null);
    return { fullPath, mtimeMs: stat.mtimeMs, issueIdentifier, bytes: options.maxBytes === undefined ? 0 : await size(fullPath) };
  }));
  const active = options.activeDir ? path.resolve(options.activeDir) : null;
  const sorted = entries.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const keep = new Set<string>();
  if (active) keep.add(active);
  let keptForIssue = active ? 1 : 0;
  let keptBytes = sorted.find(entry => path.resolve(entry.fullPath) === active)?.bytes ?? 0;
  for (const entry of sorted) {
    if (path.resolve(entry.fullPath) === active) continue;
    if (options.issueIdentifier !== undefined && entry.issueIdentifier !== options.issueIdentifier) continue;
    if (entry.mtimeMs < cutoff || keptForIssue >= maxSessions || keptBytes + entry.bytes > (options.maxBytes ?? Infinity)) continue;
    keptBytes += entry.bytes;
    keep.add(path.resolve(entry.fullPath));
    keptForIssue += 1;
  }
  await Promise.all(sorted.map(async (entry) => {
    const resolved = path.resolve(entry.fullPath);
    const differentIssue = options.issueIdentifier !== undefined && entry.issueIdentifier !== options.issueIdentifier;
    if (resolved === active) return;
    if (entry.mtimeMs < cutoff) {
      await fs.rm(entry.fullPath, { recursive: true, force: true });
      return;
    }
    if (differentIssue || keep.has(resolved)) return;
    await fs.rm(entry.fullPath, { recursive: true, force: true });
  }));
}

export function sessionArtifactDirectory(workspacePath: string, attempt: number, sessionId: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return path.join(workspacePath, '.symphony', 'runs', `${stamp}-${attempt}-${sessionId}`);
}
