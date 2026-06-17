import type { RunState } from './runState.js';

export interface RunStateSelection {
  state: RunState | null;
  ambiguous: boolean;
  matches: RunState[];
}

function stateRepoId(state: RunState): string | null {
  return state.repo_id ?? null;
}

export function selectRunState(states: RunState[], selector: string): RunStateSelection {
  const trimmed = selector.trim();
  const repoIssueMatch = /^([A-Za-z0-9._-]+)#(\d+)$/.exec(trimmed);

  if (repoIssueMatch) {
    const repoId = repoIssueMatch[1];
    const issueNumber = Number(repoIssueMatch[2]);
    const matches = states.filter((s) => stateRepoId(s) === repoId && s.issue_number === issueNumber);
    return { state: matches[0] ?? null, ambiguous: matches.length > 1, matches };
  }

  const issueNumber = Number(trimmed.replace(/^#/, ''));
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return { state: null, ambiguous: false, matches: [] };
  }

  const matches = states.filter((s) => s.issue_number === issueNumber);
  return { state: matches.length === 1 ? matches[0] : null, ambiguous: matches.length > 1, matches };
}
