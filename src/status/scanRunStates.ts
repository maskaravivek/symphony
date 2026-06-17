import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';

import type { RunState } from './runState.js';
import { readRunState } from './runState.js';

export async function scanRunStates(workspaceRoot: string): Promise<RunState[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(workspaceRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const states = await Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .map(async (e) => {
        const workspacePath = path.join(workspaceRoot, e.name);
        return await readRunState(workspacePath);
      }),
  );

  return states.filter((s): s is RunState => s !== null);
}

export function findRunStateByIssueNumber(states: RunState[], issueNumber: number): RunState | null {
  return states.find((s) => s.issue_number === issueNumber) ?? null;
}
