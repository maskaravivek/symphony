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

function fixture(tasks = [task()], now = () => new Date('2026-10-28T12:00:00Z')) {
  const sent: string[] = [];
  const comments = new Map<string, string>();
  const resumed: string[] = [];
  const reactions: number[] = [];
  const state: BridgeState = { offset: 0, seen: {}, messages: {}, pending: {} };
  let saves = 0;
  const bridge = new TelegramBridge({ updates: async () => [], react: async id => {reactions.push(id);}, send: async (text) => { sent.push(text); return sent.length; } }, {
    tasks: async () => tasks,
    comment: async (entry, marker, text) => { comments.set(`${entry.key}:${marker}`, text); return 100; },
    resume: async (entry) => { resumed.push(entry.key); return true; },
  }, state, { chatId: 123, userId: 456 }, async () => { saves += 1; }, 'telegram', {now});
  const reply = (id: number, replyId = 1): TelegramUpdate => ({ update_id: id, message: {
    message_id: 99, chat: { id: 123, type: 'private' }, from: { id: 456 }, text: 'Yes, include tablets.', reply_to_message: { message_id: replyId },
  } });
  return { bridge, state, sent, comments, resumed, reactions, reply, tasks, saves: () => saves };
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
  assert.equal(f.sent.length, 2);
  assert.deepEqual(f.reactions, [99]);
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
  assert.match(f.sent[0]!, /stopped after automatic retries/);
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

test('storage alerts notify only when action is needed; recovery is quiet', async () => {
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
  assert.match(sent[0]!, /Storage needs attention/);
  blocked = false;
  await bridge.notify(); await bridge.notify();
  assert.equal(sent.length, 1);
  assert.ok(state.notifications?.pending['app:notice:storage']);
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


test('automatic setup retries and recovery remain silent', async () => {
  const entry = task();
  Object.assign(entry.state, {status:'retry-wait', pause_reason:null, preparation_incomplete:true, preparation_failure_count:1, last_error:'Setup download failed'});
  const f = fixture([entry]);
  await f.bridge.notify();
  assert.equal(f.sent.length, 0);
  entry.state.session_id = 'retry-session'; entry.state.preparation_failure_count = 2;
  await f.bridge.notify();
  assert.equal(f.sent.length, 0);
  Object.assign(entry.state, {status:'agent-running', preparation_incomplete:false, preparation_failure_count:0});
  await f.bridge.notify(); await f.bridge.notify();
  assert.equal(f.sent.length, 0);
  Object.assign(entry.state, {status:'retry-wait', preparation_incomplete:true, preparation_failure_count:1});
  await f.bridge.notify();
  assert.equal(f.sent.length, 0);
});


test('routine outcomes wait for one changed-repository brief at 9am Toronto and survive restart', async () => {
  let now = new Date('2026-10-28T12:30:00Z'); // 8:30 Toronto
  const entry=task('mdedit#12'); Object.assign(entry.state,{status:'agent-running',pause_reason:null});
  const f=fixture([entry],()=>now);
  await f.bridge.notify();
  entry.state.status='completed'; entry.lastMessage='Long agent output '.repeat(300);
  await f.bridge.notify(); assert.equal(f.sent.length,0);
  now=new Date('2026-10-28T12:59:00Z');await f.bridge.notify();assert.equal(f.sent.length,0);
  now=new Date('2026-10-28T13:00:00Z');await f.bridge.notify();
  assert.equal(f.sent.length,1);assert.match(f.sent[0]!,/daily brief.*2026-10-28/);assert.match(f.sent[0]!,/mdedit/);
  assert.match(f.sent[0]!,/1 runs completed/);assert.doesNotMatch(f.sent[0]!,/Long agent output/);
  const restored=JSON.parse(JSON.stringify(f.state)) as BridgeState;
  const bridge=new TelegramBridge({send:async text=>{f.sent.push(text);return f.sent.length;}} as TelegramApi,
    {tasks:async()=>[entry],comment:async()=>1,resume:async()=>true},restored,{chatId:123,userId:456},async()=>{},'telegram',{now:()=>now});
  await bridge.notify();assert.equal(f.sent.length,1);
  now=new Date('2026-10-29T13:00:00Z');await bridge.notify();assert.equal(f.sent.length,1,'No brief on a quiet day');
});

test('a failed daily send retains the pending brief and catches up after a missed morning',async()=>{
 let now=new Date('2026-10-28T14:00:00Z');const entry=task();Object.assign(entry.state,{status:'agent-running',pause_reason:null});
 const f=fixture([entry],()=>now);await f.bridge.notify();entry.state.status='completed';await f.bridge.notify();
 now=new Date('2026-10-29T19:00:00Z');let failing=true;const sent:string[]=[];
 const b=new TelegramBridge({send:async text=>{if(failing)throw new Error('offline');sent.push(text);return 1;}} as TelegramApi,
 {tasks:async()=>[entry],comment:async()=>1,resume:async()=>true},f.state,{chatId:123,userId:456},async()=>{},'telegram',{now:()=>now});
 await assert.rejects(b.notify(),/offline/);assert.ok(Object.keys(f.state.notifications!.pending).length);
 failing=false;await b.notify();await b.notify();assert.equal(sent.length,1);assert.deepEqual(f.state.notifications!.pending,{});
});

test('questions are short and credentials alert once across automatic retry sessions',async()=>{
 const entry=task();entry.lastMessage='SYMPHONY_PAUSE\nquestion: '+ 'A very long question '.repeat(100)+'\noptions:\n- Yes\n- No\nEND_SYMPHONY_PAUSE';
 const f=fixture([entry]);await f.bridge.notify();assert.ok(f.sent[0]!.length<850);assert.match(f.sent[0]!,/Reply here/);
 Object.assign(entry.state,{status:'retry-wait',pause_reason:null,last_error:'Invalid API key'});entry.lastMessage='';
 await f.bridge.notify();assert.equal(f.sent.length,2);assert.match(f.sent[1]!,/authentication needs attention/);
 entry.state.session_id='retry2';await f.bridge.notify();assert.equal(f.sent.length,2);
 Object.assign(entry.state,{status:'agent-running',last_error:null});await f.bridge.notify();assert.equal(f.sent.length,2);
});

test('durable activity feeds merge summaries even after workspace removal; multiple repos share one message',async()=>{
 let now=new Date('2026-10-28T12:00:00Z');const sent:string[]=[];let cursor=0;
 const state:BridgeState={offset:0,seen:{},messages:{},pending:{}};
 const b=new TelegramBridge({send:async text=>{sent.push(text);return sent.length;}} as TelegramApi,{
  tasks:async()=>[],comment:async()=>1,resume:async()=>true,
  activity:async cursors=>{if(cursors.mdedit===undefined)return [{repo:'mdedit',cursor:10,activities:[]}];
   cursor++;return cursor===1?[{repo:'mdedit',cursor:11,activities:[{repo:'mdedit',key:'mdedit#1727',kind:'merged',url:'https://github.com/example/app/pull/1727'}]},
    {repo:'taskdrop',cursor:1,activities:[{repo:'taskdrop',key:'taskdrop#1',kind:'completed'}]}]:[];},
 },state,{chatId:123,userId:456},async()=>{},'telegram',{now:()=>now});
 await b.notify();await b.notify();assert.equal(sent.length,0);
 now=new Date('2026-10-28T13:00:00Z');await b.notify();assert.equal(sent.length,1);assert.match(sent[0]!,/PRs merged/);assert.match(sent[0]!,/taskdrop/);
});

test('old failed workspace metadata cannot replace a newer completed run or trigger an alert',async()=>{
 const entry=task();Object.assign(entry.state,{status:'completed',pause_reason:null,updated_at:'2026-10-28T12:00:00Z'});
 const f=fixture([entry]);await f.bridge.notify();
 Object.assign(entry.state,{status:'failed',session_id:'old-session',updated_at:'2026-10-27T12:00:00Z',last_error:'Invalid API key'});
 await f.bridge.notify();assert.equal(f.sent.length,0);assert.deepEqual(f.state.notifications?.pending,{});
});


test('a new fast failure alerts even when first observed after its worker exits',async()=>{
 let now=new Date('2026-10-28T12:00:00Z');const f=fixture([],()=>now);await f.bridge.notify();
 now=new Date('2026-10-28T12:05:00Z');const entry=task();Object.assign(entry.state,{status:'failed',pause_reason:null,updated_at:now.toISOString()});
 f.tasks.push(entry);await f.bridge.notify();assert.equal(f.sent.length,1);assert.match(f.sent[0]!,/stopped after automatic retries/);
});


test('successful replies react to the incoming message, while unauthorized and stale replies do not',async()=>{
 const f=fixture();await f.bridge.notify();const reply=f.reply(501);reply.message!.message_id=987;
 await f.bridge.receive(reply);await f.bridge.receive(reply);
 assert.deepEqual(f.reactions,[987]);assert.equal(f.sent.length,1);assert.equal(f.resumed.length,1);
 const unauthorized=f.reply(502);unauthorized.message!.from!.id=777;await f.bridge.receive(unauthorized);
 f.tasks[0]!.state.session_id='new-session';await f.bridge.receive(f.reply(503));
 assert.deepEqual(f.reactions,[987]);
});

test('reaction failures do not replay a successful resume or leave the update unacknowledged',async()=>{
 const entry=task();let comments=0,resumes=0,reactions=0;
 const state:BridgeState={offset:0,seen:{},messages:{'1':{key:entry.key,session:entry.state.session_id,question:true}},pending:{}};
 const b=new TelegramBridge({send:async()=>1,updates:async()=>[],react:async()=>{reactions++;throw new Error('Telegram unavailable');}},
 {tasks:async()=>[entry],comment:async()=>{comments++;return 100;},resume:async()=>{resumes++;return true;}},state,{chatId:123,userId:456},async()=>{});
 const reply=fixture().reply(504);await b.receive(reply);await b.receive(reply);
 assert.equal(state.offset,505);assert.equal(comments,1);assert.equal(resumes,1);assert.equal(reactions,1);
});


test('a reply that cannot resume keeps its explanation and receives no success reaction',async()=>{
 const entry=task(),sent:string[]=[],reactions:number[]=[];
 const state:BridgeState={offset:0,seen:{},messages:{'1':{key:entry.key,session:entry.state.session_id,question:true}},pending:{}};
 const b=new TelegramBridge({send:async text=>{sent.push(text);return 2;},updates:async()=>[],react:async id=>{reactions.push(id);}},
 {tasks:async()=>[entry],comment:async()=>100,resume:async()=>false},state,{chatId:123,userId:456},async()=>{});
 await b.receive(fixture().reply(505));assert.equal(sent.length,1);assert.match(sent[0]!,/needs manual attention/);assert.deepEqual(reactions,[]);
});
