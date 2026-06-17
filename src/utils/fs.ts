import path from 'node:path';

export function expandHomeDir(inputPath: string, homeDir = process.env.HOME): string {
  if (!inputPath.startsWith('~')) return inputPath;
  if (!homeDir) return inputPath;
  if (inputPath === '~') return homeDir;
  if (inputPath.startsWith('~/')) return path.join(homeDir, inputPath.slice(2));
  return inputPath;
}

export function assertPathWithinRoot(rootPath: string, candidatePath: string): void {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedCandidate = path.resolve(candidatePath);
  const rel = path.relative(resolvedRoot, resolvedCandidate);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return;
  throw new Error(`Unsafe path: ${candidatePath} is not within root ${rootPath}`);
}

