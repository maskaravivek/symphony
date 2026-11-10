import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  detectAgentLogFormat,
  lastAgentActivity,
  parseAgentLogChunk,
  readAgentLog,
  readAgentUsage,
} from './agentLog.js';
import { ArtifactAccessError, type ArtifactAccess } from './artifacts.js';

const CODEX_LINES = [
  { type: 'thread.started', thread_id: 'thread-abc' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: '**Inspecting the repo**' } },
  { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'I will run the tests first.' } },
  { type: 'item.started', item: { id: 'item_2', type: 'command_execution', command: '/bin/zsh -lc "yarn test"', aggregated_output: '', exit_code: null, status: 'in_progress' } },
  { type: 'item.completed', item: { id: 'item_2', type: 'command_execution', command: '/bin/zsh -lc "yarn test"', aggregated_output: 'ok 1 - passes\n# pass 1\n', exit_code: 0, status: 'completed' } },
  { type: 'item.started', item: { id: 'item_3', type: 'command_execution', command: 'false', aggregated_output: '', exit_code: null, status: 'in_progress' } },
  { type: 'item.completed', item: { id: 'item_3', type: 'command_execution', command: 'false', aggregated_output: '', exit_code: 1, status: 'failed' } },
  { type: 'item.completed', item: { id: 'item_4', type: 'agent_message', text: 'Done. Tests pass.' } },
  { type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 800, cache_write_input_tokens: 0, output_tokens: 300, reasoning_output_tokens: 50 } },
];
const CODEX_PARTIAL = '{"type":"turn.started"';

const CLAUDE_LINES = [
  { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-opus-5-5', tools: ['Bash'] },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Let me look at the failing test.' }, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'yarn test', description: 'Run tests' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_use_id_missing' }, { type: 'tool_result', tool_use_id: 'toolu_1', content: 'all good', is_error: false }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: '/repo/src/a.ts' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'text', text: 'ENOENT' }], is_error: true }] } },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Fixed it.' }] } },
  { type: 'result', subtype: 'success', is_error: false, result: 'Fixed it.', num_turns: 3, usage: { input_tokens: 50, cache_read_input_tokens: 4000, cache_creation_input_tokens: 100, output_tokens: 220 } },
];

function jsonl(lines: unknown[]): string {
  return lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
}

async function setup(): Promise<{ dir: string; access: ArtifactAccess }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-agent-log-'));
  const dir = path.join(base, 'slot', '.symphony', 'runs', 'run-1');
  await fs.mkdir(dir, { recursive: true });
  return { dir, access: { allowedRoots: [base] } };
}

test('detectAgentLogFormat recognizes codex, claude stream-json and plain', () => {
  assert.equal(detectAgentLogFormat('/x/agent.jsonl', jsonl(CODEX_LINES)), 'codex-jsonl');
  assert.equal(detectAgentLogFormat('/x/agent.log', jsonl(CODEX_LINES)), 'plain');
  assert.equal(detectAgentLogFormat('/x/agent.stdout.log', jsonl(CLAUDE_LINES)), 'claude-jsonl');
  assert.equal(detectAgentLogFormat('/x/agent.jsonl', jsonl(CLAUDE_LINES)), 'claude-jsonl');
  assert.equal(detectAgentLogFormat('/x/agent.stdout.log', 'Reading the repo\nRunning tests\n'), 'plain');
  assert.equal(detectAgentLogFormat('/x/agent.jsonl', ''), 'plain');
});

test('codex log: merges started/completed items, accumulates usage, leaves partial line', async () => {
  const { dir, access } = await setup();
  const file = path.join(dir, 'agent.jsonl');
  const content = jsonl(CODEX_LINES) + CODEX_PARTIAL;
  await fs.writeFile(file, content);

  const page = await readAgentLog(access, file, {});
  assert.equal(page.provider_format, 'codex-jsonl');
  assert.equal(page.size, Buffer.byteLength(content));
  assert.equal(page.next_offset, Buffer.byteLength(jsonl(CODEX_LINES)));
  assert.deepEqual(page.items.map((item) => item.kind), ['thread', 'turn', 'reasoning', 'message', 'command', 'command', 'message', 'turn']);
  const indexes = page.items.map((item) => item.index);
  assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b));

  const [, , , , ok, failed] = page.items;
  assert.equal(ok!.title, '/bin/zsh -lc "yarn test"');
  assert.equal(ok!.status, 'completed');
  assert.equal(ok!.exit_code, 0);
  assert.match(ok!.body ?? '', /# pass 1/);
  assert.equal(failed!.status, 'failed');
  assert.equal(failed!.exit_code, 1);
  assert.equal(page.items[0]!.body, 'thread-abc');
  assert.deepEqual(page.usage, { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 300, turns: 1 });

  // Nothing new until the partial line is finished.
  const idle = await readAgentLog(access, file, { after: page.next_offset });
  assert.equal(idle.items.length, 0);
  assert.equal(idle.next_offset, page.next_offset);

  await fs.appendFile(file, '}\n');
  const next = await readAgentLog(access, file, { after: page.next_offset });
  assert.equal(next.provider_format, 'codex-jsonl');
  assert.equal(next.items.length, 1);
  assert.equal(next.items[0]!.kind, 'turn');
  assert.equal(next.items[0]!.status, 'in_progress');
  assert.ok(next.items[0]!.index > page.items.at(-1)!.index);
  assert.equal(next.usage, null);
});

test('codex chunk boundaries: paging with a small limit loses and duplicates nothing', async () => {
  const { dir, access } = await setup();
  const file = path.join(dir, 'agent.jsonl');
  await fs.writeFile(file, jsonl(CODEX_LINES));
  const full = await readAgentLog(access, file, {});

  // Split right after the in_progress command start (5 complete lines).
  const firstFive = Buffer.byteLength(jsonl(CODEX_LINES.slice(0, 5)));
  const first = await readAgentLog(access, file, { limit: firstFive + 10 });
  assert.equal(first.next_offset, firstFive);
  assert.equal(first.items.at(-1)!.kind, 'command');
  assert.equal(first.items.at(-1)!.status, 'in_progress');

  const second = await readAgentLog(access, file, { after: first.next_offset });
  assert.equal(second.next_offset, full.next_offset);
  // The start lived in the previous page, so the completed item is emitted on its own.
  assert.equal(second.items[0]!.kind, 'command');
  assert.equal(second.items[0]!.status, 'completed');
  assert.equal(first.items.length + second.items.length, full.items.length + 1);
  const titles = [...first.items, ...second.items].map((item) => `${item.kind}:${item.title}`);
  for (const item of full.items) assert.ok(titles.includes(`${item.kind}:${item.title}`), `missing ${item.title}`);
  const indexes = [...first.items, ...second.items].map((item) => item.index);
  assert.equal(new Set(indexes).size, indexes.length);

  // Walking the whole file with a tiny limit terminates and reaches the end.
  let after = 0;
  let pages = 0;
  while (after < full.size && pages < 1000) {
    const page = await readAgentLog(access, file, { after, limit: 64 });
    assert.ok(page.next_offset > after);
    after = page.next_offset;
    pages += 1;
  }
  assert.equal(after, full.size);
});

test('claude stream-json log: tool results attach to tool uses, usage from result', async () => {
  const { dir, access } = await setup();
  const file = path.join(dir, 'agent.stdout.log');
  await fs.writeFile(file, jsonl(CLAUDE_LINES));

  const page = await readAgentLog(access, file, {});
  assert.equal(page.provider_format, 'claude-jsonl');
  assert.deepEqual(page.items.map((item) => item.kind), ['thread', 'message', 'tool', 'tool', 'message', 'turn']);
  const [, , bash, read] = page.items;
  assert.equal(bash!.title, 'Bash: yarn test');
  assert.equal(bash!.status, 'completed');
  assert.equal(bash!.body, 'all good');
  assert.equal(read!.title, 'Read: /repo/src/a.ts');
  assert.equal(read!.status, 'failed');
  assert.equal(read!.body, 'ENOENT');
  assert.deepEqual(page.usage, { input_tokens: 50, cached_input_tokens: 4000, output_tokens: 220, turns: 3 });

  assert.deepEqual(await readAgentUsage(access, file), { input_tokens: 50, cached_input_tokens: 4000, output_tokens: 220, turns: 3 });
  assert.deepEqual(await lastAgentActivity(access, file).then((a) => a?.text), 'Fixed it.');

  // A tool_result whose tool_use was in an earlier chunk becomes a raw item.
  const orphan = parseAgentLogChunk(JSON.stringify(CLAUDE_LINES[2]), 'claude-jsonl', 10);
  assert.equal(orphan.items.length, 1);
  assert.equal(orphan.items[0]!.kind, 'raw');
  assert.equal(orphan.items[0]!.index, 10);
});

test('plain log: one message per non-empty line, timestamps when present', async () => {
  const { dir, access } = await setup();
  const file = path.join(dir, 'agent.stdout.log');
  const long = 'x'.repeat(300);
  await fs.writeFile(file, `Reading the repository\n\n2026-11-10T10:00:00Z Running tests\n\u001b[32mgreen\u001b[0m\n${long}\n`);

  const page = await readAgentLog(access, file, {});
  assert.equal(page.provider_format, 'plain');
  assert.deepEqual(page.items.map((item) => item.title.slice(0, 22)), ['Reading the repository', 'Running tests', 'green', 'x'.repeat(22)]);
  assert.equal(page.items[0]!.at, null);
  assert.equal(page.items[1]!.at, '2026-11-10T10:00:00.000Z');
  assert.ok(page.items[3]!.title.length <= 200);
  assert.equal(page.items[3]!.body, long);
  assert.equal(page.usage, null);
  assert.equal(await readAgentUsage(access, file), null);

  const activity = await lastAgentActivity(access, file);
  assert.ok(activity);
  assert.ok(activity.text.length <= 200);
  assert.ok(activity.at);
});

test('readAgentUsage sums every codex turn and lastAgentActivity picks the last action', async () => {
  const { dir, access } = await setup();
  const file = path.join(dir, 'agent.jsonl');
  await fs.writeFile(file, jsonl([...CODEX_LINES, { type: 'turn.started' }, CODEX_LINES[9], { type: 'item.started', item: { id: 'item_9', type: 'command_execution', command: 'git   status\n --short', status: 'in_progress' } }]));

  assert.deepEqual(await readAgentUsage(access, file), { input_tokens: 2400, cached_input_tokens: 1600, output_tokens: 600, turns: 2 });
  const activity = await lastAgentActivity(access, file);
  assert.equal(activity?.text, 'git status --short');

  assert.equal(await lastAgentActivity(access, path.join(dir, 'missing.jsonl')), null);
  assert.equal(await readAgentUsage(access, path.join(dir, 'missing.jsonl')), null);
  await assert.rejects(readAgentLog(access, path.join(dir, 'missing.jsonl'), {}), (error: unknown) => error instanceof ArtifactAccessError && error.status === 404);
  await assert.rejects(readAgentLog(access, 'agent.jsonl', {}), (error: unknown) => error instanceof ArtifactAccessError && error.status === 400);
});

test('parseAgentLogChunk handles unknown and non-JSON lines in jsonl formats', () => {
  const { items, usage } = parseAgentLogChunk('{"type":"session.configured"}\nnot json\n{"type":"error","message":"boom"}\n', 'codex-jsonl', 5);
  assert.deepEqual(items.map((item) => [item.index, item.kind, item.title]), [
    [5, 'raw', 'session.configured'],
    [6, 'raw', 'not json'],
    [7, 'error', 'boom'],
  ]);
  assert.equal(usage, null);
});
