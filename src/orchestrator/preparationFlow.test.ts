import test, { type TestContext } from 'node:test';
import { scanRunStates } from '../status/scanRunStates.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MultiRepoOrchestrator } from './multiRepoOrchestrator.js';

const waitFor = async (file: string) => {
  const end = Date.now() + 5000;
  while (Date.now() < end) { if (await fs.access(file).then(() => true, () => false)) return; await new Promise(r => setTimeout(r, 20)); }
  assert.fail(`Missing ${file}`);
};

async function fixture(t: TestContext, issueCount = 1, globalLimit = 2) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-preparation-'));
  const labels = new Map<string, string[]>();
  for (const repo of ['slow', 'fast']) for (let number = 1; number <= issueCount; number++) labels.set(`${repo}:${number}`, ['ready-for-agent']);
  for (const repo of ['slow', 'fast']) {
    await fs.writeFile(path.join(root, `${repo}.md`), `---
tracker:
  owner: example
  repo: ${repo}
  token: token
  api_base_url: https://api.github.test
workspace:
  root: ${path.join(root, repo)}
  strategy:
    implementation: pooled_isolated
hooks:
  before_run: 'echo preparing >> setup-count; ${repo === 'slow' ? 'sleep 2' : 'true'}'
agent:
  max_attempts: 1
  max_concurrent_agents: ${issueCount}
agents:
  providers:
    codex:
      usage_limit_exit_codes: []
      command: 'echo "$SYMPHONY_NODE_EXECUTABLE" > node-runtime; echo started > agent-started; sleep 30'
---
Task prompt.
`);
  }
  const config = path.join(root, 'config.yml');
  await fs.writeFile(config, `agent:\n  max_concurrent_agents: ${globalLimit}\nrepos:\n  - id: slow\n    workflow: slow.md\n  - id: fast\n    workflow: fast.md\n`);
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET';
    const repo = url.pathname.split('/')[3]!;
    const number = Number(url.pathname.match(/issues\/(\d+)/)?.[1] ?? 1);
    const key = `${repo}:${number}`;
    const current = labels.get(key) ?? [];
    const payload = { id: (repo === 'slow' ? 100 : 200) + number, number, title: 'Task', body: 'Implement task', state: 'open', labels: current.map(name => ({ name })), html_url: `https://github.test/example/${repo}/issues/${number}` };
    const json = (body: unknown) => Response.json(body);
    if (url.pathname.endsWith('/issues') && method === 'GET') {
      const required = url.searchParams.get('labels')?.split(',') ?? [];
      const issues = [];
      for (let n = 1; n <= issueCount; n++) {
        const itemLabels = labels.get(`${repo}:${n}`) ?? [];
        if (required.every(label => itemLabels.includes(label))) issues.push({ ...payload, id: (repo === 'slow' ? 100 : 200) + n, number: n, labels: itemLabels.map(name => ({ name })) });
      }
      return json(issues);
    }
    if (url.pathname.endsWith(`/issues/${number}`)) return json(payload);
    if (url.pathname.endsWith(`/issues/${number}/labels`) && method === 'POST') {
      const body = JSON.parse(String(init?.body)); labels.set(key, [...new Set([...current, ...body.labels])]); return json([]);
    }
    if (url.pathname.includes(`/issues/${number}/labels/`) && method === 'DELETE') {
      labels.set(key, current.filter(label => label !== decodeURIComponent(url.pathname.split('/').at(-1)!))); return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith('/comments') && method === 'POST') return json({ id: 1, body: JSON.parse(String(init?.body)).body });
    if (url.pathname.includes('/issues/comments/')) return json({ id: 1, body: '' });
    return json([]);
  };
  const orchestrator = new MultiRepoOrchestrator({ configPath: config });
  t.after(async () => { await orchestrator.shutdown('test'); globalThis.fetch = original; await fs.rm(root, { recursive: true, force: true }); });
  return { orchestrator, root };
}

test('ordinary issue setup reserves capacity without blocking another repository or duplicating a pool lease', async t => {
  const { orchestrator, root } = await fixture(t);
  const start = Date.now();
  await orchestrator.tickOnce();
  assert.ok(Date.now() - start < 1500, 'A slow before_run hook must not block the multi-repository tick');
  const slow = path.join(root, 'slow', '_pool_1'), fast = path.join(root, 'fast', '_pool_1');
  await waitFor(path.join(slow, 'setup-count'));
  await waitFor(path.join(fast, 'agent-started'));
  assert.equal((await fs.readFile(path.join(fast, 'node-runtime'), 'utf8')).trim(), process.execPath);
  await assert.rejects(fs.access(path.join(slow, 'agent-started')));
  const states = await scanRunStates(path.join(root, 'slow'));
  assert.equal(states[0]?.status, 'preparing');
  await orchestrator.tickOnce();
  assert.equal((await fs.readFile(path.join(slow, 'setup-count'), 'utf8')).trim(), 'preparing');
  await assert.rejects(fs.access(path.join(root, 'slow', '_pool_2')));
  await orchestrator.shutdown('test');
  await assert.rejects(fs.access(path.join(slow, 'agent-started')));
});

test('simultaneous ordinary preparations use separate pool slots and respect the global limit', async t => {
  const { orchestrator, root } = await fixture(t, 2, 3);
  await orchestrator.tickOnce();
  for (const slot of [1, 2]) await waitFor(path.join(root, 'slow', `_pool_${slot}`, 'setup-count'));
  await waitFor(path.join(root, 'fast', '_pool_1', 'agent-started'));
  const states = await scanRunStates(path.join(root, 'slow'));
  assert.equal(states.filter(state => state.status === 'preparing').length, 2);
  assert.equal(new Set(states.map(state => state.issue_id)).size, 2);
  await assert.rejects(fs.access(path.join(root, 'fast', '_pool_2')));
  await orchestrator.shutdown('test');
  for (const slot of [1, 2]) await assert.rejects(fs.access(path.join(root, 'slow', `_pool_${slot}`, 'agent-started')));
});

test('shutdown preserves an incomplete preparation for retry without exhausting the first agent attempt', async t => {
  const { orchestrator, root } = await fixture(t);
  await orchestrator.tickOnce();
  const slow = path.join(root, 'slow', '_pool_1');
  await waitFor(path.join(slow, 'setup-count'));
  await orchestrator.shutdown('shutdown');
  const states = await scanRunStates(path.join(root, 'slow'));
  assert.equal(states[0]?.status, 'retry-wait');
  assert.equal(states[0]?.attempt, 1);
  assert.equal(states[0]?.preparation_incomplete, true);
  await assert.rejects(fs.access(path.join(slow, 'agent-started')));
});


test('repeated setup failures back off across restart and recover without spending an agent attempt', async t => {
  const { orchestrator, root } = await fixture(t);
  const workflow = path.join(root, 'slow.md');
  const original = await fs.readFile(workflow, 'utf8');
  await fs.writeFile(workflow, original.replace('echo preparing >> setup-count; sleep 2', 'echo failed >> setup-count; exit 17'));
  const realNow = Date.now.bind(Date);
  let offset = 0;
  t.mock.method(Date, 'now', () => realNow() + offset);
  await orchestrator.tickOnce(); await orchestrator.waitForPreparations();
  let state = (await scanRunStates(path.join(root, 'slow')))[0]!;
  assert.equal(state.status, 'retry-wait'); assert.equal(state.attempt, 1);
  assert.equal(state.preparation_failure_count, 1);
  const firstDelay = Date.parse(state.retry_not_before!) - realNow();
  await orchestrator.shutdown('restart');
  const restarted = new MultiRepoOrchestrator({configPath:path.join(root, 'config.yml')});
  try {
  offset = 600000;
  await restarted.tickOnce(); await restarted.waitForPreparations();
  state = (await scanRunStates(path.join(root, 'slow')))[0]!;
  assert.equal(state.status, 'retry-wait'); assert.equal(state.attempt, 1);
  assert.equal(state.preparation_failure_count, 2);
  assert.ok(Date.parse(state.retry_not_before!) - Date.now() > firstDelay);
  await fs.writeFile(workflow, original.replace('sleep 2', 'true'));
  offset += 600000;
  await restarted.tickOnce(); await restarted.waitForPreparations();
  await waitFor(path.join(root, 'slow', '_pool_1', 'agent-started'));
  state = (await scanRunStates(path.join(root, 'slow')))[0]!;
  assert.equal(state.status, 'agent-running'); assert.equal(state.attempt, 1);
  assert.equal(state.preparation_failure_count, 0);
  } finally { await restarted.shutdown('test'); }
});
