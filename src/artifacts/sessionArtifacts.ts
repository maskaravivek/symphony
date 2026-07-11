import fs from 'node:fs/promises';
import path from 'node:path';

export async function pruneSessionArtifacts(
  root: string,
  options: { activeDir: string | null; issueIdentifier?: string; maxSessions?: number; maxAgeDays?: number },
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
    if (!stat?.isDirectory()) return null;
    const issueIdentifier = await fs.readFile(path.join(fullPath, 'manifest.json'), 'utf8')
      .then((raw) => (JSON.parse(raw) as { issue_identifier?: string }).issue_identifier ?? null)
      .catch(() => null);
    return { fullPath, mtimeMs: stat.mtimeMs, issueIdentifier };
  }));
  const active = options.activeDir ? path.resolve(options.activeDir) : null;
  const sorted = entries.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const keep = new Set<string>();
  if (active) keep.add(active);
  let keptForIssue = active ? 1 : 0;
  for (const entry of sorted) {
    if (path.resolve(entry.fullPath) === active) continue;
    if (options.issueIdentifier !== undefined && entry.issueIdentifier !== options.issueIdentifier) continue;
    if (keptForIssue >= maxSessions) continue;
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
