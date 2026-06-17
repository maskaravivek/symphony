import fs from 'node:fs/promises';
import path from 'node:path';

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await fs.access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

export async function resolveWorkflowPath(workflowPath: string, cwd = process.cwd()): Promise<string> {
  // If absolute, just verify it exists (or let caller fail later).
  if (path.isAbsolute(workflowPath)) return workflowPath;

  let dir = cwd;
  for (let i = 0; i < 25; i++) {
    const candidate = path.resolve(dir, workflowPath);
    if (await pathExists(candidate)) return candidate;

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Fall back to the original (relative) path.
  return workflowPath;
}

