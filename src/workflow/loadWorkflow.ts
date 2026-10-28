import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';

import { getGhAuthToken } from '../github/ghAuth.js';
import { SymphonyConfigError } from '../utils/errors.js';
import { expandHomeDir } from '../utils/fs.js';
import { DEFAULT_STORAGE_POLICY } from '../storage/policy.js';
import type {
  AgentProviderConfig,
  AgentRouteConfig,
  AgentsConfig,
  LoadedWorkflow,
  MergeMethod,
  MergeRisk,
  MergeRiskRule,
  ScheduledLoopConfig,
  WorkflowConfig,
  WorkspaceStrategy,
  WorkspaceStrategyConfig,
} from './types.js';

type AnyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown, keyPath: string): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new SymphonyConfigError(`${keyPath} must be an array of strings`);
  for (const item of value) {
    if (typeof item !== 'string') throw new SymphonyConfigError(`${keyPath} must be an array of strings`);
  }
  return value;
}

function asBoolean(value: unknown, keyPath: string): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') throw new SymphonyConfigError(`${keyPath} must be a boolean`);
  return value;
}

function asNumber(value: unknown, keyPath: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || Number.isNaN(value)) throw new SymphonyConfigError(`${keyPath} must be a number`);
  return value;
}

function asString(value: unknown, keyPath: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new SymphonyConfigError(`${keyPath} must be a string`);
  return value;
}

function asTrimmedStringOrNull(value: unknown, keyPath: string): string | null {
  const raw = asString(value, keyPath);
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!trimmed) throw new SymphonyConfigError(`${keyPath} must be a non-empty string`);
  return trimmed;
}

function normalizeIdentifier(value: string): string {
  return value.trim().toLowerCase();
}

function splitFrontMatter(markdown: string): { yaml: string | null; body: string } {
  if (!markdown.startsWith('---\n') && markdown !== '---') return { yaml: null, body: markdown };
  const lines = markdown.split('\n');
  if (lines.length < 3) return { yaml: null, body: markdown };
  if (lines[0] !== '---') return { yaml: null, body: markdown };
  const endIndex = lines.findIndex((l, idx) => idx > 0 && l === '---');
  if (endIndex === -1) return { yaml: null, body: markdown };
  const yamlLines = lines.slice(1, endIndex);
  const bodyLines = lines.slice(endIndex + 1);
  return { yaml: yamlLines.join('\n'), body: bodyLines.join('\n').replace(/^\n+/, '') };
}

function resolveEnvRefs(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === 'string') {
    const match = /^\$([A-Z0-9_]+)$/.exec(value.trim());
    if (!match) return value;
    return env[match[1]] ?? null;
  }
  if (Array.isArray(value)) return value.map((v) => resolveEnvRefs(v, env));
  if (isRecord(value)) {
    const out: AnyRecord = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveEnvRefs(v, env);
    return out;
  }
  return value;
}

function normalizePriorityLabels(value: unknown): Record<string, number> | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new SymphonyConfigError('tracker.priority_labels must be a mapping of string -> integer');
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
      throw new SymphonyConfigError('tracker.priority_labels values must be positive integers');
    }
    out[k.trim().toLowerCase()] = v;
  }
  return out;
}

function normalizeCandidateOrder(value: unknown): WorkflowConfig['tracker']['candidate_order'] {
  const raw = asString(value, 'tracker.candidate_order') ?? 'priority_then_created_at';
  if (raw !== 'priority_then_created_at' && raw !== 'ready_for_agent_labeled_at') {
    throw new SymphonyConfigError('tracker.candidate_order must be priority_then_created_at or ready_for_agent_labeled_at');
  }
  return raw;
}

const WORKSPACE_STRATEGIES = new Set<WorkspaceStrategy>([
  'durable_issue_workspace',
  'pooled_isolated',
  'none_or_readonly',
  'durable_epic_workspace',
]);

function normalizeWorkspaceStrategyValue(value: unknown, keyPath: string, fallback: WorkspaceStrategy): WorkspaceStrategy {
  if (value === undefined || value === null) return fallback;
  const raw = asString(value, keyPath);
  if (!raw || !WORKSPACE_STRATEGIES.has(raw as WorkspaceStrategy)) {
    throw new SymphonyConfigError(
      `${keyPath} must be durable_issue_workspace, pooled_isolated, none_or_readonly, or durable_epic_workspace`,
    );
  }
  return raw as WorkspaceStrategy;
}

function normalizeWorkspaceStrategy(value: unknown): WorkspaceStrategyConfig {
  const fallback: WorkspaceStrategyConfig = {
    implementation: 'durable_issue_workspace',
    planning: 'durable_issue_workspace',
    epic: {
      stacked: 'durable_issue_workspace',
      independent: 'durable_issue_workspace',
    },
  };
  if (!isRecord(value)) return fallback;

  const epicRaw = isRecord(value.epic) ? value.epic : {};
  return {
    implementation: normalizeWorkspaceStrategyValue(value.implementation, 'workspace.strategy.implementation', fallback.implementation),
    planning: normalizeWorkspaceStrategyValue(value.planning, 'workspace.strategy.planning', fallback.planning),
    epic: {
      stacked: normalizeWorkspaceStrategyValue(epicRaw.stacked, 'workspace.strategy.epic.stacked', fallback.epic.stacked),
      independent: normalizeWorkspaceStrategyValue(epicRaw.independent, 'workspace.strategy.epic.independent', fallback.epic.independent),
    },
  };
}

function normalizeEpicConfig(value: unknown): WorkflowConfig['tracker']['epics'] {
  const raw = isRecord(value) ? value : {};
  const enabled = asBoolean(raw.enabled, 'tracker.epics.enabled') ?? false;
  const relationshipSource = asString(raw.relationship_source, 'tracker.epics.relationship_source') ?? 'native_subissues';
  if (relationshipSource !== 'native_subissues') {
    throw new SymphonyConfigError('tracker.epics.relationship_source must be native_subissues');
  }
  const autoLabelChildren = asBoolean(raw.auto_label_children, 'tracker.epics.auto_label_children') ?? true;
  const parentMode = asString(raw.parent_mode, 'tracker.epics.parent_mode') ?? 'coordinator_only';
  if (parentMode !== 'coordinator_only') {
    throw new SymphonyConfigError('tracker.epics.parent_mode must be coordinator_only');
  }
  const executionMode = asString(raw.execution_mode, 'tracker.epics.execution_mode') ?? 'independent';
  if (executionMode !== 'independent' && executionMode !== 'stacked') {
    throw new SymphonyConfigError('tracker.epics.execution_mode must be independent or stacked');
  }
  const maxDepth = asNumber(raw.max_depth, 'tracker.epics.max_depth') ?? 8;
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 8) {
    throw new SymphonyConfigError('tracker.epics.max_depth must be an integer between 1 and 8');
  }

  return {
    enabled,
    relationship_source: relationshipSource,
    auto_label_children: autoLabelChildren,
    parent_mode: parentMode,
    execution_mode: executionMode,
    max_depth: maxDepth,
  };
}

function normalizeLabelList(value: unknown, keyPath: string): string[] {
  return (asStringArray(value, keyPath) ?? []).map((label) => label.trim().toLowerCase()).filter(Boolean);
}

function asIntegerArray(value: unknown, keyPath: string): number[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new SymphonyConfigError(`${keyPath} must be an array of integers`);
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isInteger(item)) {
      throw new SymphonyConfigError(`${keyPath} must be an array of integers`);
    }
  }
  return value as number[];
}

function normalizeProvider(id: string, value: unknown, fallback: Partial<AgentProviderConfig> = {}): AgentProviderConfig {
  if (!isRecord(value)) throw new SymphonyConfigError(`agents.providers.${id} must be an object`);
  const providerGroup = normalizeIdentifier(
    asString(value.provider_group, `agents.providers.${id}.provider_group`) ??
    fallback.provider_group ??
    id,
  );
  if (!providerGroup) throw new SymphonyConfigError(`agents.providers.${id}.provider_group must be a non-empty string`);
  const providerKind = normalizeIdentifier(
    asString(value.provider_kind, `agents.providers.${id}.provider_kind`) ??
    fallback.provider_kind ??
    id,
  );
  if (!providerKind) throw new SymphonyConfigError(`agents.providers.${id}.provider_kind must be a non-empty string`);
  const command = asString(value.command, `agents.providers.${id}.command`) ?? fallback.command;
  if (!command) throw new SymphonyConfigError(`agents.providers.${id}.command is required`);
  const resumeCommand = asString(value.resume_command, `agents.providers.${id}.resume_command`) ?? fallback.resume_command ?? null;
  const handoffCommand = asString(value.handoff_command, `agents.providers.${id}.handoff_command`) ?? fallback.handoff_command ?? null;
  const turnTimeoutMs =
    asNumber(value.turn_timeout_ms, `agents.providers.${id}.turn_timeout_ms`) ?? fallback.turn_timeout_ms ?? 3600000;
  const outputLog = asString(value.output_log, `agents.providers.${id}.output_log`) ?? fallback.output_log ?? `.symphony/${id}.log`;
  const maxConcurrent = asNumber(value.max_concurrent, `agents.providers.${id}.max_concurrent`) ?? fallback.max_concurrent ?? null;
  const extractCodexThreadId =
    asBoolean(value.extract_codex_thread_id, `agents.providers.${id}.extract_codex_thread_id`) ??
    fallback.extract_codex_thread_id ??
    providerKind === 'codex';
  const usageLimitExitCodes =
    asIntegerArray(value.usage_limit_exit_codes, `agents.providers.${id}.usage_limit_exit_codes`) ??
    fallback.usage_limit_exit_codes ??
    null;
  const usageLimitBackoffMs =
    asNumber(value.usage_limit_backoff_ms, `agents.providers.${id}.usage_limit_backoff_ms`) ??
    fallback.usage_limit_backoff_ms ??
    0;
  const usageLimitCheckCommand =
    asTrimmedStringOrNull(value.usage_limit_check_command, `agents.providers.${id}.usage_limit_check_command`) ??
    fallback.usage_limit_check_command ??
    null;

  if (!Number.isFinite(turnTimeoutMs) || turnTimeoutMs <= 0) {
    throw new SymphonyConfigError(`agents.providers.${id}.turn_timeout_ms must be a positive number`);
  }
  if (maxConcurrent !== null && (!Number.isFinite(maxConcurrent) || maxConcurrent < 0)) {
    throw new SymphonyConfigError(`agents.providers.${id}.max_concurrent must be a non-negative number`);
  }
  if (!Number.isFinite(usageLimitBackoffMs) || usageLimitBackoffMs < 0) {
    throw new SymphonyConfigError(`agents.providers.${id}.usage_limit_backoff_ms must be a non-negative number`);
  }

  return {
    id,
    provider_group: providerGroup,
    provider_kind: providerKind,
    command,
    resume_command: resumeCommand,
    handoff_command: handoffCommand,
    turn_timeout_ms: turnTimeoutMs,
    output_log: outputLog,
    max_concurrent: maxConcurrent === null ? null : Math.floor(maxConcurrent),
    extract_codex_thread_id: extractCodexThreadId,
    usage_limit_exit_codes: usageLimitExitCodes,
    usage_limit_backoff_ms: usageLimitBackoffMs,
    usage_limit_check_command: usageLimitCheckCommand,
  };
}

function normalizeRoute(value: unknown, index: number): AgentRouteConfig {
  if (!isRecord(value)) throw new SymphonyConfigError(`agents.routes[${index}] must be an object`);
  if (value.labels !== undefined) {
    throw new SymphonyConfigError(`agents.routes[${index}].labels was removed; use any_labels instead`);
  }
  const provider = asString(value.provider, `agents.routes[${index}].provider`);
  if (!provider) throw new SymphonyConfigError(`agents.routes[${index}].provider is required`);
  return {
    provider,
    any_labels: normalizeLabelList(value.any_labels, `agents.routes[${index}].any_labels`),
    all_labels: normalizeLabelList(value.all_labels, `agents.routes[${index}].all_labels`),
    none_labels: normalizeLabelList(value.none_labels, `agents.routes[${index}].none_labels`),
    default: asBoolean(value.default, `agents.routes[${index}].default`) ?? false,
  };
}

function normalizeAgentsConfig(raw: AnyRecord): AgentsConfig {
  if (raw.codex !== undefined) {
    throw new SymphonyConfigError('top-level codex config was removed; configure agents.providers instead');
  }
  const agentsRaw = isRecord(raw.agents) ? raw.agents : null;
  if (!agentsRaw) throw new SymphonyConfigError('agents is required');

  const providersRaw = isRecord(agentsRaw.providers) ? agentsRaw.providers : null;
  if (!providersRaw) throw new SymphonyConfigError('agents.providers is required');

  const providers: Record<string, AgentProviderConfig> = {};
  for (const [id, providerRaw] of Object.entries(providersRaw)) {
    const normalizedId = id.trim().toLowerCase();
    if (!normalizedId) throw new SymphonyConfigError('agents.providers keys must be non-empty');
    providers[normalizedId] = normalizeProvider(normalizedId, providerRaw);
  }

  const defaultProvider = (asString(agentsRaw.default, 'agents.default') ?? 'codex').trim().toLowerCase();
  if (!providers[defaultProvider]) throw new SymphonyConfigError(`agents.default references unknown provider: ${defaultProvider}`);

  const routesRaw = agentsRaw.routes;
  if (routesRaw !== undefined && !Array.isArray(routesRaw)) throw new SymphonyConfigError('agents.routes must be an array');
  const routes = Array.isArray(routesRaw) ? routesRaw.map((route, idx) => normalizeRoute(route, idx)) : [];
  for (const route of routes) {
    route.provider = route.provider.trim().toLowerCase();
    if (!providers[route.provider]) throw new SymphonyConfigError(`agents.routes references unknown provider: ${route.provider}`);
  }
  if (!routes.some((route) => route.default)) {
    routes.push({ provider: defaultProvider, any_labels: [], all_labels: [], none_labels: [], default: true });
  }

  return { default: defaultProvider, providers, routes };
}

const MERGE_RISKS = new Set<MergeRisk>(['standard', 'elevated', 'prohibited']);
const MERGE_METHODS = new Set<MergeMethod>(['merge', 'squash', 'rebase']);

function normalizeMergeRisk(value: unknown, keyPath: string, fallback?: MergeRisk): MergeRisk {
  if (value === undefined || value === null) {
    if (fallback) return fallback;
    throw new SymphonyConfigError(`${keyPath} is required`);
  }
  const risk = normalizeIdentifier(asString(value, keyPath) ?? '');
  if (!MERGE_RISKS.has(risk as MergeRisk)) {
    throw new SymphonyConfigError(`${keyPath} must be standard, elevated, or prohibited`);
  }
  return risk as MergeRisk;
}

function normalizeMergeRule(value: unknown, index: number): MergeRiskRule {
  const keyPath = `merge.rules[${index}]`;
  if (!isRecord(value)) throw new SymphonyConfigError(`${keyPath} must be an object`);
  const minChangedLines = asNumber(value.min_changed_lines, `${keyPath}.min_changed_lines`);
  const minChangedFiles = asNumber(value.min_changed_files, `${keyPath}.min_changed_files`);
  for (const [name, threshold] of [['min_changed_lines', minChangedLines], ['min_changed_files', minChangedFiles]] as const) {
    if (threshold !== null && (!Number.isInteger(threshold) || threshold <= 0)) {
      throw new SymphonyConfigError(`${keyPath}.${name} must be a positive integer`);
    }
  }
  return {
    risk: normalizeMergeRisk(value.risk, `${keyPath}.risk`),
    any_labels: normalizeLabelList(value.any_labels, `${keyPath}.any_labels`),
    paths: (asStringArray(value.paths, `${keyPath}.paths`) ?? []).map((path) => path.trim()).filter(Boolean),
    target_branches: (asStringArray(value.target_branches, `${keyPath}.target_branches`) ?? [])
      .map((branch) => branch.trim())
      .filter(Boolean),
    min_changed_lines: minChangedLines,
    min_changed_files: minChangedFiles,
    required_evidence: (asStringArray(value.required_evidence, `${keyPath}.required_evidence`) ?? [])
      .map((kind) => normalizeIdentifier(kind))
      .filter(Boolean),
  };
}

function normalizeMergeConfig(value: unknown): WorkflowConfig['merge'] {
  const raw = isRecord(value) ? value : {};
  const method = normalizeIdentifier(asString(raw.method, 'merge.method') ?? 'squash');
  if (!MERGE_METHODS.has(method as MergeMethod)) {
    throw new SymphonyConfigError('merge.method must be merge, squash, or rebase');
  }
  if (raw.rules !== undefined && !Array.isArray(raw.rules)) {
    throw new SymphonyConfigError('merge.rules must be an array');
  }
  const requiredReviews = asNumber(raw.required_reviews, 'merge.required_reviews') ?? 1;
  if (requiredReviews !== 0 && requiredReviews !== 1) {
    throw new SymphonyConfigError('merge.required_reviews must be 0 or 1');
  }
  const validationCommand = asTrimmedStringOrNull(raw.validation_command, 'merge.validation_command');
  if (requiredReviews === 0 && !validationCommand) {
    throw new SymphonyConfigError('merge.validation_command is required when merge.required_reviews is 0');
  }
  return {
    enabled: asBoolean(raw.enabled, 'merge.enabled') ?? false,
    dry_run: asBoolean(raw.dry_run, 'merge.dry_run') ?? false,
    require_checks: asBoolean(raw.require_checks, 'merge.require_checks') ?? true,
    required_reviews: requiredReviews,
    validation_command: validationCommand,
    method: method as MergeMethod,
    default_risk: normalizeMergeRisk(raw.default_risk, 'merge.default_risk', 'standard'),
    policy_version: asTrimmedStringOrNull(raw.policy_version, 'merge.policy_version') ?? 'v1',
    require_independent_reviews: asBoolean(raw.require_independent_reviews, 'merge.require_independent_reviews') ?? false,
    required_evidence: {
      standard: (asStringArray(isRecord(raw.required_evidence) ? raw.required_evidence.standard : undefined, 'merge.required_evidence.standard') ?? [requiredReviews === 0 ? 'validation' : 'review'])
        .map((kind) => normalizeIdentifier(kind))
        .filter(Boolean),
      elevated: (asStringArray(isRecord(raw.required_evidence) ? raw.required_evidence.elevated : undefined, 'merge.required_evidence.elevated') ?? [requiredReviews === 0 ? 'validation' : 'review'])
        .map((kind) => normalizeIdentifier(kind))
        .filter(Boolean),
    },
    substantive_ignored_paths: (asStringArray(raw.substantive_ignored_paths, 'merge.substantive_ignored_paths') ?? [])
      .map((entry) => entry.trim())
      .filter(Boolean),
    rules: (raw.rules as unknown[] | undefined)?.map(normalizeMergeRule) ?? [],
  };
}

function normalizeScheduledLoops(value: unknown): ScheduledLoopConfig[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new SymphonyConfigError('loops must be an array');
  const seenIds = new Set<string>();
  return value.map((entry, index) => {
    const keyPath = `loops[${index}]`;
    if (!isRecord(entry)) throw new SymphonyConfigError(`${keyPath} must be an object`);
    const id = normalizeIdentifier(asTrimmedStringOrNull(entry.id, `${keyPath}.id`) ?? '');
    if (!id) throw new SymphonyConfigError(`${keyPath}.id is required`);
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
      throw new SymphonyConfigError(`${keyPath}.id may contain only lowercase letters, numbers, dots, underscores, and hyphens`);
    }
    if (seenIds.has(id)) throw new SymphonyConfigError(`loops contains duplicate id: ${id}`);
    seenIds.add(id);
    const intervalMs = asNumber(entry.interval_ms, `${keyPath}.interval_ms`);
    if (intervalMs === null || !Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new SymphonyConfigError(`${keyPath}.interval_ms must be a positive number`);
    }
    const prompt = asTrimmedStringOrNull(entry.prompt, `${keyPath}.prompt`);
    if (!prompt) throw new SymphonyConfigError(`${keyPath}.prompt is required`);
    const provider = asTrimmedStringOrNull(entry.provider, `${keyPath}.provider`);
    return {
      id,
      enabled: asBoolean(entry.enabled, `${keyPath}.enabled`) ?? true,
      interval_ms: intervalMs,
      prompt,
      provider: provider ? normalizeIdentifier(provider) : null,
    };
  });
}

function normalizeWorkflowConfig(raw: unknown): WorkflowConfig {
  if (!isRecord(raw)) throw new SymphonyConfigError('WORKFLOW.md front matter must be a YAML object');

  const trackerRaw = raw.tracker;
  if (!isRecord(trackerRaw)) throw new SymphonyConfigError('tracker is required');

  const kind = asString(trackerRaw.kind, 'tracker.kind') ?? 'github';
  if (kind !== 'github') throw new SymphonyConfigError(`Unsupported tracker.kind: ${kind}`);

  const owner = asString(trackerRaw.owner, 'tracker.owner');
  const repo = asString(trackerRaw.repo, 'tracker.repo');
  if (!owner) throw new SymphonyConfigError('tracker.owner is required');
  if (!repo) throw new SymphonyConfigError('tracker.repo is required');

  const token = asString(trackerRaw.token, 'tracker.token') ?? null;

  const activeStates = asStringArray(trackerRaw.active_states, 'tracker.active_states') ?? ['open'];
  const terminalStates = asStringArray(trackerRaw.terminal_states, 'tracker.terminal_states') ?? ['closed'];
  const requiredLabels = (asStringArray(trackerRaw.required_labels, 'tracker.required_labels') ?? ['ready-for-agent']).map((l) =>
    l.trim().toLowerCase(),
  );
  const anyRequiredLabels = asStringArray(trackerRaw.any_required_labels, 'tracker.any_required_labels');
  const ignoredLabels = (asStringArray(trackerRaw.ignored_labels, 'tracker.ignored_labels') ?? ['blocked', 'ready-for-human', 'wontfix']).map(
    (l) => l.trim().toLowerCase(),
  );

  const branchPrefix = asString(trackerRaw.branch_prefix, 'tracker.branch_prefix') ?? 'symphony';
  const candidateOrder = normalizeCandidateOrder(trackerRaw.candidate_order);

  const includePullRequests = asBoolean(trackerRaw.include_pull_requests, 'tracker.include_pull_requests') ?? false;
  const pageSize = asNumber(trackerRaw.page_size, 'tracker.page_size') ?? 50;
  const requestTimeoutMs = asNumber(trackerRaw.request_timeout_ms, 'tracker.request_timeout_ms') ?? 30000;
  const apiBaseUrl = asString(trackerRaw.api_base_url, 'tracker.api_base_url') ?? 'https://api.github.com';
  const graphqlUrl = asString(trackerRaw.graphql_url, 'tracker.graphql_url') ?? 'https://api.github.com/graphql';
  const epics = normalizeEpicConfig(trackerRaw.epics);

  const pollingRaw = isRecord(raw.polling) ? raw.polling : {};
  const pollingInterval = asNumber(pollingRaw.interval_ms, 'polling.interval_ms') ?? 30000;

  const workspaceRaw = isRecord(raw.workspace) ? raw.workspace : {};
  const defaultWorkspaceRoot = `~/.symphony/workspaces/${owner}_${repo}`;
  const workspaceRoot = expandHomeDir(asString(workspaceRaw.root, 'workspace.root') ?? defaultWorkspaceRoot);
  const cleanOnTerminal = asBoolean(workspaceRaw.clean_on_terminal, 'workspace.clean_on_terminal') ?? false;
  const workspaceStrategy = normalizeWorkspaceStrategy(workspaceRaw.strategy);
  if (workspaceRaw.storage_maintenance !== undefined && !isRecord(workspaceRaw.storage_maintenance)) {
    throw new SymphonyConfigError('workspace.storage_maintenance must be an object');
  }
  const storageRaw = isRecord(workspaceRaw.storage_maintenance) ? workspaceRaw.storage_maintenance : {};
  const storage = { ...DEFAULT_STORAGE_POLICY };
  storage.enabled = asBoolean(storageRaw.enabled, 'workspace.storage_maintenance.enabled') ?? storage.enabled;
  storage.cache_root = asString(storageRaw.cache_root, 'workspace.storage_maintenance.cache_root');
  if (storage.cache_root) storage.cache_root = expandHomeDir(storage.cache_root);
  for (const key of ['interval_ms', 'min_free_gib', 'idle_days', 'retention_days', 'max_artifact_gib', 'max_pool_slots', 'max_cache_gib'] as const) {
    const value = asNumber(storageRaw[key], `workspace.storage_maintenance.${key}`) ?? storage[key];
    if (!Number.isFinite(value) || value <= 0 || (key === 'max_pool_slots' && !Number.isInteger(value))) {
      throw new SymphonyConfigError(`workspace.storage_maintenance.${key} must be a positive ${key === 'max_pool_slots' ? 'integer' : 'number'}`);
    }
    storage[key] = value;
  }


  const hooksRaw = isRecord(raw.hooks) ? raw.hooks : {};
  const hooksTimeout = asNumber(hooksRaw.timeout_ms, 'hooks.timeout_ms') ?? 120000;
  const afterCreate = asString(hooksRaw.after_create, 'hooks.after_create');
  const beforeRun = asString(hooksRaw.before_run, 'hooks.before_run');
  const afterRun = asString(hooksRaw.after_run, 'hooks.after_run');

  const agentRaw = isRecord(raw.agent) ? raw.agent : {};
  const maxConcurrentAgents = asNumber(agentRaw.max_concurrent_agents, 'agent.max_concurrent_agents') ?? 1;
  const maxRetryBackoffMs = asNumber(agentRaw.max_retry_backoff_ms, 'agent.max_retry_backoff_ms') ?? 300000;
  const maxAttempts = asNumber(agentRaw.max_attempts, 'agent.max_attempts') ?? null;
  if (maxAttempts !== null && (!Number.isFinite(maxAttempts) || maxAttempts < 1)) {
    throw new SymphonyConfigError('agent.max_attempts must be a positive number');
  }
  const byState = isRecord(agentRaw.max_concurrent_agents_by_state) ? (agentRaw.max_concurrent_agents_by_state as AnyRecord) : null;
  const maxConcurrentAgentsByState: Record<string, number> | null = byState
    ? Object.fromEntries(
        Object.entries(byState).map(([k, v]) => {
          if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
            throw new SymphonyConfigError('agent.max_concurrent_agents_by_state values must be numbers');
          }
          return [k, v];
        }),
      )
    : null;

  const reviewRaw = isRecord(raw.review) ? raw.review : {};
  const reviewEnabled = asBoolean(reviewRaw.enabled, 'review.enabled') ?? true;
  const autoFixReviewComments = asBoolean(reviewRaw.auto_fix_review_comments, 'review.auto_fix_review_comments') ?? false;
  const shepherdPullRequests = asBoolean(reviewRaw.shepherd_pull_requests, 'review.shepherd_pull_requests') ?? false;
  const maxFeedbackRounds = asNumber(reviewRaw.max_feedback_rounds, 'review.max_feedback_rounds') ?? 5;
  if (!Number.isFinite(maxFeedbackRounds) || maxFeedbackRounds < 1 || Math.floor(maxFeedbackRounds) !== maxFeedbackRounds) {
    throw new SymphonyConfigError('review.max_feedback_rounds must be a positive integer');
  }
  const nonBlockingFeedbackPriorities = (asStringArray(
    reviewRaw.non_blocking_feedback_priorities,
    'review.non_blocking_feedback_priorities',
  ) ?? ['p2', 'p3']).map((priority) => normalizeIdentifier(priority));
  if (
    nonBlockingFeedbackPriorities.length === 0 ||
    nonBlockingFeedbackPriorities.some((priority) => !/^p[0-3]$/.test(priority))
  ) {
    throw new SymphonyConfigError('review.non_blocking_feedback_priorities must contain one or more of p0, p1, p2, p3');
  }
  const reviewLenses = (asStringArray(reviewRaw.lenses, 'review.lenses') ?? ['staff-engineer'])
    .map((lens) => normalizeIdentifier(lens))
    .filter(Boolean);
  if (reviewLenses.length === 0) throw new SymphonyConfigError('review.lenses must contain at least one lens');
  const numberOfAutoFixIterations = asNumber(reviewRaw.number_of_auto_fix_iterations, 'review.number_of_auto_fix_iterations') ?? 1;
  if (
    !Number.isFinite(numberOfAutoFixIterations) ||
    numberOfAutoFixIterations < 0 ||
    Math.floor(numberOfAutoFixIterations) !== numberOfAutoFixIterations
  ) {
    throw new SymphonyConfigError('review.number_of_auto_fix_iterations must be a non-negative integer');
  }

  const agents = normalizeAgentsConfig(raw);
  const merge = normalizeMergeConfig(raw.merge);
  const loops = normalizeScheduledLoops(raw.loops);
  for (const loop of loops) {
    if (loop.provider && !agents.providers[loop.provider]) {
      throw new SymphonyConfigError(`loops provider references unknown provider: ${loop.provider}`);
    }
  }

  const priorityLabels = normalizePriorityLabels(trackerRaw.priority_labels);

  return {
    tracker: {
      kind: 'github',
      owner,
      repo,
      token,
      api_base_url: apiBaseUrl,
      graphql_url: graphqlUrl,
      candidate_order: candidateOrder,
      active_states: activeStates,
      terminal_states: terminalStates,
      required_labels: requiredLabels,
      any_required_labels: anyRequiredLabels,
      ignored_labels: ignoredLabels,
      priority_labels: priorityLabels,
      branch_prefix: branchPrefix,
      include_pull_requests: includePullRequests,
      epics,
      page_size: pageSize,
      request_timeout_ms: requestTimeoutMs,
    },
    polling: { interval_ms: pollingInterval },
    workspace: { root: workspaceRoot, clean_on_terminal: cleanOnTerminal, strategy: workspaceStrategy, storage_maintenance: storage },
    hooks: {
      after_create: afterCreate ?? null,
      before_run: beforeRun ?? null,
      after_run: afterRun ?? null,
      timeout_ms: hooksTimeout,
    },
    agent: {
      max_concurrent_agents: maxConcurrentAgents,
      max_retry_backoff_ms: maxRetryBackoffMs,
      max_attempts: maxAttempts === null ? null : Math.floor(maxAttempts),
      max_concurrent_agents_by_state: maxConcurrentAgentsByState,
    },
    review: {
      enabled: reviewEnabled,
      auto_fix_review_comments: autoFixReviewComments,
      number_of_auto_fix_iterations: numberOfAutoFixIterations,
      shepherd_pull_requests: shepherdPullRequests,
      max_feedback_rounds: Math.floor(maxFeedbackRounds),
      non_blocking_feedback_priorities: [...new Set(nonBlockingFeedbackPriorities)],
      lenses: reviewLenses,
    },
    merge,
    loops,
    agents,
  };
}

export async function loadWorkflowFromFile(
  workflowPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LoadedWorkflow> {
  const rawText = await fs.readFile(workflowPath, 'utf8');
  const { yaml, body } = splitFrontMatter(rawText);

  const rawConfig = yaml ? parseYaml(yaml) : {};
  const resolved = resolveEnvRefs(rawConfig, env);
  let config = normalizeWorkflowConfig(resolved);
  const workflowSha = createHash('sha256').update(rawText).digest('hex');
  config = { ...config, workflow_sha: workflowSha, merge: { ...config.merge, workflow_sha: workflowSha } };

  // If no token is provided via env/literal, attempt to use existing `gh` CLI auth.
  // This does not persist to the parent shell, but sets `process.env.GITHUB_TOKEN`
  // for this process and child processes (hooks/agent) for the duration of the run.
  if (!config.tracker.token) {
    const ghToken = await getGhAuthToken({ timeoutMs: 5_000 });
    if (ghToken) {
      if (!process.env.GITHUB_TOKEN) process.env.GITHUB_TOKEN = ghToken;
      config = { ...config, tracker: { ...config.tracker, token: ghToken } };
    }
  }

  return {
    config,
    prompt_template: body,
  };
}
