import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBridgeBackend } from './runBridge.js';
import { TelegramBotApi } from './api.js';

test('GitHub adapter records idempotent comments and rechecks lifecycle before every resume', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-telegram-backend-'));
  const originalFetch = globalThis.fetch;
  const mutations: Array<{ method: string; url: string; body?: string }> = [];
  let issueState = 'open';
  let labels = ['needs-info'];
  let savedComment: { id: number; body: string } | null = null;
  let reads = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)).pathname;
    const method = init?.method ?? 'GET';
    let data: unknown = [];
    if (method !== 'GET') mutations.push({ method, url, body: init?.body as string | undefined });
    if (url.endsWith('/comments')) {
      if (method === 'GET') data = savedComment ? [savedComment] : [];
      else data = savedComment = { id: 101, body: (JSON.parse(String(init?.body)) as { body: string }).body };
    } else if (url.includes('/issues/comments/')) {
      data = savedComment;
    } else if (/\/issues\/12$/.test(url)) {
      reads += 1;
      data = { id: 12, node_id: 'I_12', number: 12, title: 'Export', state: issueState, labels: labels.map((name) => ({ name })) };
    }
    return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const workspace = path.join(dir, 'workspaces', '12');
    await fs.mkdir(path.join(workspace, '.symphony'), { recursive: true });
    const run = { owner: 'owner', repo: 'repo', issue_number: 12, session_id: 'session1', status: 'paused', pause_reason: 'needs-info', workspace_path: workspace, updated_at: '2026-10-28' };
    const runFile = path.join(workspace, '.symphony', 'run.json');
    await fs.writeFile(runFile, JSON.stringify(run));
    const workflow = path.join(dir, 'WORKFLOW.md');
    await fs.writeFile(workflow, `---\ntracker:\n  kind: github\n  owner: owner\n  repo: repo\n  token: test\n  ignored_labels: [needs-info, interactive, blocked, symphony-failed]\nworkspace:\n  root: ${path.join(dir, 'workspaces')}\nagents:\n  default: codex\n  providers:\n    codex:\n      command: codex exec -\n---\nPrompt\n`);
    const backend = await createBridgeBackend({ workflow });
    const task = (await backend.tasks())[0]!;
    assert.equal(task.key, 'default#12');
    assert.equal(await backend.comment(task, '<!-- symphony-telegram:123:1 -->', 'Answer'), 101);
    assert.equal(await backend.comment(task, '<!-- symphony-telegram:123:1 -->', 'Answer'), 101);
    assert.equal(mutations.filter((entry) => entry.method === 'POST' && entry.url.endsWith('/comments')).length, 1);
    assert.equal(await backend.resume(task), true);
    const labelWrites = mutations.filter((entry) => entry.url.includes('/labels'));
    assert.equal(labelWrites[0]!.method, 'DELETE');
    assert.match(labelWrites.at(-1)!.body!, /ready-for-agent/);
    const count = mutations.length;
    issueState = 'closed';
    assert.equal(await backend.resume(task), false);
    assert.equal(reads, 2, 'closed-state decision must bypass the issue cache');
    issueState = 'open';
    labels = ['interactive'];
    assert.equal(await backend.resume(task), false);
    assert.equal(mutations.length, count);
    labels = ['needs-info'];
    await fs.writeFile(runFile, JSON.stringify({ ...run, session_id: 'new-session' }));
    assert.equal(await backend.resume(task), false);
    await fs.writeFile(runFile, JSON.stringify({ ...run, status: 'agent-running' }));
    assert.equal(await backend.resume(task), false);
    assert.equal(mutations.length, count);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Telegram transport redacts token-bearing network errors', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('https://api.telegram.org/bot123:private-secret/sendMessage'); };
  try {
    await assert.rejects(new TelegramBotApi('123:private-secret', 123).send('private task'), (error: Error) => {
      assert.doesNotMatch(error.message, /private-secret|private task|https:/);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
