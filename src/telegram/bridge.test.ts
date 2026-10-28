import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RunState } from '../status/runState.js';
import { TelegramBridge, loadBridgeState, saveBridgeState, type BridgeTask, type BridgeState } from './bridge.js';
import type { TelegramUpdate } from './api.js';

function task(key = 'repo#12'): BridgeTask {
  return { key, state: {
    session_id: 'session1', attempt: 1, status: 'paused', pause_reason: 'needs-info',
    issue_number: 12, issue_title: 'Fix export', issue_identifier: '#12', issue_url: 'https://github.test/12',
    finished_at: '2026-10-28T10:00:00Z',
  } as RunState, lastMessage: 'SYMPHONY_PAUSE\nreason: needs-info\nquestion: Include tablets?\noptions:\n- Yes\n- No\nEND_SYMPHONY_PAUSE' };
}

function fixture(tasks = [task()]) {
  const sent: string[] = [];
  const comments = new Map<string, string>();
  const resumed: string[] = [];
  const state: BridgeState = { offset: 0, seen: {}, messages: {}, pending: {} };
  let saves = 0;
  const bridge = new TelegramBridge({ updates: async () => [], send: async (text) => { sent.push(text); return sent.length; } }, {
    tasks: async () => tasks,
    comment: async (entry, marker, text) => { comments.set(`${entry.key}:${marker}`, text); return 100; },
    resume: async (entry) => { resumed.push(entry.key); return true; },
  }, state, { chatId: 123, userId: 456 }, async () => { saves += 1; });
  const reply = (id: number, replyId = 1): TelegramUpdate => ({ update_id: id, message: {
    message_id: 99, chat: { id: 123, type: 'private' }, from: { id: 456 }, text: 'Yes, include tablets.', reply_to_message: { message_id: replyId },
  } });
  return { bridge, state, sent, comments, resumed, reply, tasks, saves: () => saves };
}

test('existing questions notify; a reply records context and resumes the exact repository', async () => {
  const f = fixture([task('first#12'), task('second#12')]);
  await f.bridge.notify();
  assert.match(f.sent[0]!, /Include tablets/);
  await f.bridge.receive(f.reply(40, 2));
  assert.deepEqual(f.resumed, ['second#12']);
  assert.match([...f.comments.keys()][0]!, /^second#12:<!-- symphony-telegram:123:40 -->$/);
  assert.match([...f.comments.values()][0]!, /include tablets/);
  assert.equal(f.state.offset, 41);
  await f.bridge.receive(f.reply(40, 2));
  assert.equal(f.resumed.length, 1);
  await f.bridge.notify();
  assert.equal(f.sent.length, 3);
});

test('unauthorized user, chat, group and bot cannot write or resume', async () => {
  const f = fixture();
  await f.bridge.notify();
  const updates = [f.reply(1), f.reply(2), f.reply(3), f.reply(4)];
  updates[0]!.message!.from!.id = 999;
  updates[1]!.message!.chat.id = 999;
  updates[2]!.message!.chat.type = 'group';
  updates[3]!.message!.from!.is_bot = true;
  for (const update of updates) await f.bridge.receive(update);
  assert.equal(f.comments.size, 0);
  assert.equal(f.resumed.length, 0);
  assert.equal(f.sent.length, 1);
  assert.equal(f.state.offset, 5);
});

test('unknown routing and stale questions never write instructions', async () => {
  const f = fixture();
  await f.bridge.notify();
  await f.bridge.receive(f.reply(1, 999));
  f.tasks[0]!.state.session_id = 'new-session';
  await f.bridge.receive(f.reply(2));
  assert.equal(f.comments.size, 0);
  assert.match(f.sent.at(-1)!, /earlier run/);
});

test('running follow-up waits until completion and is requeued once', async () => {
  const f = fixture();
  f.tasks[0]!.state.status = 'agent-running';
  f.tasks[0]!.state.pause_reason = null;
  await f.bridge.notify();
  // Status command does not create ambiguous task routing.
  f.state.messages['7'] = { key: 'repo#12', session: 'session1', question: false };
  await f.bridge.receive(f.reply(1, 7));
  assert.equal(f.comments.size, 1);
  assert.equal(f.resumed.length, 0);
  assert.match(f.sent.at(-1)!, /has not received/);
  f.tasks[0]!.state.status = 'completed';
  await f.bridge.notify();
  assert.deepEqual(f.resumed, ['repo#12']);
  await f.bridge.notify();
  assert.equal(f.resumed.length, 1);
});

test('another run consumes pending comments without triggering an extra run', async () => {
  const f = fixture();
  f.state.pending['repo#12'] = { commentId: 100 };
  f.tasks[0]!.state.last_seen_comment_id = 100;
  f.tasks[0]!.state.status = 'completed';
  await f.bridge.notify();
  assert.equal(f.resumed.length, 0);
  assert.deepEqual(f.state.pending, {});
});

test('first observation baselines past outcomes and later transitions notify', async () => {
  const f = fixture();
  f.tasks[0]!.state.status = 'completed';
  await f.bridge.notify();
  assert.equal(f.sent.length, 0);
  f.tasks[0]!.state.status = 'agent-running';
  await f.bridge.notify();
  f.tasks[0]!.state.status = 'failed';
  await f.bridge.notify();
  assert.match(f.sent[0]!, /failed/);
});

test('durable state survives restart with private permissions; corrupt state fails closed', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-telegram-'));
  try {
    const file = path.join(directory, 'state.json');
    const f = fixture();
    await f.bridge.notify();
    await f.bridge.receive(f.reply(18));
    await saveBridgeState(file, f.state);
    assert.deepEqual(await loadBridgeState(file), f.state);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    await fs.writeFile(file, '{}');
    await assert.rejects(loadBridgeState(file), /Invalid/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('failed side effects leave the update cursor unacknowledged for retry', async () => {
  const state: BridgeState = { offset: 0, seen: {}, pending: {}, messages: { '1': { key: 'repo#12', session: 'session1', question: true } } };
  const bridge = new TelegramBridge({ updates: async () => [], send: async () => 1 }, {
    tasks: async () => [task()], comment: async () => { throw new Error('GitHub unavailable'); }, resume: async () => true,
  }, state, { chatId: 123, userId: 456 }, async () => {});
  await assert.rejects(bridge.receive(fixture().reply(9)), /GitHub unavailable/);
  assert.equal(state.offset, 0);
});
