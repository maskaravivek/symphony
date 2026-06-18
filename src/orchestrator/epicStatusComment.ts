import type { Issue } from '../domain/issue.js';
import type { EpicState } from '../status/epicState.js';
import type { WorkflowConfig } from '../workflow/types.js';

export function epicStatusMarker(issue: Issue): string {
  return `<!-- symphony-epic-status:${issue.identifier} -->`;
}

function tableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function formatEpicStatusComment(options: {
  issue: Issue;
  config: WorkflowConfig;
  repoId: string | null;
  state: EpicState;
  message: string;
}): string {
  const childRows = options.state.children
    .map((child) => {
      const labelText = child.labels.length ? child.labels.join(', ') : 'none';
      const queued = child.queued ? 'yes' : child.skipped_reason ? `no (${child.skipped_reason})` : 'no';
      const kind = child.leaf ? 'leaf' : 'parent';
      return `| #${child.issue_number ?? '?'} | ${tableCell(child.title)} | ${child.state} | ${kind} | ${queued} | ${tableCell(labelText)} |`;
    })
    .join('\n');

  const table = childRows
    ? `| Issue | Title | State | Type | Queued | Labels |\n| --- | --- | --- | --- | --- | --- |\n${childRows}`
    : 'No sub-issues found.';

  return `${epicStatusMarker(options.issue)}\n### Symphony Epic Status\n\n${options.message}\n\n- Repo: ${options.config.tracker.owner}/${options.config.tracker.repo}\n- Symphony repo id: ${options.repoId ?? '(single-repo)'}\n- Epic: ${options.issue.identifier}\n- Status: \`${options.state.status}\`\n- Children: ${options.state.terminal_children}/${options.state.total_children} terminal, ${options.state.open_children} open\n\n${table}\n`;
}
