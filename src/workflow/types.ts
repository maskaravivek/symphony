export interface EpicTrackerConfig {
  enabled: boolean;
  relationship_source: 'native_subissues';
  auto_label_children: boolean;
  parent_mode: 'coordinator_only';
  max_depth: number;
}

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
  epics: EpicTrackerConfig;
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

export interface AgentProviderConfig {
  id: string;
  command: string;
  resume_command: string | null;
  handoff_command: string | null;
  turn_timeout_ms: number;
  output_log: string;
  max_concurrent: number | null;
  extract_codex_thread_id: boolean;
  usage_limit_exit_codes: number[] | null;
  usage_limit_backoff_ms: number;
}

export interface AgentRouteConfig {
  provider: string;
  any_labels: string[];
  all_labels: string[];
  none_labels: string[];
  default: boolean;
}

export interface AgentsConfig {
  default: string;
  providers: Record<string, AgentProviderConfig>;
  routes: AgentRouteConfig[];
}

export interface WorkflowConfig {
  tracker: GithubTrackerConfig;
  polling: PollingConfig;
  workspace: WorkspaceConfig;
  hooks: HooksConfig;
  agent: AgentConfig;
  codex: CodexConfig;
  agents: AgentsConfig;
}

export interface LoadedWorkflow {
  config: WorkflowConfig;
  prompt_template: string;
}
