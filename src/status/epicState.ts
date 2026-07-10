import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { Issue } from '../domain/issue.js';

export type EpicStatus = 'coordinating' | 'completed';

export interface EpicChildState {
  issue_id: string;
  issue_number: number | null;
  issue_identifier: string;
  issue_url: string | null;
  title: string;
  state: string;
  labels: string[];
  depth: number;
  leaf: boolean;
  queued: boolean;
  skipped_reason: string | null;
}

export interface EpicState {
  repo_id: string | null;
  owner: string | null;
  repo: string | null;
  issue_id: string;
  issue_number: number | null;
  issue_identifier: string;
  issue_url: string | null;
  title: string;
  labels: string[];
  status: EpicStatus;
  open_children: number;
  terminal_children: number;
  total_children: number;
  children: EpicChildState[];
  status_comment_id: number | null;
  updated_at: string;
}

export function reconcileEpicStateWithIssue(state: EpicState, issue: Issue, terminalStates: string[]): EpicState {
  const parentIsTerminal = terminalStates.includes(issue.state);
  return {
    ...state,
    issue_id: issue.id,
    issue_number: issue.number,
    issue_identifier: issue.identifier,
    issue_url: issue.url,
    title: issue.title,
    labels: issue.labels,
    status: parentIsTerminal ? 'completed' : state.status,
    updated_at: issue.updated_at ?? state.updated_at,
  };
}

function epicStatePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.symphony', 'epics.json');
}

export async function readEpicStates(workspaceRoot: string): Promise<EpicState[]> {
  try {
    const raw = await fs.readFile(epicStatePath(workspaceRoot), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as EpicState[]) : [];
  } catch {
    return [];
  }
}

export async function writeEpicStates(workspaceRoot: string, states: EpicState[]): Promise<void> {
  const dir = path.join(workspaceRoot, '.symphony');
  await fs.mkdir(dir, { recursive: true });
  const target = epicStatePath(workspaceRoot);
  const tmpPath = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmpPath, `${JSON.stringify(states, null, 2)}\n`, 'utf8');
    await fs.rename(tmpPath, target);
  } finally {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
  }
}

export async function upsertEpicState(workspaceRoot: string, next: EpicState): Promise<void> {
  const states = await readEpicStates(workspaceRoot);
  const existing = states.findIndex((state) => state.issue_id === next.issue_id || state.issue_identifier === next.issue_identifier);
  if (existing === -1) states.push(next);
  else states[existing] = next;
  states.sort((a, b) => (a.issue_number ?? Number.POSITIVE_INFINITY) - (b.issue_number ?? Number.POSITIVE_INFINITY));
  await writeEpicStates(workspaceRoot, states);
}
