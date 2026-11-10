import path from 'node:path';

import { loadServerConfigFromFile } from '../../server/loadServerConfig.js';
import type { ServerConfig } from '../../server/types.js';
import { loadWorkflowFromFile } from '../../workflow/loadWorkflow.js';
import { resolveWorkflowPath } from '../../workflow/resolveWorkflowPath.js';
import type { WorkflowConfig } from '../../workflow/types.js';
import type { SourceInfo } from '../dashboardTypes.js';

/** WORKFLOW.md and symphony.config.yml rarely change; re-read them at most this often. */
export const SOURCE_CACHE_TTL_MS = 30_000;

export interface DashboardRepoSource {
  repo_id: string;
  workflow_path: string;
  enabled: boolean;
  /** Per-repo override from symphony.config.yml, if any. */
  max_concurrent_agents: number | null;
  /** Null when WORKFLOW.md failed to load; see load_error. */
  config: WorkflowConfig | null;
  load_error: string | null;
  workspace_root: string | null;
  owner: string | null;
  repo: string | null;
}

export interface DashboardSources {
  source: SourceInfo;
  /** Directory holding `.symphony/heartbeat.json` and `.symphony/logs/` for the orchestrator. */
  control_dir: string;
  polling_interval_ms: number | null;
  max_concurrent_agents: number | null;
  repos: DashboardRepoSource[];
  /** Every workspace root; artifact reads are confined to these. */
  allowed_roots: string[];
}

export interface ResolveDashboardSourcesOptions {
  config?: string;
  workflow?: string;
  now?: number;
  /** Bypass the TTL cache (tests). */
  fresh?: boolean;
}

interface CacheEntry<T> {
  at: number;
  value: Promise<T>;
}

const workflowCache = new Map<string, CacheEntry<WorkflowConfig>>();
const serverConfigCache = new Map<string, CacheEntry<ServerConfig>>();

function cached<T>(cache: Map<string, CacheEntry<T>>, key: string, now: number, fresh: boolean, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (!fresh && hit && now - hit.at < SOURCE_CACHE_TTL_MS) return hit.value;
  const value = load();
  cache.set(key, { at: now, value });
  // Failed loads are not cached, so a fixed WORKFLOW.md shows up on the next request.
  value.catch(() => {
    if (cache.get(key)?.value === value) cache.delete(key);
  });
  return value;
}

export function clearDashboardSourceCache(): void {
  workflowCache.clear();
  serverConfigCache.clear();
}

async function loadRepo(
  repoId: string,
  workflowPath: string,
  enabled: boolean,
  maxConcurrentAgents: number | null,
  now: number,
  fresh: boolean,
): Promise<DashboardRepoSource> {
  try {
    const config = await cached(workflowCache, workflowPath, now, fresh, async () => (await loadWorkflowFromFile(workflowPath)).config);
    return {
      repo_id: repoId,
      workflow_path: workflowPath,
      enabled,
      max_concurrent_agents: maxConcurrentAgents,
      config,
      load_error: null,
      workspace_root: config.workspace.root,
      owner: config.tracker.owner,
      repo: config.tracker.repo,
    };
  } catch (err) {
    return {
      repo_id: repoId,
      workflow_path: workflowPath,
      enabled,
      max_concurrent_agents: maxConcurrentAgents,
      config: null,
      load_error: err instanceof Error ? err.message : String(err),
      workspace_root: null,
      owner: null,
      repo: null,
    };
  }
}

/**
 * Resolves the repos the dashboard reads, mirroring `loadBoardState`: config mode lists every
 * enabled repo from symphony.config.yml; workflow mode is a single repo with id `default`.
 */
export async function resolveDashboardSources(options: ResolveDashboardSourcesOptions): Promise<DashboardSources> {
  const now = options.now ?? Date.now();
  const fresh = options.fresh ?? false;
  if (options.config) {
    const configPath = path.resolve(options.config);
    const serverConfig = await cached(serverConfigCache, configPath, now, fresh, () => loadServerConfigFromFile(configPath));
    const repos = await Promise.all(
      serverConfig.repos
        .filter((repo) => repo.enabled)
        .map((repo) => loadRepo(repo.id, repo.workflow, repo.enabled, repo.max_concurrent_agents, now, fresh)),
    );
    return {
      source: { kind: 'config', path: configPath },
      control_dir: path.dirname(configPath),
      polling_interval_ms: serverConfig.polling.interval_ms,
      max_concurrent_agents: serverConfig.agent.max_concurrent_agents,
      repos,
      allowed_roots: allowedRoots(repos),
    };
  }

  const workflowPath = path.resolve(await resolveWorkflowPath(options.workflow ?? 'WORKFLOW.md'));
  const repo = await loadRepo('default', workflowPath, true, null, now, fresh);
  return {
    source: { kind: 'workflow', path: workflowPath },
    control_dir: path.dirname(workflowPath),
    polling_interval_ms: repo.config?.polling.interval_ms ?? null,
    max_concurrent_agents: repo.config?.agent.max_concurrent_agents ?? null,
    repos: [repo],
    allowed_roots: allowedRoots([repo]),
  };
}

function allowedRoots(repos: DashboardRepoSource[]): string[] {
  return [...new Set(repos.map((repo) => repo.workspace_root).filter((root): root is string => Boolean(root)).map((root) => path.resolve(root)))];
}

export function findRepoSource(sources: DashboardSources, repoId: string): DashboardRepoSource | null {
  return sources.repos.find((repo) => repo.repo_id === repoId) ?? null;
}
