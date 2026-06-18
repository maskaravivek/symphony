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
      is_draft: false,
      url: 'https://github.test/pr/353',
      head_ref: 'codex-339-migrate-frontend',
      base_ref: 'main',
      merge_state_status: 'dirty',
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
