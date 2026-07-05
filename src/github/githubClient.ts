import type { Issue } from '../domain/issue.js';
import type { EpicTreeNode } from '../domain/epic.js';
import type { GithubTrackerConfig } from '../workflow/types.js';
import { SymphonyRuntimeError } from '../utils/errors.js';
import { log } from '../utils/log.js';

type GithubLabel = { name?: string } | string;
type GithubUser = { login?: string };
type GithubMilestone = { title?: string };
type GithubCommentPayload = {
  id?: number;
  body?: string | null;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
  user?: GithubUser | null;
};

type GithubIssuePayload = {
  id?: number;
  node_id?: string;
  number?: number;
  title?: string;
  body?: string | null;
  state?: string;
  labels?: GithubLabel[];
  assignees?: GithubUser[];
  milestone?: GithubMilestone | null;
  html_url?: string;
  repository_url?: string;
  created_at?: string;
  updated_at?: string;
  pull_request?: unknown;
};

type GithubIssueEventPayload = {
  event?: string;
  created_at?: string;
  label?: GithubLabel | null;
  issue?: { number?: number } | null;
};

type GithubPullRequestPayload = {
  number?: number;
  title?: string;
  body?: string | null;
  state?: string;
  draft?: boolean;
  labels?: GithubLabel[];
  html_url?: string;
  head?: { ref?: string; repo?: { full_name?: string } | null } | null;
  base?: { ref?: string; repo?: { full_name?: string } | null } | null;
  mergeable_state?: string | null;
};

export interface IssueTrackerClient {
  fetchCandidateIssues(): Promise<Issue[]>;
  fetchIssuesByStates(stateNames: string[]): Promise<Issue[]>;
  fetchIssueStatesByIds(issueIds: string[]): Promise<Map<string, string>>;
  fetchIssueByNumber(number: number): Promise<Issue | null>;
  listSubIssues(number: number): Promise<Issue[]>;
  getParentIssue(number: number): Promise<Issue | null>;
}

export interface IssueComment {
  id: number;
  body: string;
  url: string | null;
  author: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface RepositoryLabel {
  name: string;
}

export interface StatusCommentResult {
  id: number;
  created: boolean;
}

export interface PullRequestRef {
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: string[];
  is_draft: boolean;
  url: string | null;
  head_ref: string;
  base_ref: string;
  merge_state_status: string | null;
}

function normalizeLabelName(label: GithubLabel): string | null {
  if (typeof label === 'string') return label.trim().toLowerCase();
  if (label && typeof label.name === 'string') return label.name.trim().toLowerCase();
  return null;
}

function normalizeLabels(labels: GithubLabel[] | undefined): string[] {
  const out: string[] = [];
  for (const l of labels ?? []) {
    const name = normalizeLabelName(l);
    if (name) out.push(name);
  }
  return out;
}

function derivePriority(labels: string[], priorityLabels: Record<string, number> | null): number | null {
  if (!priorityLabels) return null;
  for (const label of labels) {
    const p = priorityLabels[label];
    if (typeof p === 'number') return p;
  }
  return null;
}

function deriveWorkflowState(labels: string[]): string | null {
  if (labels.includes('blocked')) return 'blocked';
  if (labels.includes('ready-for-human')) return 'ready-for-human';
  if (labels.includes('needs-info')) return 'needs-info';
  if (labels.includes('agent-running')) return 'agent-running';
  if (labels.includes('interactive')) return 'interactive';
  if (labels.includes('ready-for-agent')) return 'ready-for-agent';
  return null;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

function deriveBranchName(branchPrefix: string, issueNumber: number | null, title: string): string | null {
  if (!issueNumber) return null;
  const slug = slugify(title).slice(0, 48) || 'issue';
  const prefix = slugify(branchPrefix);
  return [prefix, `${issueNumber}-${slug}`].filter(Boolean).join('-');
}

function ownerRepoFromRepositoryUrl(repositoryUrl: string | undefined): { owner: string; repo: string } | null {
  if (!repositoryUrl) return null;
  const match = /\/repos\/([^/]+)\/([^/]+)$/.exec(repositoryUrl);
  if (!match) return null;
  return { owner: decodeURIComponent(match[1]), repo: decodeURIComponent(match[2]) };
}

function parseBlockers(body: string | null): { owner: string | null; repo: string | null; number: number }[] {
  if (!body) return [];
  const results: { owner: string | null; repo: string | null; number: number }[] = [];
  const lines = body.split('\n');
  for (const line of lines) {
    const match = /^\s*(blocked by|depends on)\s*:\s*(.+?)\s*$/i.exec(line);
    if (!match) continue;
    const refs = match[2]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const ref of refs) {
      const sameRepo = /^#(\d+)$/.exec(ref);
      if (sameRepo) {
        results.push({ owner: null, repo: null, number: Number(sameRepo[1]) });
        continue;
      }
      const crossRepo = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/.exec(ref);
      if (crossRepo) {
        results.push({ owner: crossRepo[1], repo: crossRepo[2], number: Number(crossRepo[3]) });
      }
    }
  }
  return results;
}

function normalizeGithubIssuePayload(owner: string, repo: string, tracker: GithubTrackerConfig, payload: GithubIssuePayload): Issue {
  const payloadRepo = ownerRepoFromRepositoryUrl(payload.repository_url);
  const issueOwner = payloadRepo?.owner ?? owner;
  const issueRepo = payloadRepo?.repo ?? repo;
  const issueId = payload.node_id ?? (payload.id !== undefined ? String(payload.id) : null);
  const number = typeof payload.number === 'number' ? payload.number : null;
  const title = typeof payload.title === 'string' ? payload.title : '';
  const state = typeof payload.state === 'string' ? payload.state : 'unknown';
  const labels = normalizeLabels(payload.labels);

  if (!issueId) throw new SymphonyRuntimeError('GitHub issue payload missing id');
  if (!number) throw new SymphonyRuntimeError(`GitHub issue payload missing number for id ${issueId}`);
  if (!title) throw new SymphonyRuntimeError(`GitHub issue payload missing title for ${issueOwner}/${issueRepo}#${number}`);

  const blockers = parseBlockers(payload.body ?? null).map((b) => ({
    id: null,
    identifier: b.owner && b.repo ? `${b.owner}/${b.repo}#${b.number}` : `${issueOwner}/${issueRepo}#${b.number}`,
    state: null,
  }));

  return {
    id: issueId,
    identifier: `${issueOwner}/${issueRepo}#${number}`,
    number,
    title,
    description: payload.body ?? null,
    priority: derivePriority(labels, tracker.priority_labels),
    state,
    workflow_state: deriveWorkflowState(labels),
    branch_name: issueOwner === tracker.owner && issueRepo === tracker.repo ? deriveBranchName(tracker.branch_prefix, number, title) : null,
    url: payload.html_url ?? null,
    labels,
    assignees: (payload.assignees ?? []).map((a) => a.login).filter((v): v is string => typeof v === 'string'),
    milestone: payload.milestone?.title ?? null,
    blocked_by: blockers,
    pull_requests: [],
    created_at: payload.created_at ?? null,
    updated_at: payload.updated_at ?? null,
    ready_for_agent_labeled_at: null,
  };
}

function normalizePullRequestPayload(payload: GithubPullRequestPayload): PullRequestRef | null {
  if (typeof payload.number !== 'number') return null;
  return {
    number: payload.number,
    title: typeof payload.title === 'string' ? payload.title : '',
    body: typeof payload.body === 'string' ? payload.body : null,
    state: typeof payload.state === 'string' ? payload.state : 'unknown',
    labels: normalizeLabels(payload.labels),
    is_draft: Boolean(payload.draft),
    url: typeof payload.html_url === 'string' ? payload.html_url : null,
    head_ref: typeof payload.head?.ref === 'string' ? payload.head.ref : '',
    base_ref: typeof payload.base?.ref === 'string' ? payload.base.ref : 'main',
    merge_state_status: typeof payload.mergeable_state === 'string' ? payload.mergeable_state : null,
  };
}

function parseLinkHeader(linkHeader: string | null): Map<string, string> {
  const map = new Map<string, string>();
  if (!linkHeader) return map;
  // <url>; rel="next", <url>; rel="last"
  for (const part of linkHeader.split(',')) {
    const match = /<([^>]+)>;\s*rel=\"([^\"]+)\"/.exec(part.trim());
    if (match) map.set(match[2], match[1]);
  }
  return map;
}

export class GithubIssueTrackerClient implements IssueTrackerClient {
  private tracker: GithubTrackerConfig;
  private readyForAgentLabeledAtCache = new Map<string, { updated_at: string | null; ready_for_agent_labeled_at: string | null }>();

  constructor(tracker: GithubTrackerConfig) {
    this.tracker = tracker;
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    const state = this.tracker.active_states[0] ?? 'open';
    const labelsParam = this.tracker.required_labels.join(',');
    const url = new URL(`/repos/${this.tracker.owner}/${this.tracker.repo}/issues`, this.tracker.api_base_url);
    url.searchParams.set('state', state);
    url.searchParams.set('labels', labelsParam);
    url.searchParams.set('per_page', String(this.tracker.page_size));

    const raw = await this.fetchAllPages<GithubIssuePayload>(url.toString());
    const issues = raw
      .filter((p) => (this.tracker.include_pull_requests ? true : p.pull_request === undefined))
      .map((p) => normalizeGithubIssuePayload(this.tracker.owner, this.tracker.repo, this.tracker, p));

    const eligible = await this.filterEligibleIssues(issues);
    await this.enrichReadyForAgentLabeledAt(eligible);
    return this.sortIssues(eligible);
  }

  async fetchCandidatePullRequestIssues(): Promise<Issue[]> {
    const state = this.tracker.active_states[0] ?? 'open';
    const labelsParam = this.tracker.required_labels.join(',');
    const url = new URL(`/repos/${this.tracker.owner}/${this.tracker.repo}/issues`, this.tracker.api_base_url);
    url.searchParams.set('state', state);
    url.searchParams.set('labels', labelsParam);
    url.searchParams.set('per_page', String(this.tracker.page_size));

    const raw = await this.fetchAllPages<GithubIssuePayload>(url.toString());
    const issues = raw
      .filter((p) => p.pull_request !== undefined)
      .map((p) => normalizeGithubIssuePayload(this.tracker.owner, this.tracker.repo, this.tracker, p));

    const eligible = await this.filterEligibleIssues(issues);
    await this.enrichReadyForAgentLabeledAt(eligible);
    return this.sortIssues(eligible);
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    const issues: Issue[] = [];
    for (const state of stateNames) {
      const url = new URL(`/repos/${this.tracker.owner}/${this.tracker.repo}/issues`, this.tracker.api_base_url);
      url.searchParams.set('state', state);
      url.searchParams.set('per_page', String(this.tracker.page_size));
      const raw = await this.fetchAllPages<GithubIssuePayload>(url.toString());
      for (const p of raw) {
        if (!this.tracker.include_pull_requests && p.pull_request !== undefined) continue;
        issues.push(normalizeGithubIssuePayload(this.tracker.owner, this.tracker.repo, this.tracker, p));
      }
    }
    return issues;
  }

  async fetchIssueStatesByIds(issueIds: string[]): Promise<Map<string, string>> {
    const target = new Set(issueIds);
    const byId = new Map<string, string>();
    for (const id of issueIds) byId.set(id, 'unknown');

    const states = [...new Set([...this.tracker.active_states, ...this.tracker.terminal_states])];
    const issues = await this.fetchIssuesByStates(states);
    for (const issue of issues) {
      if (target.has(issue.id)) byId.set(issue.id, issue.state);
    }

    return byId;
  }

  async fetchIssueByNumber(number: number): Promise<Issue | null> {
    const payload = await this.fetchIssueByNumberInRepo(this.tracker.owner, this.tracker.repo, number);
    if (!payload) return null;
    if (!this.tracker.include_pull_requests && payload.pull_request !== undefined) return null;
    return normalizeGithubIssuePayload(this.tracker.owner, this.tracker.repo, this.tracker, payload);
  }

  async listSubIssues(number: number): Promise<Issue[]> {
    const url = new URL(`/repos/${this.tracker.owner}/${this.tracker.repo}/issues/${number}/sub_issues`, this.tracker.api_base_url);
    url.searchParams.set('per_page', String(this.tracker.page_size));
    const raw = await this.fetchAllPages<GithubIssuePayload>(url.toString());
    return raw
      .filter((p) => (this.tracker.include_pull_requests ? true : p.pull_request === undefined))
      .map((p) => normalizeGithubIssuePayload(this.tracker.owner, this.tracker.repo, this.tracker, p));
  }

  async getParentIssue(number: number): Promise<Issue | null> {
    const url = new URL(`/repos/${this.tracker.owner}/${this.tracker.repo}/issues/${number}/parent`, this.tracker.api_base_url);
    const { data } = await this.fetchJson(url.toString(), { allowNotFound: true });
    if (data === null) return null;
    if (!data || typeof data !== 'object') throw new SymphonyRuntimeError('Expected GitHub parent issue response to be an object');
    const payload = data as GithubIssuePayload;
    if (!this.tracker.include_pull_requests && payload.pull_request !== undefined) return null;
    return normalizeGithubIssuePayload(this.tracker.owner, this.tracker.repo, this.tracker, payload);
  }

  async buildEpicTree(issue: Issue, maxDepth: number): Promise<EpicTreeNode> {
    const visit = async (nodeIssue: Issue, depth: number, seen: Set<string>): Promise<EpicTreeNode> => {
      if (depth >= maxDepth || !nodeIssue.number) return { issue: nodeIssue, children: [] };
      if (seen.has(nodeIssue.identifier)) return { issue: nodeIssue, children: [] };
      const nextSeen = new Set(seen);
      nextSeen.add(nodeIssue.identifier);

      const children = await this.listSubIssues(nodeIssue.number);
      const childNodes = await Promise.all(children.map((child) => visit(child, depth + 1, nextSeen)));
      return { issue: nodeIssue, children: childNodes };
    };

    return visit(issue, 0, new Set());
  }

  async listIssueComments(number: number): Promise<IssueComment[]> {
    const url = new URL(`/repos/${this.tracker.owner}/${this.tracker.repo}/issues/${number}/comments`, this.tracker.api_base_url);
    url.searchParams.set('per_page', String(this.tracker.page_size));
    const raw = await this.fetchAllPages(url.toString());
    return raw.map((p) => normalizeGithubCommentPayload(p as GithubCommentPayload));
  }

  async listPullRequestReviewComments(number: number): Promise<IssueComment[]> {
    const url = new URL(`/repos/${this.tracker.owner}/${this.tracker.repo}/pulls/${number}/comments`, this.tracker.api_base_url);
    url.searchParams.set('per_page', String(this.tracker.page_size));
    const raw = await this.fetchAllPages(url.toString());
    return raw.map((p) => normalizeGithubCommentPayload(p as GithubCommentPayload));
  }

  async listOpenPullRequests(): Promise<PullRequestRef[]> {
    const url = new URL(`/repos/${this.tracker.owner}/${this.tracker.repo}/pulls`, this.tracker.api_base_url);
    url.searchParams.set('state', 'open');
    url.searchParams.set('per_page', String(this.tracker.page_size));
    const raw = await this.fetchAllPages(url.toString());
    return raw.map((p) => normalizePullRequestPayload(p as GithubPullRequestPayload)).filter((p): p is PullRequestRef => p !== null);
  }

  async fetchPullRequest(number: number): Promise<PullRequestRef | null> {
    const url = new URL(`/repos/${this.tracker.owner}/${this.tracker.repo}/pulls/${number}`, this.tracker.api_base_url);
    const { data } = await this.fetchJson(url.toString(), { allowNotFound: true });
    if (data === null) return null;
    if (!data || typeof data !== 'object') throw new SymphonyRuntimeError('Expected GitHub pull request response to be an object');
    return normalizePullRequestPayload(data as GithubPullRequestPayload);
  }

  async listLabels(): Promise<RepositoryLabel[]> {
    const url = new URL(`/repos/${this.tracker.owner}/${this.tracker.repo}/labels`, this.tracker.api_base_url);
    url.searchParams.set('per_page', String(this.tracker.page_size));
    const raw = await this.fetchAllPages(url.toString());
    return raw
      .map((p) => {
        const label = p as { name?: unknown };
        return { name: typeof label.name === 'string' ? label.name.trim().toLowerCase() : '' };
      })
      .filter((label) => label.name.length > 0);
  }

  async createIssueComment(number: number, body: string): Promise<IssueComment> {
    const url = new URL(`/repos/${this.tracker.owner}/${this.tracker.repo}/issues/${number}/comments`, this.tracker.api_base_url);
    const { data } = await this.fetchJson(url.toString(), {
      method: 'POST',
      body: { body },
    });
    if (!data || typeof data !== 'object') throw new SymphonyRuntimeError('Expected GitHub comment response to be an object');
    return normalizeGithubCommentPayload(data as GithubCommentPayload);
  }

  async updateIssueComment(commentId: number, body: string): Promise<IssueComment> {
    const url = new URL(`/repos/${this.tracker.owner}/${this.tracker.repo}/issues/comments/${commentId}`, this.tracker.api_base_url);
    const { data } = await this.fetchJson(url.toString(), {
      method: 'PATCH',
      body: { body },
    });
    if (!data || typeof data !== 'object') throw new SymphonyRuntimeError('Expected GitHub comment response to be an object');
    return normalizeGithubCommentPayload(data as GithubCommentPayload);
  }

  async upsertStatusComment(number: number, marker: string, body: string, knownCommentId: number | null = null): Promise<StatusCommentResult> {
    if (knownCommentId) {
      try {
        const updated = await this.updateIssueComment(knownCommentId, body);
        return { id: updated.id, created: false };
      } catch {
        // Fall back to marker search. The comment may have been deleted.
      }
    }

    const comments = await this.listIssueComments(number);
    const existing = comments.find((c) => c.body.includes(marker));
    if (existing) {
      const updated = await this.updateIssueComment(existing.id, body);
      return { id: updated.id, created: false };
    }

    const created = await this.createIssueComment(number, body);
    return { id: created.id, created: true };
  }

  async addLabels(number: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return;
    const url = new URL(`/repos/${this.tracker.owner}/${this.tracker.repo}/issues/${number}/labels`, this.tracker.api_base_url);
    await this.fetchJson(url.toString(), {
      method: 'POST',
      body: { labels },
    });
  }

  async removeLabel(number: number, label: string): Promise<void> {
    const encodedLabel = encodeURIComponent(label);
    const url = new URL(`/repos/${this.tracker.owner}/${this.tracker.repo}/issues/${number}/labels/${encodedLabel}`, this.tracker.api_base_url);
    await this.fetchJson(url.toString(), {
      method: 'DELETE',
      allowNotFound: true,
      allowNoContent: true,
    });
  }

  async transitionLabels(number: number, opts: { add?: string[]; remove?: string[] }): Promise<void> {
    await this.addLabels(number, opts.add ?? []);
    for (const label of opts.remove ?? []) {
      await this.removeLabel(number, label);
    }
  }

  async isIssueClosed(owner: string, repo: string, number: number): Promise<boolean | null> {
    const payload = await this.fetchIssueByNumberInRepo(owner, repo, number);
    if (!payload) return null;
    return payload.state === 'closed';
  }

  private async filterEligibleIssues(issues: Issue[]): Promise<Issue[]> {
    const required = new Set(this.tracker.required_labels);
    const ignored = new Set(this.tracker.ignored_labels);
    const anyRequired = this.tracker.any_required_labels ? new Set(this.tracker.any_required_labels.map((l) => l.trim().toLowerCase())) : null;

    const filtered: Issue[] = [];
    for (const issue of issues) {
      const labels = new Set(issue.labels);
      let hasAllRequired = true;
      for (const r of required) {
        if (!labels.has(r)) {
          hasAllRequired = false;
          break;
        }
      }
      if (!hasAllRequired) continue;

      if (anyRequired) {
        let hasAny = false;
        for (const r of anyRequired) {
          if (labels.has(r)) {
            hasAny = true;
            break;
          }
        }
        if (!hasAny) continue;
      }

      let hasIgnored = false;
      for (const i of ignored) {
        if (labels.has(i)) {
          hasIgnored = true;
          break;
        }
      }
      if (hasIgnored) continue;

      if (!this.tracker.active_states.includes(issue.state)) continue;
      if (this.tracker.terminal_states.includes(issue.state)) continue;

      const blockersOk = await this.areBlockersResolved(issue);
      if (!blockersOk) continue;

      filtered.push(issue);
    }
    return filtered;
  }

  private async areBlockersResolved(issue: Issue): Promise<boolean> {
    if (issue.blocked_by.length === 0) return true;

    for (const blocker of issue.blocked_by) {
      const ref = blocker.identifier;
      if (!ref) return false;
      const matchSameRepo = /^[^/]+\/[^/]+#(\d+)$/.exec(ref);
      if (!matchSameRepo) return false;

      const num = Number(matchSameRepo[1]);
      const ownerRepo = ref.split('#')[0];
      const [owner, repo] = ownerRepo.split('/');
      const closed = await this.isIssueClosed(owner, repo, num);
      blocker.state = closed === null ? null : closed ? 'closed' : 'open';
      if (closed !== true) return false;
    }

    return true;
  }

  private async enrichReadyForAgentLabeledAt(issues: Issue[]): Promise<void> {
    if (this.tracker.candidate_order !== 'ready_for_agent_labeled_at') return;
    const unresolved = new Map<number, Issue>();
    for (const issue of issues) {
      const cached = this.readyForAgentLabeledAtCache.get(issue.id);
      if (cached && cached.updated_at === issue.updated_at) {
        issue.ready_for_agent_labeled_at = cached.ready_for_agent_labeled_at;
        continue;
      }
      issue.ready_for_agent_labeled_at = null;
      if (issue.number) unresolved.set(issue.number, issue);
    }

    if (unresolved.size === 0) return;

    const url = new URL(`/repos/${this.tracker.owner}/${this.tracker.repo}/issues/events`, this.tracker.api_base_url);
    url.searchParams.set('per_page', '100');

    await this.forEachPage<GithubIssueEventPayload>(url.toString(), async (page) => {
      for (const event of page) {
        const labelName = event.label ? normalizeLabelName(event.label) : null;
        if (labelName !== 'ready-for-agent') continue;

        const issueNumber = event.issue?.number;
        if (typeof issueNumber !== 'number') continue;

        const issue = unresolved.get(issueNumber);
        if (!issue) continue;

        issue.ready_for_agent_labeled_at = event.event === 'labeled' ? (event.created_at ?? null) : null;
        this.readyForAgentLabeledAtCache.set(issue.id, {
          updated_at: issue.updated_at,
          ready_for_agent_labeled_at: issue.ready_for_agent_labeled_at,
        });
        unresolved.delete(issueNumber);
      }

      return unresolved.size > 0;
    });

    for (const issue of unresolved.values()) {
      this.readyForAgentLabeledAtCache.set(issue.id, {
        updated_at: issue.updated_at,
        ready_for_agent_labeled_at: null,
      });
      if (issue.labels.includes('ready-for-agent')) {
        log('warn', 'ready_for_agent_label_timestamp_missing', {
          event: 'ready_for_agent_label_timestamp_missing',
          issue_identifier: issue.identifier,
          issue_number: issue.number,
        });
      }
    }
  }

  private compareByPriorityThenCreatedAt(a: Issue, b: Issue): number {
    const pa = a.priority ?? Number.POSITIVE_INFINITY;
    const pb = b.priority ?? Number.POSITIVE_INFINITY;
    if (pa !== pb) return pa - pb;
    const ca = a.created_at ?? '';
    const cb = b.created_at ?? '';
    if (ca !== cb) return ca.localeCompare(cb);
    const na = a.number ?? Number.POSITIVE_INFINITY;
    const nb = b.number ?? Number.POSITIVE_INFINITY;
    return na - nb;
  }

  private compareByCreatedAt(a: Issue, b: Issue): number {
    const ca = a.created_at ?? '';
    const cb = b.created_at ?? '';
    if (ca !== cb) return ca.localeCompare(cb);
    const na = a.number ?? Number.POSITIVE_INFINITY;
    const nb = b.number ?? Number.POSITIVE_INFINITY;
    return na - nb;
  }

  private sortIssues(issues: Issue[]): Issue[] {
    return [...issues].sort((a, b) => {
      if (this.tracker.candidate_order === 'ready_for_agent_labeled_at') {
        const ta = a.ready_for_agent_labeled_at;
        const tb = b.ready_for_agent_labeled_at;
        if (ta && tb && ta !== tb) return ta.localeCompare(tb);
        if (ta && !tb) return -1;
        if (!ta && tb) return 1;
        return this.compareByCreatedAt(a, b);
      }
      return this.compareByPriorityThenCreatedAt(a, b);
    });
  }

  private async fetchAllPages<T>(urlString: string): Promise<T[]> {
    const out: T[] = [];
    let nextUrl: string | null = urlString;

    while (nextUrl) {
      const { data, link } = await this.fetchJson(nextUrl);
      if (!Array.isArray(data)) throw new SymphonyRuntimeError('Expected GitHub list response to be an array');
      out.push(...(data as T[]));
      const links = parseLinkHeader(link);
      nextUrl = links.get('next') ?? null;
    }

    return out;
  }

  private async forEachPage<T>(urlString: string, visitor: (page: T[]) => Promise<boolean> | boolean): Promise<void> {
    let nextUrl: string | null = urlString;
    while (nextUrl) {
      const { data, link } = await this.fetchJson(nextUrl);
      if (!Array.isArray(data)) throw new SymphonyRuntimeError('Expected GitHub list response to be an array');
      const shouldContinue = await visitor(data as T[]);
      if (!shouldContinue) return;
      const links = parseLinkHeader(link);
      nextUrl = links.get('next') ?? null;
    }
  }

  private async fetchIssueByNumberInRepo(owner: string, repo: string, number: number): Promise<GithubIssuePayload | null> {
    const url = new URL(`/repos/${owner}/${repo}/issues/${number}`, this.tracker.api_base_url);
    const { data } = await this.fetchJson(url.toString(), { allowNotFound: true });
    if (data === null) return null;
    if (!data || typeof data !== 'object') throw new SymphonyRuntimeError('Expected GitHub issue response to be an object');
    return data as GithubIssuePayload;
  }

  private async fetchJson(
    url: string,
    opts: { allowNotFound?: boolean; allowNoContent?: boolean; method?: string; body?: unknown } = {},
  ): Promise<{ data: unknown; link: string | null }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.tracker.request_timeout_ms);

    try {
      const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'symphony-mvp',
      };
      let body: string | undefined;
      if (opts.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(opts.body);
      }
      if (this.tracker.token) headers.Authorization = `Bearer ${this.tracker.token}`;

      const res = await fetch(url, { headers, signal: controller.signal, method: opts.method ?? 'GET', body });
      if (opts.allowNotFound && res.status === 404) return { data: null, link: null };
      if (opts.allowNoContent && res.status === 204) return { data: null, link: null };
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        throw new SymphonyRuntimeError(`GitHub request failed ${res.status} ${res.statusText}: ${bodyText.slice(0, 300)}`);
      }
      const link = res.headers.get('link');
      if (res.status === 204) return { data: null, link };
      const text = await res.text();
      const data = text ? (JSON.parse(text) as unknown) : null;
      return { data, link };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new SymphonyRuntimeError(`GitHub request timed out after ${this.tracker.request_timeout_ms}ms: ${url}`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function normalizeGithubCommentPayload(payload: GithubCommentPayload): IssueComment {
  const id = payload.id;
  if (typeof id !== 'number') throw new SymphonyRuntimeError('GitHub comment payload missing id');
  return {
    id,
    body: payload.body ?? '',
    url: payload.html_url ?? null,
    author: payload.user?.login ?? null,
    created_at: payload.created_at ?? null,
    updated_at: payload.updated_at ?? null,
  };
}
