import type { Issue } from '../domain/issue.js';
import type { RunState } from '../status/runState.js';
import type { WorkflowConfig } from '../workflow/types.js';

export function statusMarker(issue: Issue): string {
  return `<!-- symphony-status:${issue.identifier} -->`;
}

export function formatStatusComment(options: {
  issue: Issue;
  config: WorkflowConfig;
  repoId: string | null;
  state: Partial<RunState>;
  message: string;
}): string {
  const provider = options.state.agent_provider ?? 'codex';
  const threadId = options.state.agent_thread_id ?? options.state.codex_thread_id ?? null;
  const workspace = options.state.workspace_path ?? '';
  const isCodex = provider === 'codex';
  const resumeCommand = isCodex && threadId ? `codex resume --include-non-interactive ${threadId}` : null;
  const execResumeCommand = isCodex && threadId ? `codex exec resume ${threadId} -` : null;
  const resumeBlock =
    resumeCommand && execResumeCommand
      ? `\nInteractive resume:\n\n\`\`\`bash\n${resumeCommand}\n\`\`\`\n\nNon-interactive resume:\n\n\`\`\`bash\n${execResumeCommand}\n\`\`\`\n`
      : '';

  return `${statusMarker(options.issue)}\n### Symphony Status\n\n${options.message}\n\n- Repo: ${options.config.tracker.owner}/${options.config.tracker.repo}\n- Symphony repo id: ${options.repoId ?? '(single-repo)'}\n- Issue: ${options.issue.identifier}\n- Workspace: \`${workspace || '(not prepared)'}\`\n- Branch: \`${options.issue.branch_name ?? '(unknown)'}\`\n- Status: \`${options.state.status ?? 'unknown'}\`\n- Pause reason: \`${options.state.pause_reason ?? 'none'}\`\n- Agent provider: \`${provider}\`\n- Agent thread: \`${threadId ?? 'pending'}\`\n${resumeBlock}`;
}
