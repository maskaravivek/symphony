import type { WorkflowConfig } from '../workflow/types.js';

const SUPPORTED_TOOL_NAMES = [
  'awk',
  'bash',
  'bun',
  'claude',
  'codex',
  'codexbar',
  'curl',
  'docker',
  'gh',
  'git',
  'jq',
  'node',
  'npm',
  'npx',
  'pnpm',
  'python',
  'python3',
  'ruby',
  'sh',
  'shasum',
  'yarn',
  'zsh',
] as const;

function mentionsTool(source: string, tool: string): boolean {
  const escaped = tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_.-])${escaped}([^A-Za-z0-9_.-]|$)`).test(source);
}

/**
 * Finds executable dependencies embedded anywhere in provider commands or hooks.
 * This is intentionally an allow-list: it avoids treating shell keywords,
 * arguments, environment variables, and user-provided prompt text as commands.
 */
export function requiredToolsForWorkflow(config: WorkflowConfig): string[] {
  const commandSources = [
    config.hooks.after_create,
    config.hooks.before_run,
    config.hooks.after_run,
    config.merge?.validation_command,
    ...Object.values(config.agents.providers).flatMap((provider) => [
      provider.command,
      provider.resume_command,
      provider.handoff_command,
      provider.usage_limit_check_command,
    ]),
  ].filter((source): source is string => Boolean(source));

  return SUPPORTED_TOOL_NAMES.filter((tool) => commandSources.some((source) => mentionsTool(source, tool)));
}
