import type { Issue } from '../../domain/issue.js';
import { GithubIssueTrackerClient, isGithubRateLimitError, type PullRequestRef } from '../../github/githubClient.js';
import type { WorkflowConfig } from '../../workflow/types.js';

export const GITHUB_CACHE_TTL_MS = 5 * 60_000;
export const GITHUB_COLD_WAIT_MS = 2_000;
export const GITHUB_FORCED_WAIT_MS = 15_000;
const ISSUE_FETCH_CONCURRENCY = 6;

export interface GithubIssueMeta {
  id?: string;
  number: number;
  identifier: string;
  title: string;
  labels: string[];
  state: string;
  workflow_state: string | null;
  updated_at: string | null;
  url: string | null;
}

export interface GithubRepoSnapshot {
  issues: ReadonlyMap<number, GithubIssueMeta>;
  pull_requests: PullRequestRef[];
  /** Null until the first refresh completes; consumers treat that as "no GitHub data". */
  last_refreshed_at: string | null;
  last_error: string | null;
  backoff_until: string | null;
  refreshing: boolean;
}

export interface GithubCacheClient {
  listOpenPullRequests(): Promise<PullRequestRef[]>;
  fetchIssueOrPullRequestByNumber(number: number): Promise<Issue | null>;
}

export interface GithubCacheOptions {
  /** False disables all GitHub access (tests, `liveRefresh: false`). */
  enabled?: boolean;
  ttlMs?: number;
  coldWaitMs?: number;
  forcedWaitMs?: number;
  clientFactory?: (config: WorkflowConfig) => GithubCacheClient;
  now?: () => number;
}

interface RepoEntry {
  issues: Map<number, GithubIssueMeta>;
  pullRequests: PullRequestRef[];
  refreshedAtMs: number | null;
  lastError: string | null;
  backoffUntilMs: number | null;
  inflight: Promise<void> | null;
  requested: Set<number>;
  requestedAtLastRefresh: number;
}

const EMPTY_SNAPSHOT: GithubRepoSnapshot = {
  issues: new Map(),
  pull_requests: [],
  last_refreshed_at: null,
  last_error: null,
  backoff_until: null,
  refreshing: false,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await fn(items[index]!);
      }
    }),
  );
  return results;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Per-repo GitHub enrichment (issue metadata + open PRs), refreshed in the background with a
 * TTL. Requests never wait on GitHub longer than `coldWaitMs` (only when nothing is cached yet);
 * otherwise they get the cached snapshot and a refresh is started if it is stale.
 */
export class DashboardGithubCache {
  private readonly entries = new Map<string, RepoEntry>();
  private readonly listeners = new Set<(repoId: string) => void>();
  private readonly enabled: boolean;
  private readonly ttlMs: number;
  private readonly coldWaitMs: number;
  private readonly forcedWaitMs: number;
  private readonly clientFactory: (config: WorkflowConfig) => GithubCacheClient;
  private readonly now: () => number;

  constructor(options: GithubCacheOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.ttlMs = options.ttlMs ?? GITHUB_CACHE_TTL_MS;
    this.coldWaitMs = options.coldWaitMs ?? GITHUB_COLD_WAIT_MS;
    this.forcedWaitMs = options.forcedWaitMs ?? GITHUB_FORCED_WAIT_MS;
    this.clientFactory = options.clientFactory ?? ((config) => new GithubIssueTrackerClient(config.tracker));
    this.now = options.now ?? Date.now;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Called after each completed refresh (success or failure) with the repo id. */
  onRefresh(listener: (repoId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(repoId: string): GithubRepoSnapshot {
    const entry = this.entries.get(repoId);
    if (!entry) return EMPTY_SNAPSHOT;
    return {
      issues: entry.issues,
      pull_requests: entry.pullRequests,
      last_refreshed_at: entry.refreshedAtMs !== null ? new Date(entry.refreshedAtMs).toISOString() : null,
      last_error: entry.lastError,
      backoff_until: entry.backoffUntilMs !== null && entry.backoffUntilMs > this.now() ? new Date(entry.backoffUntilMs).toISOString() : null,
      refreshing: entry.inflight !== null,
    };
  }

  /**
   * Returns the snapshot for a repo, starting a background refresh when stale or when new issue
   * numbers appear. Waits up to `coldWaitMs` on a cold cache, or `forcedWaitMs` when `force`.
   */
  async ensure(repoId: string, config: WorkflowConfig | null, issueNumbers: Iterable<number>, options: { force?: boolean } = {}): Promise<GithubRepoSnapshot> {
    if (!this.enabled || !config) return this.snapshot(repoId);
    let entry = this.entries.get(repoId);
    if (!entry) {
      entry = { issues: new Map(), pullRequests: [], refreshedAtMs: null, lastError: null, backoffUntilMs: null, inflight: null, requested: new Set(), requestedAtLastRefresh: 0 };
      this.entries.set(repoId, entry);
    }
    for (const number of issueNumbers) entry.requested.add(number);
    const missing = entry.requested.size > entry.requestedAtLastRefresh;
    const now = this.now();
    const inBackoff = entry.backoffUntilMs !== null && entry.backoffUntilMs > now;
    const stale = entry.refreshedAtMs === null || now - entry.refreshedAtMs >= this.ttlMs;
    if (!inBackoff && (options.force || stale || missing) && !entry.inflight) {
      entry.inflight = this.refresh(repoId, config, entry).finally(() => {
        entry.inflight = null;
        for (const listener of this.listeners) {
          try {
            listener(repoId);
          } catch {
            // Listeners must not break refreshes.
          }
        }
      });
    }
    const wait = options.force ? this.forcedWaitMs : entry.refreshedAtMs === null ? this.coldWaitMs : 0;
    if (entry.inflight && wait > 0) await Promise.race([entry.inflight, sleep(wait)]);
    return this.snapshot(repoId);
  }

  private async refresh(_repoId: string, config: WorkflowConfig, entry: RepoEntry): Promise<void> {
    const numbers = [...entry.requested];
    entry.requestedAtLastRefresh = numbers.length;
    let client: GithubCacheClient;
    try {
      client = this.clientFactory(config);
    } catch (err) {
      entry.lastError = message(err);
      entry.refreshedAtMs = this.now();
      return;
    }
    const errors: string[] = [];
    let rateLimited: number | null = null;
    const noteError = (err: unknown) => {
      if (isGithubRateLimitError(err)) {
        const until = err.resetAtMs ?? (err.retryAfterMs !== null ? this.now() + err.retryAfterMs : this.now() + 60_000);
        rateLimited = Math.max(rateLimited ?? 0, until);
      }
      errors.push(message(err));
    };
    const [pullRequests, issues] = await Promise.all([
      client.listOpenPullRequests().catch((err: unknown) => {
        noteError(err);
        return null;
      }),
      mapLimit(numbers, ISSUE_FETCH_CONCURRENCY, async (number) => {
        if (rateLimited !== null) return null;
        try {
          return await client.fetchIssueOrPullRequestByNumber(number);
        } catch (err) {
          noteError(err);
          return null;
        }
      }),
    ]);
    if (pullRequests) entry.pullRequests = pullRequests;
    for (const issue of issues) {
      if (!issue || issue.number === null) continue;
      entry.issues.set(issue.number, {
        id: issue.id,
        number: issue.number,
        identifier: issue.identifier,
        title: issue.title,
        labels: issue.labels,
        state: issue.state,
        workflow_state: issue.workflow_state,
        updated_at: issue.updated_at,
        url: issue.url,
      });
    }
    entry.refreshedAtMs = this.now();
    entry.backoffUntilMs = rateLimited;
    entry.lastError = errors.length > 0 ? `${errors[0]}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ''}` : null;
  }
}
