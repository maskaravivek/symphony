import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDashboardRequestHandler, startDashboardServer, type StartedDashboardServer } from './server.js';
import { writeRunState, type RunState } from '../status/runState.js';
import { createDashboardFixture, type DashboardFixture } from '../status/dashboard/testFixtures.js';

function makeRunState(workspacePath: string): RunState {
  return {
    repo_id: null,
    owner: 'mangoappstudio',
    repo: 'mdedit',
    issue_id: 'issue-42',
    issue_number: 42,
    issue_identifier: 'mangoappstudio/mdedit#42',
    issue_url: 'https://github.test/mangoappstudio/mdedit/issues/42',
    issue_title: 'Dashboard test issue',
    issue_state: 'open',
    labels: ['agent-running'],
    workflow_state: 'agent-running',
    workspace_path: workspacePath,
    workspace_strategy: 'durable_issue_workspace',
    attempt: 1,
    session_id: null,
    agent_provider: 'codex',
    agent_provider_group: 'codex',
    agent_provider_kind: 'codex',
    agent_thread_id: 'thread-1234567890',
    agent_mode: 'autonomous',
    agent_log_path: path.join(workspacePath, '.symphony', 'codex.jsonl'),
    codex_thread_id: 'thread-1234567890',
    codex_mode: 'autonomous',
    pause_reason: null,
    worker_pid: null,
    status: 'agent-running',
    started_at: '2026-07-08T11:00:00.000Z',
    finished_at: null,
    last_exit_code: null,
    last_signal: null,
    last_error: null,
    prompt_path: path.join(workspacePath, '.symphony', 'prompt.md'),
    agent_output_path: path.join(workspacePath, '.symphony', 'codex.jsonl'),
    codex_jsonl_path: path.join(workspacePath, '.symphony', 'codex.jsonl'),
    last_message_path: path.join(workspacePath, '.symphony', 'last_message.md'),
    last_seen_comment_id: null,
    status_comment_id: null,
    last_handoff_at: null,
    updated_at: '2026-07-08T12:00:00.000Z',
  };
}

async function writeWorkflow(root: string, workspaceRoot: string): Promise<string> {
  const workflowPath = path.join(root, 'WORKFLOW.md');
  await fs.writeFile(
    workflowPath,
    `---
tracker:
  owner: mangoappstudio
  repo: mdedit
  token: test
  terminal_states: [closed]
  required_labels: [ready-for-agent]
  ignored_labels: [blocked, ready-for-human, wontfix]
workspace:
  root: ${workspaceRoot}
agents:
  default: codex
  providers:
    codex:
      command: 'true'
---
Prompt
`,
    'utf8',
  );
  return workflowPath;
}

async function makeUiDir(root: string): Promise<string> {
  const uiDir = path.join(root, 'ui');
  await fs.mkdir(path.join(uiDir, 'lib'), { recursive: true });
  await fs.writeFile(path.join(uiDir, 'index.html'), '<!doctype html><title>Symphony</title><div id="app"></div>\n', 'utf8');
  await fs.writeFile(path.join(uiDir, 'app.js'), 'export const app = 1;\n', 'utf8');
  await fs.writeFile(path.join(uiDir, 'lib', 'style.css'), 'body{}\n', 'utf8');
  await fs.writeFile(path.join(root, 'secret.txt'), 'secret\n', 'utf8');
  return uiDir;
}

function rawGet(url: string, requestPath: string): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: target.hostname, port: target.port, path: requestPath, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function closeServer(started: StartedDashboardServer): Promise<void> {
  await new Promise<void>((resolve) => started.server.close(() => resolve()));
}

test('legacy /api/board keeps working and mutating methods are rejected', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-dashboard-server-'));
  const workspaceRoot = path.join(root, 'workspaces');
  const workspacePath = path.join(workspaceRoot, 'issue-42');
  const workflowPath = await writeWorkflow(root, workspaceRoot);
  await writeRunState(workspacePath, makeRunState(workspacePath));

  const started = await startDashboardServer({ workflow: workflowPath, host: '127.0.0.1', port: 0, refreshMs: 1000, liveRefresh: false, uiDir: await makeUiDir(root) });
  try {
    const boardResponse = await fetch(new URL('/api/board', started.url));
    assert.equal(boardResponse.status, 200);
    const board = (await boardResponse.json()) as { total_cards: number; refresh_ms: number; columns: Array<{ id: string; cards: unknown[] }> };
    assert.equal(board.total_cards, 1);
    assert.equal(board.refresh_ms, 1000);
    assert.equal(board.columns.find((column) => column.id === 'active')?.cards.length, 1);

    const postResponse = await fetch(new URL('/api/board', started.url), { method: 'POST' });
    assert.equal(postResponse.status, 405);
    assert.match(await postResponse.text(), /readonly/);
  } finally {
    await closeServer(started);
  }
});

test('serves the static UI with traversal protection', async () => {
  const fixture: DashboardFixture = await createDashboardFixture();
  const uiDir = await makeUiDir(fixture.root);
  const started = await startDashboardServer({ config: fixture.configPath, host: '127.0.0.1', port: 0, refreshMs: 1000, liveRefresh: false, uiDir });
  try {
    const index = await fetch(started.url);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type') ?? '', /^text\/html/);
    assert.equal(index.headers.get('cache-control'), 'no-store');
    assert.match(await index.text(), /<title>Symphony<\/title>/);

    const head = await fetch(started.url, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');

    const deepLink = await fetch(new URL('/repos/x', started.url));
    assert.equal(deepLink.status, 200);
    assert.match(await deepLink.text(), /id="app"/);

    const script = await fetch(new URL('/ui/app.js', started.url));
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type') ?? '', /^text\/javascript/);
    assert.equal(script.headers.get('cache-control'), 'max-age=60');
    const css = await fetch(new URL('/ui/lib/style.css', started.url));
    assert.match(css.headers.get('content-type') ?? '', /^text\/css/);

    assert.equal((await fetch(new URL('/ui/missing.js', started.url))).status, 404);
    const traversal = await rawGet(started.url, '/ui/..%2fsecret.txt');
    assert.equal(traversal.status, 404);
    assert.doesNotMatch(traversal.body, /secret/);
    assert.equal((await rawGet(started.url, '/ui/%2e%2e%2f%2e%2e%2fsecret.txt')).status, 404);
    assert.equal((await rawGet(started.url, '/ui/lib/..%5c..%5csecret.txt')).status, 404);
  } finally {
    await closeServer(started);
  }
});

test('serves the dashboard JSON API from local state', async () => {
  const fixture = await createDashboardFixture();
  const started = await startDashboardServer({ config: fixture.configPath, host: '127.0.0.1', port: 0, refreshMs: 1000, liveRefresh: false, uiDir: await makeUiDir(fixture.root) });
  const get = async (route: string) => {
    const response = await fetch(new URL(route, started.url));
    return { status: response.status, headers: response.headers, body: (await response.json()) as Record<string, unknown> };
  };
  try {
    const overview = await get('/api/overview');
    assert.equal(overview.status, 200);
    assert.equal(overview.headers.get('cache-control'), 'no-store');
    assert.equal((overview.body.totals as { repos: number }).repos, 1);
    assert.ok(Array.isArray(overview.body.attention));
    assert.equal((await get('/api/overview?github=1')).status, 200);

    const headOverview = await fetch(new URL('/api/overview', started.url), { method: 'HEAD' });
    assert.equal(headOverview.status, 200);
    assert.equal(await headOverview.text(), '');

    const repo = await get('/api/repos/x');
    assert.equal(repo.status, 200);
    assert.equal(repo.body.repo_id, 'x');
    assert.ok(Array.isArray(repo.body.slots));
    assert.equal((await get('/api/repos/nope')).status, 404);

    const task = await get('/api/tasks/x/1');
    assert.equal(task.status, 200);
    assert.equal((task.body.task as { task_key: string }).task_key, 'x/1');
    assert.equal((await get('/api/tasks/x/999')).status, 404);
    const badTask = await get('/api/tasks/x/abc');
    assert.equal(badTask.status, 400);
    assert.equal(typeof badTask.body.error, 'string');

    const loop = await get('/api/tasks/x/loop/daily');
    assert.equal(loop.status, 200);
    assert.equal((loop.body.loop as { loop_id: string }).loop_id, 'daily');

    const history = await get('/api/history?days=28&repo=x');
    assert.equal(history.status, 200);
    assert.equal((history.body.window as { days: number }).days, 28);
    assert.equal((await get('/api/history?days=0')).status, 400);

    const events = await get('/api/events?repo=x&limit=2');
    assert.equal(events.status, 200);
    assert.equal((events.body.events as unknown[]).length, 2);
    assert.equal(typeof events.body.next_before, 'number');
    assert.equal((await get('/api/events?task=x/2')).status, 200);
    assert.equal((await get('/api/events?limit=lots')).status, 400);

    const outside = await get('/api/artifact?path=/etc/passwd');
    assert.equal(outside.status, 403);
    assert.equal(typeof outside.body.error, 'string');
    assert.equal((await get('/api/artifact')).status, 400);
    const secret = path.join(fixture.workspaceRoot, '.env');
    await fs.writeFile(secret, 'PRIVATE=example');
    assert.equal((await get(`/api/artifact?path=${encodeURIComponent(secret)}`)).status, 403);
    const alias = path.join(fixture.sessionDir, 'alias.log');
    await fs.symlink(secret, alias);
    assert.equal((await get(`/api/agent-log?path=${encodeURIComponent(alias)}`)).status, 403);
    const reboundStatus = await new Promise<number | undefined>((resolve, reject) => {
      http.get(new URL('/api/overview', started.url), { headers: { Host: 'rebind.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject);
    });
    assert.equal(reboundStatus, 403);
    const prompt = await get(`/api/artifact?path=${encodeURIComponent(path.join(fixture.sessionDir, 'prompt.md'))}`);
    assert.equal(prompt.status, 200);
    assert.equal(prompt.body.content, 'Do the thing\n');
    const tail = await get(`/api/artifact?path=${encodeURIComponent(path.join(fixture.sessionDir, 'prompt.md'))}&tail=6`);
    assert.equal(tail.status, 200);
    const log = await get(`/api/agent-log?path=${encodeURIComponent(path.join(fixture.sessionDir, 'agent.jsonl'))}`);
    assert.equal(log.status, 200);
    assert.equal(log.body.provider_format, 'codex-jsonl');
    assert.equal((await get('/api/agent-log?path=/etc/hosts')).status, 403);

    assert.equal((await get('/api/unknown')).status, 404);
  } finally {
    await closeServer(started);
  }
});

test('/api/stream sends SSE headers and change events for local writes', async () => {
  const fixture = await createDashboardFixture();
  const handler = createDashboardRequestHandler({ config: fixture.configPath, refreshMs: 1000, liveRefresh: false });
  const server = http.createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const controller = new AbortController();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/stream`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = '';
    const readUntil = async (pattern: RegExp, timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      while (!pattern.test(received)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`timed out waiting for ${pattern}; got ${JSON.stringify(received)}`);
        const chunk = await Promise.race([
          reader.read(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining)),
        ]);
        if (chunk === null) continue;
        if (chunk.done) throw new Error('stream ended');
        received += decoder.decode(chunk.value);
      }
    };
    await readUntil(/: connected/, 2_000);

    // Wait for watchers to attach, then touch a slot's run state.
    const deadline = Date.now() + 2_000;
    while (handler.stream.watchedPaths.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(handler.stream.watchedPaths.some((dir) => dir.endsWith(path.join('_pool_1', '.symphony'))));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const runPath = path.join(fixture.workspaceRoot, '_pool_1', '.symphony', 'run.json');
    await fs.writeFile(runPath, await fs.readFile(runPath, 'utf8'), 'utf8');
    await readUntil(/event: change\ndata: .*"scope":"local".*"repo_id":"x"/, 6_000);

    handler.stream.emit({ at: new Date().toISOString(), scope: 'github', repo_id: 'x' });
    await readUntil(/"scope":"github"/, 1_000);
  } finally {
    controller.abort();
    handler.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
