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
