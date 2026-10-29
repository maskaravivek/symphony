import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Orchestrator } from './orchestrator.js';
import { scanRunStates } from '../status/scanRunStates.js';
import { createBridgeBackend } from '../telegram/runBridge.js';

async function fixture(t: test.TestContext, output: string, initialLabels = ['requires-grooming']) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-grooming-'));
  const workspace = path.join(root, 'workspaces');
  const workflowPath = path.join(root, 'WORKFLOW.md');
  const outputPath = path.join(root, 'result.txt');
  await fs.writeFile(outputPath, output);
  await fs.writeFile(workflowPath, `---
tracker:
  owner: example
  repo: app
  token: token
  api_base_url: https://api.github.test
  priority_labels:
    'priority: medium': 3
workspace:
  root: ${workspace}
hooks:
  after_run: echo unexpected > after-run-marker
agent:
  max_attempts: 1
agents:
  providers:
    codex:
      command: echo implementation > implementation-marker
      handoff_command: cp '${outputPath}' "$SYMPHONY_LAST_MESSAGE_PATH"
---
Implement the issue, commit and open a PR.
`);
  let title = 'Fix reminders';
  let labels = [...initialLabels];
  const comments: Array<{ id: number; body: string }> = [];
  const known = ['requires-grooming', 'priority: medium', 'bug', 'needs-info', 'ready-for-human', 'ready-for-agent', 'agent-running'];
  const oldFetch = globalThis.fetch;
  const payload = () => ({ id: 42, node_id: 'I_42', number: 42, title, body: 'one-line capture', state: 'open', labels: labels.map(name => ({ name })), html_url: 'https://github.test/example/app/issues/42' });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)); const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const end = url.pathname;
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
    if (end.endsWith('/issues') && method === 'GET') {
      const query = url.searchParams.get('labels');
      return json(!query || query.split(',').every(l => labels.includes(l)) ? [payload()] : []);
    }
    if (end.endsWith('/issues/42')) return json(payload());
    if (end.endsWith('/pulls')) return json([]);
    if (end.endsWith('/events')) return json([]);
    if (end.endsWith('/issues/42/comments') && method === 'GET') return json(comments);
    if (end.endsWith('/issues/42/comments') && method === 'POST') {
      const comment = { id: comments.length + 1, body: body.body }; comments.push(comment); return json(comment);
    }
    if (/\/issues\/comments\/\d+$/.test(end) && method === 'PATCH') {
      const item = comments.find(c => c.id === Number(end.split('/').at(-1)))!; item.body = body.body; return json(item);
    }
    if (end.endsWith('/issues/42/labels') && method === 'POST') { labels = [...new Set([...labels, ...body.labels])]; return json(labels); }
    if (end.includes('/issues/42/labels/') && method === 'DELETE') { labels = labels.filter(l => l !== decodeURIComponent(end.split('/').at(-1)!)); return new Response(null, { status: 204 }); }
    if (end.endsWith('/labels')) return json(known.map(name => ({ name })));
    throw Error(`Unexpected ${method} ${end}`);
  };
  const orchestrator = new Orchestrator({ workflowPath, repoId: 'app' });
  t.after(async () => { await orchestrator.shutdown('test'); globalThis.fetch = oldFetch; await fs.rm(root, { recursive: true, force: true }); });
  const finish = async () => {
    const deadline = Date.now() + 5000;
    while (orchestrator.getRunningCount() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(orchestrator.getRunningCount(), 0);
  };
  return { orchestrator, workflowPath, workspace, comments, labels: () => labels, changeTitle: () => { title = 'Changed intent'; }, finish, outputPath };
}
const result = (outcome = 'ready') => `SYMPHONY_GROOMING_RESULT\n${JSON.stringify({ outcome, summary: 'Persist reminder time', scope: 'Storage only; no redesign', acceptance_criteria: ['Time survives restart'], verification: ['Run storage unit tests and restart the app'], evidence: ['Investigate the reminder storage path'], labels: ['priority: medium', 'bug'] })}\nEND_SYMPHONY_GROOMING_RESULT`;

test('one-line intake is groomed without readiness, code execution or PR hooks, then queued', async t => {
  const f = await fixture(t, result());
  await f.orchestrator.tickOnce(); await f.finish();
  assert(f.labels().includes('ready-for-agent'));
  assert(!f.labels().includes('requires-grooming'));
  assert(f.labels().includes('priority: medium'));
  assert(f.comments.some(c => c.body.includes('Groomed issue brief')));
  const states = await scanRunStates(f.workspace);
  assert.equal(states[0]?.agent_mode, 'grooming');
  assert.equal(states[0]?.status, 'completed');
  const prompt = await fs.readFile(states[0]!.prompt_path!, 'utf8');
  assert.match(prompt, /Intake grooming/);
  await assert.rejects(fs.access(path.join(states[0]!.workspace_path, 'after-run-marker')));
  await assert.rejects(fs.access(path.join(states[0]!.workspace_path, 'implementation-marker')));
});

test('ambiguous intake pauses, Telegram answer requeues grooming, and only its result clears the gate', async t => {
  const f = await fixture(t, 'SYMPHONY_PAUSE\nreason: Missing platform\nquestion: Android or macOS?\noptions:\n- Android\n- macOS\nEND_SYMPHONY_PAUSE');
  await f.orchestrator.tickOnce(); await f.finish();
  assert(f.labels().includes('requires-grooming')); assert(f.labels().includes('needs-info'));
  const backend = await createBridgeBackend({ workflow: f.workflowPath });
  const task = (await backend.tasks())[0]!;
  assert.equal(task.state.pause_reason, 'needs-info');
  await backend.comment(task, '<!-- answer -->', 'Android.');
  assert.equal(await backend.resume(task), true);
  await fs.writeFile(f.outputPath, result());
  await f.orchestrator.tickOnce(); await f.finish();
  assert(!f.labels().includes('requires-grooming')); assert(f.labels().includes('ready-for-agent'));
});

test('incomplete output fails closed even when the capture was incorrectly marked ready', async t => {
  const f = await fixture(t, 'Looks good, implement it.', ['requires-grooming', 'ready-for-agent']);
  await f.orchestrator.tickOnce(); await f.finish();
  assert(f.labels().includes('requires-grooming')); assert(!f.labels().includes('ready-for-agent'));
  assert(f.labels().includes('symphony-failed'));
});

test('human disposition keeps implementation unqueued', async t => {
  const f = await fixture(t, result('human'));
  await f.orchestrator.tickOnce(); await f.finish();
  assert(f.labels().includes('ready-for-human')); assert(!f.labels().includes('ready-for-agent'));
});

test('durable grooming finalization is idempotent after restart', async t => {
  const f = await fixture(t, result());
  await f.orchestrator.tickOnce(); await f.finish();
  await f.orchestrator.shutdown('restart');
  const state = (await scanRunStates(f.workspace))[0]!;
  const file = path.join(state.workspace_path, '.symphony', 'run.json');
  await fs.writeFile(file, JSON.stringify({ ...state, status: 'finalizing' }));
  const restarted = new Orchestrator({ workflowPath: f.workflowPath, repoId: 'app' });
  try {
    await restarted.tickOnce({ maxNewDispatches: 0 });
    assert.equal((await scanRunStates(f.workspace))[0]?.status, 'completed');
    assert.equal(f.comments.filter(c => c.body.includes('<!-- symphony-grooming:')).length, 1);
    assert(!f.labels().includes('requires-grooming'));
  } finally { await restarted.shutdown('test'); }
});

test('a changed capture is never queued using stale grooming output', async t => {
  const f = await fixture(t, result());
  const workflow = await fs.readFile(f.workflowPath, 'utf8');
  await fs.writeFile(f.workflowPath, workflow.replace('handoff_command: cp', 'handoff_command: sleep 0.2; cp'));
  await f.orchestrator.tickOnce();
  f.changeTitle();
  await f.finish();
  assert(f.labels().includes('requires-grooming'));
  assert(!f.labels().includes('ready-for-agent'));
  assert(f.labels().includes('symphony-failed'));
});

test('intake respects human and blocker labels even with readiness present', async t => {
  const f = await fixture(t, result(), ['requires-grooming', 'ready-for-agent', 'blocked']);
  await f.orchestrator.tickOnce(); await f.finish();
  assert.equal((await scanRunStates(f.workspace)).length, 0);
  assert.equal(f.comments.length, 0);
  assert(f.labels().includes('requires-grooming'));
});


test('human grooming without a priority preserves existing classification and publishes the handoff', async t => {
  const output = result('human').replace('"labels":["priority: medium","bug"]', '"labels":[]');
  const f = await fixture(t, output, ['requires-grooming', 'priority: medium', 'bug']);
  await f.orchestrator.tickOnce(); await f.finish();
  assert(f.labels().includes('ready-for-human'));
  assert(f.labels().includes('priority: medium'));
  assert(f.labels().includes('bug'));
  assert(!f.labels().includes('ready-for-agent'));
  assert(!f.labels().includes('symphony-failed'));
  assert(!f.labels().includes('requires-grooming'));
  assert(f.comments.some(c => c.body.includes('Human attention required')));
  assert.equal((await scanRunStates(f.workspace))[0]?.status, 'completed');
});
