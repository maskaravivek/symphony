import fs from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';

import { getGhAuthToken } from '../github/ghAuth.js';
import { SymphonyConfigError } from '../utils/errors.js';
import { expandHomeDir } from '../utils/fs.js';
import type { LoadedWorkflow, WorkflowConfig } from './types.js';

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
  const maxDepth = asNumber(raw.max_depth, 'tracker.epics.max_depth') ?? 8;
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 8) {
    throw new SymphonyConfigError('tracker.epics.max_depth must be an integer between 1 and 8');
  }

  return {
    enabled,
    relationship_source: relationshipSource,
    auto_label_children: autoLabelChildren,
    parent_mode: parentMode,
    max_depth: maxDepth,
  };
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

  const codexRaw = isRecord(raw.codex) ? raw.codex : {};
  const codexCommand = asString(codexRaw.command, 'codex.command') ?? 'codex app-server';
  const codexResumeCommand =
    asString(codexRaw.resume_command, 'codex.resume_command') ??
    'bash -lc \'set -o pipefail; codex exec resume --json --dangerously-bypass-approvals-and-sandbox --output-last-message .symphony/last_message.md "{{ symphony.codex_thread_id }}" - < "{{ symphony.prompt_path }}" | tee .symphony/codex.jsonl\'';
  const codexHandoffCommand =
    asString(codexRaw.handoff_command, 'codex.handoff_command') ??
    'bash -lc \'set -o pipefail; codex exec --json -s read-only -C . --output-last-message .symphony/last_message.md - < "{{ symphony.prompt_path }}" | tee .symphony/codex.jsonl\'';
  const codexTurnTimeoutMs = asNumber(codexRaw.turn_timeout_ms, 'codex.turn_timeout_ms') ?? 3600000;

  const priorityLabels = normalizePriorityLabels(trackerRaw.priority_labels);

  return {
    tracker: {
      kind: 'github',
      owner,
      repo,
      token,
      api_base_url: apiBaseUrl,
      graphql_url: graphqlUrl,
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
    workspace: { root: workspaceRoot, clean_on_terminal: cleanOnTerminal },
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
    codex: {
      command: codexCommand,
      resume_command: codexResumeCommand,
      handoff_command: codexHandoffCommand,
      turn_timeout_ms: codexTurnTimeoutMs,
    },
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
