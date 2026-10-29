import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { intakeAliases, type IntakeRepository } from './intakeRouting.js';
import type { RunState } from '../status/runState.js';
import { TelegramBridge, loadBridgeState, saveBridgeState, type BridgeTask, type BridgeState, type BridgeBackend } from './bridge.js';
import type { TelegramUpdate, TelegramApi } from './api.js';

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

test('storage alerts notify on low space and recovery without repeating unchanged state', async () => {
  const sent: string[] = [];
  let blocked = true;
  const state: BridgeState = { offset: 0, seen: {}, messages: {}, pending: {} };
  const backend: BridgeBackend = {
    tasks: async () => [],
    storageAlerts: async () => [{ key: 'app', blocked, minimum_free_gib: 20 }],
    comment: async () => 1, resume: async () => false,
  };
  const bridge = new TelegramBridge({ send: async text => { sent.push(text); return sent.length; } } as TelegramApi,
    backend, state, { chatId: 123, userId: 456 }, async () => {});
  await bridge.notify(); await bridge.notify();
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /paused/);
  blocked = false;
  await bridge.notify(); await bridge.notify();
  assert.equal(sent.length, 2);
  assert.match(sent[1]!, /recovered/);
});

function intakeFixture(repositories: IntakeRepository[] = [{ id: 'taskdrop', repository: 'owner/taskdrop' }]) {
  const sent: string[] = [];
  const created: Array<{ repo: string; text: string; marker: string }> = [];
  const issues = new Map<string, { number: number; title: string; url: string }>();
  const state: BridgeState = { offset: 0, seen: {}, messages: {}, pending: {} };
  let durable = '';
  let failSend = false;
  let failResultSave = false;
  let failCreate: 'before' | 'after' | null = null;
  const backend: BridgeBackend = {
    tasks: async () => [], comment: async () => 1, resume: async () => false,
    repositories: async () => repositories,
    findIntake: async (_repo, marker) => issues.get(marker) ?? null,
    createIntake: async (repo, text, marker) => {
      assert.ok(JSON.parse(durable).intakes, 'intent must already be durable before issue creation');
      created.push({ repo, text, marker });
      if (failCreate === 'before') throw new Error('ambiguous network failure');
      const issue = { number: 42, title: text.split('\n')[0]!, url: 'https://github.test/42' };
      issues.set(marker, issue);
      if (failCreate === 'after') throw new Error('lost response');
      return issue;
    },
  };
  const api: TelegramApi = { updates: async () => [], send: async text => {
    if (failSend) throw new Error('Telegram unavailable');
    sent.push(text); return sent.length;
  } };
  const bridgeFor = (state: BridgeState) => new TelegramBridge(api, backend, state, { chatId: 123, userId: 456 }, async () => {
    if (failResultSave && Object.values(state.intakes ?? {}).some(record => record.issue)) throw new Error('disk unavailable');
    durable = JSON.stringify(state);
  }, 'bot-identity');
  const update = (text: string, id = 1): TelegramUpdate => ({ update_id: id, message: {
    message_id: id, chat: { id: 123, type: 'private' }, from: { id: 456 }, text,
  } });
  return { bridge: bridgeFor(state), bridgeFor, state, sent, created, update,
    durable: () => JSON.parse(durable) as BridgeState,
    failResultSave: (value: boolean) => { failResultSave = value; },
    failSend: (value: boolean) => { failSend = value; }, failCreate: (value: typeof failCreate) => { failCreate = value; } };
}

test('Telegram intake routes configured repo, preserves multiline input, and acknowledges grooming', async () => {
  const f = intakeFixture();
  await f.bridge.receive(f.update('/repos'));
  assert.match(f.sent[0]!, /taskdrop: owner\/taskdrop/);
  await f.bridge.receive(f.update('/new TASKDROP Fix capture\nKeep the raw note and attachments. $(no shell)', 2));
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0]!.repo, 'taskdrop');
  assert.equal(f.created[0]!.text, 'Fix capture\nKeep the raw note and attachments. $(no shell)');
  assert.match(f.created[0]!.marker, /^<!-- symphony-intake:[a-f0-9]{64} -->$/);
  assert.match(f.sent.at(-1)!, /requires-grooming/);
  await f.bridge.receive(f.update('/new TASKDROP Fix capture', 2));
  assert.equal(f.created.length, 1);
});

test('malformed, unknown, oversized and unauthorized intake cannot create issues', async () => {
  const f = intakeFixture();
  let id = 0;
  for (const text of ['/new', '/new taskdrop', '/new unknown Fix', '/new taskdrop ' + 'x'.repeat(8001), 'Fix this']) {
    await f.bridge.receive(f.update(text, ++id));
  }
  for (const kind of ['user', 'chat', 'group', 'bot']) {
    const update = f.update('/new taskdrop Fix', ++id);
    if (kind === 'user') update.message!.from!.id = 999;
    if (kind === 'chat') update.message!.chat.id = 999;
    if (kind === 'group') update.message!.chat.type = 'group';
    if (kind === 'bot') update.message!.from!.is_bot = true;
    await f.bridge.receive(update);
  }
  assert.equal(f.created.length, 0);
});

test('restart after acknowledgment failure reuses durable result without creating another issue', async () => {
  const f = intakeFixture();
  f.failSend(true);
  await assert.rejects(f.bridge.receive(f.update('/new taskdrop Fix capture')));
  assert.equal(f.state.offset, 0);
  f.failSend(false);
  await f.bridgeFor(f.durable()).receive(f.update('/new taskdrop Fix capture'));
  assert.equal(f.created.length, 1);
  assert.match(f.sent.at(-1)!, /taskdrop#42/);
});

test('lost GitHub response reconciles existing issue; unconfirmed creation never repeats POST', async () => {
  const accepted = intakeFixture();
  accepted.failCreate('after');
  await accepted.bridge.receive(accepted.update('/new taskdrop Fix capture'));
  assert.match(accepted.sent.at(-1)!, /taskdrop#42/);
  assert.equal(accepted.created.length, 1);
  const unknown = intakeFixture();
  unknown.failCreate('before');
  unknown.failSend(true);
  await assert.rejects(unknown.bridge.receive(unknown.update('/new taskdrop Fix capture')));
  unknown.failSend(false);
  await unknown.bridgeFor(unknown.durable()).receive(unknown.update('/new taskdrop Fix capture'));
  await unknown.bridge.receive(unknown.update('/intakes', 2));
  assert.equal(unknown.created.length, 1);
  assert.match(unknown.sent.at(-1)!, /creation unconfirmed/);
});


test('crash before saving creation result reconciles the durable intent without another POST', async () => {
  const f = intakeFixture();
  f.failResultSave(true);
  await assert.rejects(f.bridge.receive(f.update('/new taskdrop Fix capture')));
  assert.equal(Object.values(f.durable().intakes!)[0]!.issue, undefined);
  f.failResultSave(false);
  await f.bridgeFor(f.durable()).receive(f.update('/new taskdrop Fix capture'));
  assert.equal(f.created.length, 1);
  assert.match(f.sent.at(-1)!, /taskdrop#42/);
});


test('multiword aliases and substrings create in the resolved repo; ambiguous commands never write', async () => {
  const f = intakeFixture(['ai-photographer', 'myaarti', 'taskdrop', 'tasktools'].map(id => ({ id, repository: `owner/${id}`, aliases: intakeAliases(id) })));
  await f.bridge.receive(f.update('/repos', 1));
  assert.match(f.sent[0]!, /aliases: camera coach/);
  await f.bridge.receive(f.update('/new CAMERA COACH Improve framing tips', 2));
  await f.bridge.receive(f.update('/new aart Improve reminders', 3));
  assert.deepEqual(f.created.map(({ repo, text }) => ({ repo, text })), [
    { repo: 'ai-photographer', text: 'Improve framing tips' },
    { repo: 'myaarti', text: 'Improve reminders' },
  ]);
  await f.bridge.receive(f.update('/new task Improve capture', 4));
  assert.match(f.sent.at(-1)!, /multiple repositories: taskdrop, tasktools/);
  await f.bridge.receive(f.update('/new camera coach', 5));
  assert.match(f.sent.at(-1)!, /Use \/new/);
  assert.equal(f.created.length, 2);
});
