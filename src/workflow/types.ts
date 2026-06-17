export interface GithubTrackerConfig {
  kind: 'github';
  owner: string;
  repo: string;
  token: string | null;
  api_base_url: string;
  graphql_url: string;
  active_states: string[];
  terminal_states: string[];
  required_labels: string[];
  any_required_labels: string[] | null;
  ignored_labels: string[];
  priority_labels: Record<string, number> | null;
  branch_prefix: string;
  include_pull_requests: boolean;
  page_size: number;
  request_timeout_ms: number;
}

export interface PollingConfig {
  interval_ms: number;
}

export interface WorkspaceConfig {
  root: string;
  clean_on_terminal: boolean;
}

export interface HooksConfig {
  after_create: string | null;
  before_run: string | null;
  after_run: string | null;
  timeout_ms: number;
}

export interface AgentConfig {
  max_concurrent_agents: number;
  max_retry_backoff_ms: number;
  max_attempts: number | null;
  max_concurrent_agents_by_state: Record<string, number> | null;
}

export interface CodexConfig {
  command: string;
  resume_command: string;
  handoff_command: string;
  turn_timeout_ms: number;
}

export interface WorkflowConfig {
  tracker: GithubTrackerConfig;
  polling: PollingConfig;
  workspace: WorkspaceConfig;
  hooks: HooksConfig;
  agent: AgentConfig;
  codex: CodexConfig;
}

export interface LoadedWorkflow {
  config: WorkflowConfig;
  prompt_template: string;
}
