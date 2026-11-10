import type { DashboardGithubCache } from './githubCache.js';
import { loadRepoLocalState, type RepoLocalState } from './localState.js';
import { readLogFallback } from './logFallback.js';
import type { DashboardRepoSource, DashboardSources } from './sources.js';

/** Options shared by every dashboard read model. */
export interface ReadModelOptions {
  now?: Date;
  staleAfterMs?: number;
  /** GitHub enrichment cache; null/undefined reads local state only. */
  github?: DashboardGithubCache | null;
  /** Force a GitHub refresh before responding (`?github=1`). */
  forceGithub?: boolean;
}

export async function loadLocal(sources: DashboardSources, repo: DashboardRepoSource, options: ReadModelOptions): Promise<RepoLocalState> {
  const now = options.now ?? new Date();
  const github = options.github ?? null;
  return loadRepoLocalState(repo, {
    now,
    staleAfterMs: options.staleAfterMs,
    pollingIntervalMs: sources.polling_interval_ms,
    resolveGithub: github ? (numbers) => github.ensure(repo.repo_id, repo.config, numbers, { force: options.forceGithub }) : undefined,
    logFallback: async () => (await readLogFallback(sources.control_dir, now)).get(sources.source.kind === 'config' ? repo.repo_id : 'default') ?? null,
  });
}

export function loadAllLocal(sources: DashboardSources, options: ReadModelOptions): Promise<RepoLocalState[]> {
  return Promise.all(sources.repos.map((repo) => loadLocal(sources, repo, options)));
}

export class DashboardNotFoundError extends Error {
  readonly status = 404;
}
