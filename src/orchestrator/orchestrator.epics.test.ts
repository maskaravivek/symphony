import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readEpicStates } from '../status/epicState.js';
import { Orchestrator } from './orchestrator.js';

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function issuePayload(
  number: number,
  title: string,
  state: string,
  labels: string[] = [],
  options: { openDependencies?: number } = {},
) {
  return {
    id: number,
    node_id: `I_${number}`,
    number,
    title,
    state,
    labels: labels.map((name) => ({ name })),
    html_url: `https://github.test/mangoappstudio/mdedit/issues/${number}`,
    repository_url: 'https://api.github.test/repos/mangoappstudio/mdedit',
    issue_dependencies_summary: {
      blocked_by: options.openDependencies ?? 0,
      total_blocked_by: options.openDependencies ?? 0,
    },
  };
}

async function writeWorkflow(
  workspaceRoot: string,
  options: {
    executionMode?: 'independent' | 'stacked';
    command?: string;
    resumeCommand?: string;
    afterCreate?: string | null;
  } = {},
): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-epic-workflow-'));
  const workflowPath = path.join(dir, 'WORKFLOW.md');
  const executionMode = options.executionMode ?? 'independent';
  const command = options.command ?? 'echo should-not-run';
  const resumeCommand = options.resumeCommand ?? command;
  const afterCreate = options.afterCreate ? `hooks:\n  after_create: |\n${options.afterCreate.split('\n').map((line) => `    ${line}`).join('\n')}\n` : '';
  await fs.writeFile(
    workflowPath,
    `---
tracker:
  kind: github
  owner: mangoappstudio
  repo: mdedit
  token: token
  api_base_url: https://api.github.test
  active_states: [open]
  terminal_states: [closed]
  required_labels: [ready-for-agent]
  ignored_labels: [blocked, ready-for-human, wontfix]
  epics:
    enabled: true
    relationship_source: native_subissues
    auto_label_children: true
    parent_mode: coordinator_only
    execution_mode: ${executionMode}
    max_depth: 8
workspace:
  root: ${workspaceRoot}
${afterCreate}agents:
  default: codex
  providers:
    codex:
      command: ${command}
      resume_command: ${resumeCommand}
      handoff_command: ${command}
---

Prompt body
`,
    'utf8',
  );
  return workflowPath;
}

test('coordinates native sub-issue parent without dispatching parent workspace', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-epic-workspace-'));
  const workflowPath = await writeWorkflow(workspaceRoot);
  const calls: { url: string; method: string; body: unknown }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });

    if (url.startsWith('https://api.github.test/repos/mangoappstudio/mdedit/issues?')) {
      return jsonResponse([issuePayload(42, 'Epic parent', 'open', ['ready-for-agent'])]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/pulls?state=open&per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42/sub_issues?per_page=50') {
      return jsonResponse([issuePayload(43, 'Leaf child', 'open')]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/43/sub_issues?per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/43/labels' && method === 'POST') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42/comments?per_page=50' && method === 'GET') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42/comments' && method === 'POST') {
      return jsonResponse({ id: 500, body: String(body), html_url: 'https://github.test/comment/500' });
    }
    throw new Error(`Unexpected fetch ${method} ${url}`);
  };

  try {
    const orchestrator = new Orchestrator({ workflowPath });
    await orchestrator.tickOnce();
    await orchestrator.shutdown('test');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(calls.some((call) => call.url.endsWith('/issues/43/labels') && call.method === 'POST'));
  assert.deepEqual(calls.find((call) => call.url.endsWith('/issues/43/labels'))?.body, { labels: ['ready-for-agent'] });
  assert.equal(calls.some((call) => call.url.endsWith('/issues/42/labels') && call.method === 'POST'), false);

  const entries = await fs.readdir(workspaceRoot);
  assert.deepEqual(entries, ['.symphony']);

  const epics = await readEpicStates(workspaceRoot);
  assert.equal(epics.length, 1);
  assert.equal(epics[0]?.issue_number, 42);
  assert.equal(epics[0]?.status, 'coordinating');
  assert.equal(epics[0]?.children[0]?.queued, true);
  assert.equal(epics[0]?.status_comment_id, 500);
});

test('auto-labels dependency-blocked epic children without marking them queued', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-epic-dependency-workspace-'));
  const workflowPath = await writeWorkflow(workspaceRoot);
  const calls: { url: string; method: string; body: unknown }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });

    if (url.startsWith('https://api.github.test/repos/mangoappstudio/mdedit/issues?')) {
      return jsonResponse([issuePayload(42, 'Epic parent', 'open', ['ready-for-agent'])]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/pulls?state=open&per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42/sub_issues?per_page=50') {
      return jsonResponse([issuePayload(43, 'Dependent leaf', 'open', [], { openDependencies: 1 })]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/43/dependencies/blocked_by?per_page=50') {
      return jsonResponse([issuePayload(99, 'Blocking issue', 'open')]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/43/sub_issues?per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/43/labels' && method === 'POST') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42/comments?per_page=50' && method === 'GET') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42/comments' && method === 'POST') {
      return jsonResponse({ id: 502, body: String(body), html_url: 'https://github.test/comment/502' });
    }
    throw new Error(`Unexpected fetch ${method} ${url}`);
  };

  try {
    const orchestrator = new Orchestrator({ workflowPath });
    await orchestrator.tickOnce();
    await orchestrator.shutdown('test');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(calls.find((call) => call.url.endsWith('/issues/43/labels'))?.body, {
    labels: ['ready-for-agent'],
  });
  const epics = await readEpicStates(workspaceRoot);
  assert.equal(epics[0]?.children[0]?.queued, false);
  assert.equal(epics[0]?.children[0]?.skipped_reason, 'native_dependency');
});

test('reconciles a persisted coordinating epic when its parent is closed between polls', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-closed-epic-workspace-'));
  const workflowPath = await writeWorkflow(workspaceRoot);
  const originalFetch = globalThis.fetch;
  let parentClosed = false;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;

    if (url.startsWith('https://api.github.test/repos/mangoappstudio/mdedit/issues?')) {
      return jsonResponse(parentClosed ? [] : [issuePayload(42, 'Epic parent', 'open', ['ready-for-agent'])]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/pulls?state=open&per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42') {
      return jsonResponse(issuePayload(42, 'Epic parent', 'closed', ['ready-for-human']));
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42/sub_issues?per_page=50') {
      return jsonResponse([issuePayload(43, 'Leaf child', 'open')]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/43/sub_issues?per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/43/labels' && method === 'POST') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42/comments?per_page=50' && method === 'GET') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42/comments' && method === 'POST') {
      return jsonResponse({ id: 500, body: String(body), html_url: 'https://github.test/comment/500' });
    }
    throw new Error(`Unexpected fetch ${method} ${url}`);
  };

  try {
    const orchestrator = new Orchestrator({ workflowPath });
    await orchestrator.tickOnce();
    parentClosed = true;
    await orchestrator.tickOnce();
    await orchestrator.shutdown('test');
  } finally {
    globalThis.fetch = originalFetch;
  }

  const epics = await readEpicStates(workspaceRoot);
  assert.equal(epics[0]?.status, 'completed');
  assert.deepEqual(epics[0]?.labels, ['ready-for-human']);
});

test('parent epic label can switch execution mode to stacked', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-stacked-epic-workspace-'));
  const workflowPath = await writeWorkflow(workspaceRoot, { executionMode: 'independent' });
  const calls: { url: string; method: string; body: unknown }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });

    if (url.startsWith('https://api.github.test/repos/mangoappstudio/mdedit/issues?')) {
      return jsonResponse([issuePayload(42, 'Epic parent', 'open', ['ready-for-agent', 'epic:stacked'])]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/pulls?state=open&per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42/sub_issues?per_page=50') {
      return jsonResponse([issuePayload(43, 'First leaf', 'open'), issuePayload(44, 'Second leaf', 'open')]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/43/sub_issues?per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/44/sub_issues?per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/43/labels' && method === 'POST') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42/comments?per_page=50' && method === 'GET') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42/comments' && method === 'POST') {
      return jsonResponse({ id: 600, body: String(body), html_url: 'https://github.test/comment/600' });
    }
    throw new Error(`Unexpected fetch ${method} ${url}`);
  };

  try {
    const orchestrator = new Orchestrator({ workflowPath });
    await orchestrator.tickOnce();
    await orchestrator.shutdown('test');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(calls.some((call) => call.url.endsWith('/issues/43/labels') && call.method === 'POST'));
  assert.equal(calls.some((call) => call.url.endsWith('/issues/44/labels') && call.method === 'POST'), false);

  const epics = await readEpicStates(workspaceRoot);
  assert.equal(epics[0]?.children[0]?.queued, true);
  assert.equal(epics[0]?.children[1]?.queued, false);
  assert.equal(epics[0]?.children[1]?.skipped_reason, 'stack_waiting_on_predecessor');
});

test('parent epic label can force independent execution even when workflow default is stacked', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-independent-epic-workspace-'));
  const workflowPath = await writeWorkflow(workspaceRoot, { executionMode: 'stacked' });
  const calls: { url: string; method: string; body: unknown }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });

    if (url.startsWith('https://api.github.test/repos/mangoappstudio/mdedit/issues?')) {
      return jsonResponse([issuePayload(42, 'Epic parent', 'open', ['ready-for-agent', 'epic:independent'])]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/pulls?state=open&per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42/sub_issues?per_page=50') {
      return jsonResponse([issuePayload(43, 'First leaf', 'open'), issuePayload(44, 'Second leaf', 'open')]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/43/sub_issues?per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/44/sub_issues?per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/43/labels' && method === 'POST') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/44/labels' && method === 'POST') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42/comments?per_page=50' && method === 'GET') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42/comments' && method === 'POST') {
      return jsonResponse({ id: 601, body: String(body), html_url: 'https://github.test/comment/601' });
    }
    throw new Error(`Unexpected fetch ${method} ${url}`);
  };

  try {
    const orchestrator = new Orchestrator({ workflowPath });
    await orchestrator.tickOnce();
    await orchestrator.shutdown('test');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(calls.some((call) => call.url.endsWith('/issues/43/labels') && call.method === 'POST'));
  assert.ok(calls.some((call) => call.url.endsWith('/issues/44/labels') && call.method === 'POST'));

  const epics = await readEpicStates(workspaceRoot);
  assert.equal(epics[0]?.children[0]?.queued, true);
  assert.equal(epics[0]?.children[1]?.queued, true);
  assert.equal(epics[0]?.children[1]?.skipped_reason, null);
});

test('marks native sub-issue epic complete when all descendants are terminal', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-epic-complete-workspace-'));
  const workflowPath = await writeWorkflow(workspaceRoot);
  const calls: { url: string; method: string; body: unknown }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });

    if (url.startsWith('https://api.github.test/repos/mangoappstudio/mdedit/issues?')) {
      return jsonResponse([issuePayload(42, 'Epic parent', 'open', ['ready-for-agent'])]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/pulls?state=open&per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42/sub_issues?per_page=50') {
      return jsonResponse([issuePayload(43, 'Closed child', 'closed')]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/43/sub_issues?per_page=50') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42/labels' && method === 'POST') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42/labels/ready-for-agent' && method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42/labels/agent-running' && method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42/comments?per_page=50' && method === 'GET') {
      return jsonResponse([]);
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/42/comments' && method === 'POST') {
      return jsonResponse({ id: 501, body: String(body), html_url: 'https://github.test/comment/501' });
    }
    throw new Error(`Unexpected fetch ${method} ${url}`);
  };

  try {
    const orchestrator = new Orchestrator({ workflowPath });
    await orchestrator.tickOnce();
    await orchestrator.shutdown('test');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(calls.find((call) => call.url.endsWith('/issues/42/labels') && call.method === 'POST')?.body, {
    labels: ['ready-for-human'],
  });

  const epics = await readEpicStates(workspaceRoot);
  assert.equal(epics[0]?.status, 'completed');
  assert.equal(epics[0]?.open_children, 0);
  assert.equal(epics[0]?.terminal_children, 1);
});
