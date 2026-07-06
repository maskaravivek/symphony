import assert from 'node:assert/strict';
import test from 'node:test';

import { GithubIssueTrackerClient } from './githubClient.js';
import type { GithubTrackerConfig } from '../workflow/types.js';

function trackerConfig(): GithubTrackerConfig {
  return {
    kind: 'github',
    owner: 'mangoappstudio',
    repo: 'mdedit',
    token: 'test-token',
    api_base_url: 'https://api.github.test',
    graphql_url: 'https://api.github.test/graphql',
    candidate_order: 'priority_then_created_at',
    active_states: ['open'],
    terminal_states: ['closed'],
    required_labels: ['ready-for-agent'],
    any_required_labels: null,
    ignored_labels: ['blocked'],
    priority_labels: null,
    branch_prefix: 'codex',
    include_pull_requests: false,
    epics: {
      enabled: false,
      relationship_source: 'native_subissues',
      auto_label_children: true,
      parent_mode: 'coordinator_only',
      execution_mode: 'independent',
      max_depth: 8,
    },
    page_size: 50,
    request_timeout_ms: 5_000,
  };
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function issuePayload(
  number: number,
  createdAt: string,
  labels: string[] = ['ready-for-agent'],
  extra: Partial<{ updated_at: string; pull_request: unknown; title: string }> = {},
) {
  return {
    id: number,
    node_id: `I_${number}`,
    number,
    title: extra.title ?? `Issue ${number}`,
    state: 'open',
    labels: labels.map((name) => ({ name })),
    html_url: `https://github.test/mangoappstudio/mdedit/issues/${number}`,
    repository_url: 'https://api.github.test/repos/mangoappstudio/mdedit',
    created_at: createdAt,
    updated_at: extra.updated_at ?? createdAt,
    ...(extra.pull_request !== undefined ? { pull_request: extra.pull_request } : {}),
  };
}

test('derives flat branch names from issues', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    jsonResponse({
      id: 42,
      node_id: 'I_issue',
      number: 42,
      title: 'Build a shared AST analysis core in Markdown parser',
      state: 'open',
      labels: [{ name: 'ready-for-agent' }],
      html_url: 'https://github.test/mangoappstudio/mdedit/issues/42',
      repository_url: 'https://api.github.test/repos/mangoappstudio/mdedit',
    });

  let issue;
  try {
    const client = new GithubIssueTrackerClient(trackerConfig());
    issue = await client.fetchIssueByNumber(42);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(issue?.branch_name, 'codex-42-build-a-shared-ast-analysis-core-in-markdown-par');
  assert.equal(issue?.branch_name?.includes('/'), false);
});

test('derives flat branch names with empty or nested prefixes', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    jsonResponse({
      id: 43,
      node_id: 'I_issue_nested',
      number: 43,
      title: 'Fix push refs',
      state: 'open',
      labels: [{ name: 'ready-for-agent' }],
      html_url: 'https://github.test/mangoappstudio/mdedit/issues/43',
      repository_url: 'https://api.github.test/repos/mangoappstudio/mdedit',
    });

  try {
    const nestedClient = new GithubIssueTrackerClient({ ...trackerConfig(), branch_prefix: 'symphony/agent' });
    const nestedIssue = await nestedClient.fetchIssueByNumber(43);
    assert.equal(nestedIssue?.branch_name, 'symphony-agent-43-fix-push-refs');

    const unprefixedClient = new GithubIssueTrackerClient({ ...trackerConfig(), branch_prefix: '' });
    const unprefixedIssue = await unprefixedClient.fetchIssueByNumber(43);
    assert.equal(unprefixedIssue?.branch_name, '43-fix-push-refs');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('writes GitHub labels through REST endpoints', async () => {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    return jsonResponse([]);
  };

  try {
    const client = new GithubIssueTrackerClient(trackerConfig());
    await client.transitionLabels(42, { add: ['agent-running'], remove: ['ready-for-agent'] });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(calls, [
    {
      url: 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42/labels',
      method: 'POST',
      body: { labels: ['agent-running'] },
    },
    {
      url: 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42/labels/ready-for-agent',
      method: 'DELETE',
      body: null,
    },
  ]);
});

test('creates sticky status comment when marker is missing', async () => {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (!init?.method || init.method === 'GET') return jsonResponse([]);
    return jsonResponse({ id: 10, body: String(calls.at(-1)?.body ?? ''), html_url: 'https://github.test/comment/10' });
  };

  let result;
  try {
    const client = new GithubIssueTrackerClient(trackerConfig());
    result = await client.upsertStatusComment(42, '<!-- symphony-status:mangoappstudio/mdedit#42 -->', 'status body');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(result, { id: 10, created: true });
  assert.equal(calls[0]?.method, 'GET');
  assert.equal(calls[1]?.method, 'POST');
  assert.deepEqual(calls[1]?.body, { body: 'status body' });
});

test('updates sticky status comment when marker exists', async () => {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (!init?.method || init.method === 'GET') {
      return jsonResponse([{ id: 11, body: '<!-- symphony-status:mangoappstudio/mdedit#42 -->\nold' }]);
    }
    return jsonResponse({ id: 11, body: 'new body' });
  };

  let result;
  try {
    const client = new GithubIssueTrackerClient(trackerConfig());
    result = await client.upsertStatusComment(42, '<!-- symphony-status:mangoappstudio/mdedit#42 -->', 'new body');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(result, { id: 11, created: false });
  assert.equal(calls[1]?.url, 'https://api.github.test/repos/mangoappstudio/mdedit/issues/comments/11');
  assert.equal(calls[1]?.method, 'PATCH');
  assert.deepEqual(calls[1]?.body, { body: 'new body' });
});

test('lists open pull requests with merge state fields', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    assert.equal(String(input), 'https://api.github.test/repos/mangoappstudio/mdedit/pulls?state=open&per_page=50');
    return jsonResponse([
      {
        number: 353,
        title: 'Migrate frontend',
        body: 'Fixes #339',
        state: 'open',
        draft: false,
        html_url: 'https://github.test/pr/353',
        head: { ref: 'codex-339-migrate-frontend' },
        base: { ref: 'main' },
        mergeable_state: 'dirty',
      },
    ]);
  };

  let prs;
  try {
    const client = new GithubIssueTrackerClient(trackerConfig());
    prs = await client.listOpenPullRequests();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(prs, [
    {
      number: 353,
      title: 'Migrate frontend',
      body: 'Fixes #339',
      state: 'open',
      labels: [],
      is_draft: false,
      url: 'https://github.test/pr/353',
      head_ref: 'codex-339-migrate-frontend',
      base_ref: 'main',
      merge_state_status: 'dirty',
    },
  ]);
});

test('fetches labeled pull requests as agent candidates', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    assert.equal(String(input), 'https://api.github.test/repos/mangoappstudio/mdedit/issues?state=open&labels=ready-for-agent&per_page=50');
    return jsonResponse([
      {
        id: 77,
        node_id: 'PR_77',
        number: 77,
        title: 'Review follow-up',
        state: 'open',
        labels: [{ name: 'ready-for-agent' }],
        html_url: 'https://github.test/mangoappstudio/mdedit/pull/77',
        repository_url: 'https://api.github.test/repos/mangoappstudio/mdedit',
        pull_request: {},
      },
      {
        id: 78,
        node_id: 'I_78',
        number: 78,
        title: 'Plain issue',
        state: 'open',
        labels: [{ name: 'ready-for-agent' }],
        html_url: 'https://github.test/mangoappstudio/mdedit/issues/78',
        repository_url: 'https://api.github.test/repos/mangoappstudio/mdedit',
      },
    ]);
  };

  let candidates;
  try {
    const client = new GithubIssueTrackerClient(trackerConfig());
    candidates = await client.fetchCandidatePullRequestIssues();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(
    candidates.map((issue) => issue.identifier),
    ['mangoappstudio/mdedit#77'],
  );
});

test('defaults candidate ordering to priority then created_at', async () => {
  const client = new GithubIssueTrackerClient(trackerConfig());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    assert.equal(String(input), 'https://api.github.test/repos/mangoappstudio/mdedit/issues?state=open&labels=ready-for-agent&per_page=50');
    return jsonResponse([
      issuePayload(2, '2026-07-05T12:05:00Z'),
      issuePayload(1, '2026-07-05T12:00:00Z'),
    ]);
  };

  try {
    const issues = await client.fetchCandidateIssues();
    assert.deepEqual(
      issues.map((issue) => ({ number: issue.number, ready_for_agent_labeled_at: issue.ready_for_agent_labeled_at })),
      [
        { number: 1, ready_for_agent_labeled_at: null },
        { number: 2, ready_for_agent_labeled_at: null },
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('orders candidates by ready-for-agent label application time when enabled', async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues?state=open&labels=ready-for-agent&per_page=50') {
      return jsonResponse([
        issuePayload(10, '2026-07-05T12:10:00Z', ['ready-for-agent', 'priority:p0'], { updated_at: '2026-07-05T12:12:00Z' }),
        issuePayload(11, '2026-07-05T12:00:00Z', ['ready-for-agent', 'priority:p3'], { updated_at: '2026-07-05T12:11:00Z' }),
      ]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/events?per_page=100') {
      return jsonResponse([
        { event: 'labeled', created_at: '2026-07-05T12:09:00Z', label: { name: 'ready-for-agent' }, issue: { number: 10 } },
        { event: 'labeled', created_at: '2026-07-05T12:01:00Z', label: { name: 'ready-for-agent' }, issue: { number: 11 } },
      ]);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const client = new GithubIssueTrackerClient({
      ...trackerConfig(),
      candidate_order: 'ready_for_agent_labeled_at',
      priority_labels: { 'priority:p0': 1, 'priority:p3': 4 },
    });
    const issues = await client.fetchCandidateIssues();
    assert.deepEqual(
      issues.map((issue) => ({ number: issue.number, ready_for_agent_labeled_at: issue.ready_for_agent_labeled_at })),
      [
        { number: 11, ready_for_agent_labeled_at: '2026-07-05T12:01:00Z' },
        { number: 10, ready_for_agent_labeled_at: '2026-07-05T12:09:00Z' },
      ],
    );
    assert.deepEqual(calls, [
      'https://api.github.test/repos/mangoappstudio/mdedit/issues?state=open&labels=ready-for-agent&per_page=50',
      'https://api.github.test/repos/mangoappstudio/mdedit/issues/events?per_page=100',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('uses the latest active ready-for-agent label timestamp after re-labeling', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues?state=open&labels=ready-for-agent&per_page=50') {
      return jsonResponse([issuePayload(10, '2026-07-05T12:00:00Z', ['ready-for-agent'], { updated_at: '2026-07-05T12:20:00Z' })]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/events?per_page=100') {
      return jsonResponse([
        { event: 'labeled', created_at: '2026-07-05T12:10:00Z', label: { name: 'ready-for-agent' }, issue: { number: 10 } },
        { event: 'unlabeled', created_at: '2026-07-05T12:05:00Z', label: { name: 'ready-for-agent' }, issue: { number: 10 } },
        { event: 'labeled', created_at: '2026-07-05T12:01:00Z', label: { name: 'ready-for-agent' }, issue: { number: 10 } },
      ]);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const client = new GithubIssueTrackerClient({ ...trackerConfig(), candidate_order: 'ready_for_agent_labeled_at' });
    const [issue] = await client.fetchCandidateIssues();
    assert.equal(issue?.ready_for_agent_labeled_at, '2026-07-05T12:10:00Z');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('falls back to deterministic ordering when a ready-for-agent timestamp cannot be derived', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues?state=open&labels=ready-for-agent&per_page=50') {
      return jsonResponse([
        issuePayload(20, '2026-07-05T12:05:00Z', ['ready-for-agent', 'priority:p0'], { updated_at: '2026-07-05T12:12:00Z' }),
        issuePayload(21, '2026-07-05T12:00:00Z', ['ready-for-agent', 'priority:p3'], { updated_at: '2026-07-05T12:10:00Z' }),
      ]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/events?per_page=100') {
      return jsonResponse([{ event: 'labeled', created_at: '2026-07-05T12:06:00Z', label: { name: 'ready-for-agent' }, issue: { number: 21 } }]);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const client = new GithubIssueTrackerClient({ ...trackerConfig(), candidate_order: 'ready_for_agent_labeled_at' });
    const issues = await client.fetchCandidateIssues();
    assert.deepEqual(
      issues.map((issue) => issue.number),
      [21, 20],
    );
    assert.equal(issues[0]?.ready_for_agent_labeled_at, '2026-07-05T12:06:00Z');
    assert.equal(issues[1]?.ready_for_agent_labeled_at, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('reuses cached ready-for-agent timestamps until issue updated_at changes', async () => {
  const originalFetch = globalThis.fetch;
  let candidateFetchCount = 0;
  let eventFetchCount = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues?state=open&labels=ready-for-agent&per_page=50') {
      candidateFetchCount += 1;
      const updatedAt = candidateFetchCount < 3 ? '2026-07-05T12:10:00Z' : '2026-07-05T12:15:00Z';
      return jsonResponse([issuePayload(30, '2026-07-05T12:00:00Z', ['ready-for-agent'], { updated_at: updatedAt })]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/events?per_page=100') {
      eventFetchCount += 1;
      const timestamp = eventFetchCount === 1 ? '2026-07-05T12:01:00Z' : '2026-07-05T12:02:00Z';
      return jsonResponse([{ event: 'labeled', created_at: timestamp, label: { name: 'ready-for-agent' }, issue: { number: 30 } }]);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const client = new GithubIssueTrackerClient({ ...trackerConfig(), candidate_order: 'ready_for_agent_labeled_at' });
    const first = await client.fetchCandidateIssues();
    const second = await client.fetchCandidateIssues();
    const third = await client.fetchCandidateIssues();

    assert.equal(first[0]?.ready_for_agent_labeled_at, '2026-07-05T12:01:00Z');
    assert.equal(second[0]?.ready_for_agent_labeled_at, '2026-07-05T12:01:00Z');
    assert.equal(third[0]?.ready_for_agent_labeled_at, '2026-07-05T12:02:00Z');
    assert.equal(eventFetchCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('applies ready-for-agent ordering to pull request candidates too', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues?state=open&labels=ready-for-agent&per_page=50') {
      return jsonResponse([
        issuePayload(77, '2026-07-05T12:05:00Z', ['ready-for-agent'], {
          updated_at: '2026-07-05T12:11:00Z',
          pull_request: {},
          title: 'Later queued PR',
        }),
        issuePayload(78, '2026-07-05T12:00:00Z', ['ready-for-agent'], {
          updated_at: '2026-07-05T12:12:00Z',
          pull_request: {},
          title: 'Earlier queued PR',
        }),
      ]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/events?per_page=100') {
      return jsonResponse([
        { event: 'labeled', created_at: '2026-07-05T12:04:00Z', label: { name: 'ready-for-agent' }, issue: { number: 77 } },
        { event: 'labeled', created_at: '2026-07-05T12:01:00Z', label: { name: 'ready-for-agent' }, issue: { number: 78 } },
      ]);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const client = new GithubIssueTrackerClient({ ...trackerConfig(), include_pull_requests: true, candidate_order: 'ready_for_agent_labeled_at' });
    const issues = await client.fetchCandidatePullRequestIssues();
    assert.deepEqual(issues.map((issue) => issue.number), [78, 77]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('scans repo issue events across pages until all unresolved candidates are resolved', async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues?state=open&labels=ready-for-agent&per_page=50') {
      return jsonResponse([
        issuePayload(40, '2026-07-05T12:00:00Z', ['ready-for-agent'], { updated_at: '2026-07-05T12:20:00Z' }),
        issuePayload(41, '2026-07-05T12:01:00Z', ['ready-for-agent'], { updated_at: '2026-07-05T12:21:00Z' }),
      ]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/events?per_page=100') {
      return jsonResponse(
        [{ event: 'labeled', created_at: '2026-07-05T12:10:00Z', label: { name: 'ready-for-agent' }, issue: { number: 40 } }],
        { headers: { link: '<https://api.github.test/repos/mangoappstudio/mdedit/issues/events?per_page=100&page=2>; rel="next"' } },
      );
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/events?per_page=100&page=2') {
      return jsonResponse([{ event: 'labeled', created_at: '2026-07-05T12:11:00Z', label: { name: 'ready-for-agent' }, issue: { number: 41 } }]);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const client = new GithubIssueTrackerClient({ ...trackerConfig(), candidate_order: 'ready_for_agent_labeled_at' });
    const issues = await client.fetchCandidateIssues();
    assert.deepEqual(
      issues.map((issue) => ({ number: issue.number, ready_for_agent_labeled_at: issue.ready_for_agent_labeled_at })),
      [
        { number: 40, ready_for_agent_labeled_at: '2026-07-05T12:10:00Z' },
        { number: 41, ready_for_agent_labeled_at: '2026-07-05T12:11:00Z' },
      ],
    );
    assert.deepEqual(calls, [
      'https://api.github.test/repos/mangoappstudio/mdedit/issues?state=open&labels=ready-for-agent&per_page=50',
      'https://api.github.test/repos/mangoappstudio/mdedit/issues/events?per_page=100',
      'https://api.github.test/repos/mangoappstudio/mdedit/issues/events?per_page=100&page=2',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('lists pull request review comments', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    assert.equal(String(input), 'https://api.github.test/repos/mangoappstudio/mdedit/pulls/77/comments?per_page=50');
    return jsonResponse([
      {
        id: 901,
        body: 'Please cover the retry path.',
        html_url: 'https://github.test/comment/901',
        created_at: '2026-07-05T12:00:00Z',
        updated_at: '2026-07-05T12:00:00Z',
        user: { login: 'reviewer' },
      },
    ]);
  };

  let comments;
  try {
    const client = new GithubIssueTrackerClient(trackerConfig());
    comments = await client.listPullRequestReviewComments(77);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(comments, [
    {
      id: 901,
      body: 'Please cover the retry path.',
      url: 'https://github.test/comment/901',
      author: 'reviewer',
      created_at: '2026-07-05T12:00:00Z',
      updated_at: '2026-07-05T12:00:00Z',
    },
  ]);
});

test('lists native sub-issues through paginated REST endpoint', async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    if (calls.length === 1) {
      return jsonResponse(
        [
          {
            id: 100,
            node_id: 'I_child_1',
            number: 43,
            title: 'Child one',
            state: 'open',
            labels: [{ name: 'enhancement' }],
            html_url: 'https://github.test/mangoappstudio/mdedit/issues/43',
          },
        ],
        { headers: { link: '<https://api.github.test/page2>; rel="next"', 'content-type': 'application/json' } },
      );
    }
    return jsonResponse([
      {
        id: 101,
        node_id: 'I_child_2',
        number: 44,
        title: 'Child two',
        state: 'closed',
        labels: [],
        html_url: 'https://github.test/mangoappstudio/mdedit/issues/44',
      },
    ]);
  };

  let issues;
  try {
    const client = new GithubIssueTrackerClient(trackerConfig());
    issues = await client.listSubIssues(42);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls[0], 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42/sub_issues?per_page=50');
  assert.equal(calls[1], 'https://api.github.test/page2');
  assert.deepEqual(
    issues.map((issue) => ({ identifier: issue.identifier, state: issue.state, labels: issue.labels })),
    [
      { identifier: 'mangoappstudio/mdedit#43', state: 'open', labels: ['enhancement'] },
      { identifier: 'mangoappstudio/mdedit#44', state: 'closed', labels: [] },
    ],
  );
});

test('gets parent issue through REST endpoint', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    jsonResponse({
      id: 99,
      node_id: 'I_parent',
      number: 42,
      title: 'Parent epic',
      state: 'open',
      labels: [{ name: 'ready-for-agent' }],
      html_url: 'https://github.test/mangoappstudio/mdedit/issues/42',
    });

  let parent;
  try {
    const client = new GithubIssueTrackerClient(trackerConfig());
    parent = await client.getParentIssue(43);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(parent?.identifier, 'mangoappstudio/mdedit#42');
  assert.deepEqual(parent?.labels, ['ready-for-agent']);
});
