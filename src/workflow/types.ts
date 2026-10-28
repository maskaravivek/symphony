export interface EpicTrackerConfig {
  enabled: boolean;
  relationship_source: 'native_subissues';
  auto_label_children: boolean;
  parent_mode: 'coordinator_only';
  execution_mode: 'independent' | 'stacked';
  max_depth: number;
}

export interface GithubTrackerConfig {
  kind: 'github';
  owner: string;
  repo: string;
  token: string | null;
  api_base_url: string;
  graphql_url: string;
  candidate_order: 'priority_then_created_at' | 'ready_for_agent_labeled_at';
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
  strategy: WorkspaceStrategyConfig;
  storage_maintenance?: Partial<StorageMaintenanceConfig>;
}

export interface StorageMaintenanceConfig {
  enabled: boolean;
  interval_ms: number;
  min_free_gib: number;
  idle_days: number;
  retention_days: number;
  max_artifact_gib: number;
  max_pool_slots: number;
  cache_root: string | null;
  max_cache_gib: number;
}

export type WorkspaceStrategy = 'durable_issue_workspace' | 'pooled_isolated' | 'none_or_readonly' | 'durable_epic_workspace';

export interface WorkspaceStrategyConfig {
  implementation: WorkspaceStrategy;
  planning: WorkspaceStrategy;
  epic: {
    stacked: WorkspaceStrategy;
    independent: WorkspaceStrategy;
  };
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

export interface ReviewConfig {
  enabled: boolean;
  auto_fix_review_comments: boolean;
  number_of_auto_fix_iterations: number;
  shepherd_pull_requests: boolean;
  max_feedback_rounds: number;
  non_blocking_feedback_priorities: string[];
  lenses: string[];
}

export type MergeRisk = 'standard' | 'elevated' | 'prohibited';

export type MergeMethod = 'merge' | 'squash' | 'rebase';

export interface MergeRiskRule {
  risk: MergeRisk;
  any_labels: string[];
  paths: string[];
  target_branches: string[];
  min_changed_lines?: number | null;
  min_changed_files?: number | null;
  required_evidence?: string[];
}

export interface MergeConfig {
  enabled: boolean;
  dry_run: boolean;
  require_checks?: boolean;
  required_reviews?: number;
  validation_command?: string | null;
  method: MergeMethod;
  default_risk: MergeRisk;
  policy_version?: string;
  workflow_sha?: string;
  require_independent_reviews?: boolean;
  required_evidence?: Partial<Record<Exclude<MergeRisk, 'prohibited'>, string[]>>;
  substantive_ignored_paths?: string[];
  rules: MergeRiskRule[];
}

export interface ScheduledLoopConfig {
  id: string;
  enabled: boolean;
  interval_ms: number;
  prompt: string;
  provider: string | null;
}

export interface AgentProviderConfig {
  id: string;
  provider_group: string;
  provider_kind: string;
  command: string;
  resume_command: string | null;
  handoff_command: string | null;
  turn_timeout_ms: number;
  output_log: string;
  max_concurrent: number | null;
  extract_codex_thread_id: boolean;
  usage_limit_exit_codes: number[] | null;
  usage_limit_backoff_ms: number;
  usage_limit_check_command: string | null;
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
  workflow_sha?: string;
  tracker: GithubTrackerConfig;
  polling: PollingConfig;
  workspace: WorkspaceConfig;
  hooks: HooksConfig;
  agent: AgentConfig;
  review: ReviewConfig;
  merge: MergeConfig;
  loops: ScheduledLoopConfig[];
  agents: AgentsConfig;
}

export interface LoadedWorkflow {
  config: WorkflowConfig;
  prompt_template: string;
}
