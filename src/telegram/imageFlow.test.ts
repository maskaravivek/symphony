import assert from 'node:assert/strict';
import test from 'node:test';
import type { TelegramUpdate, TelegramApi } from './api.js';
import { TelegramBridge, type BridgeBackend, type BridgeState, type BridgeTask } from './bridge.js';
import type { RunState } from '../status/runState.js';
import { MAX_IMAGE_BYTES } from './media.js';

function fixture() {
  const state: BridgeState = { offset: 0, seen: {}, messages: {}, pending: {} };
  const sent: string[] = [], downloads: string[] = [], resumes: string[] = [];
  const stored = new Map<string, string>(), comments = new Map<string, string>();
  const created: Array<{ repo: string; text: string; images?: string }> = [];
  const tasks: BridgeTask[] = [];
  let uploadFailure = false, sendFailure = false;
  let durable = JSON.stringify(state);
  const backend: BridgeBackend = {
    tasks: async () => tasks,
    repositories: async () => [{ id: 'pdfkit.app', repository: 'owner/pdfkit.app', aliases: ['pdfkit'] }],
    findIntake: async () => created.length ? { number: 42, title: created[0]!.text, url: 'https://github.test/issues/42' } : null,
    createIntake: async (repo, text, _marker, images) => {
      created.push({ repo, text, images }); return { number: 42, title: text, url: 'https://github.test/issues/42' };
    },
    storeImage: async (repo, key, image) => {
      if (uploadFailure) throw new Error('upload unavailable');
      assert.equal(repo, 'pdfkit.app');
      assert.match(key, /^[a-f0-9]{64}$/);
      const url = `https://attachments.test/attachments/telegram/${key}.${image.extension}`;
      stored.set(key, url); return url;
    },
    capturedComment: async (repo, number, marker, text) => { assert.equal(repo, 'pdfkit.app'); assert.equal(number, 42); comments.set(marker, text); return 101; },
    comment: async (_task, marker, text) => { comments.set(marker, text); return 101; },
    resume: async task => { resumes.push(task.key); return true; },
  };
  const api: TelegramApi = {
    updates: async () => [], send: async text => { if (sendFailure) throw new Error('send failed'); sent.push(text); return 1000 + sent.length; },
    downloadImage: async id => { downloads.push(id); return { bytes: Buffer.from([0xff, 0xd8, 0xff]), extension: 'jpg' }; },
  };
  const bridgeFor = (state: BridgeState) => new TelegramBridge(api, backend, state, { chatId: 123, userId: 456 }, async () => { durable = JSON.stringify(state); });
  const update = (id: number, caption?: string, replyId?: number, group?: string): TelegramUpdate => ({ update_id: id, message: {
    message_id: id, from: { id: 456 }, chat: { id: 123, type: 'private' }, caption,
    photo: [{ file_id: `file${id}`, file_unique_id: `unique${id}`, width: 500, height: 500 }],
    reply_to_message: replyId ? { message_id: replyId } : undefined, media_group_id: group,
  } });
  return { state, sent, downloads, stored, comments, created, tasks, resumes, update, bridge: bridgeFor(state), bridgeFor,
    restored: () => JSON.parse(durable) as BridgeState,
    uploadFailure: (value: boolean) => { uploadFailure = value; }, sendFailure: (value: boolean) => { sendFailure = value; } };
}

test('photo caption creates gated capture, and image replies before the first run append issue context', async () => {
  const f = fixture();
  await f.bridge.receive(f.update(1, '/new pdfkit Fix this layout'));
  assert.equal(f.created[0]!.text, 'Fix this layout');
  assert.match(f.created[0]!.images!, /!\[Telegram image 1\]\(https:\/\/attachments.test/);
  assert.doesNotMatch(f.created[0]!.images!, /file\/bot|file1|unique1/);
  assert.equal(f.state.messages['1001']!.key, 'pdfkit.app#42');
  await f.bridge.receive(f.update(2, undefined, 1001));
  assert.equal(f.comments.size, 1);
  assert.match([...f.comments.values()][0]!, /Image context supplied.*\n\n### Images/s);
  assert.equal(f.resumes.length, 0, 'an unstarted capture must retain its grooming gate');
  await f.bridge.receive(f.update(2, undefined, 1001));
  assert.equal(f.comments.size, 1);
  assert.equal(f.stored.size, 2);
});

test('albums survive restart, accept a caption on a later photo, and create one capture with all images', async () => {
  const f = fixture();
  await f.bridge.receive(f.update(1, undefined, undefined, 'album'));
  await f.bridge.receive(f.update(2, '/new pdfkit Fix these screens', undefined, 'album'));
  assert.equal(f.created.length, 0);
  assert.equal(f.downloads.length, 0);
  const state = f.restored();
  state.mediaGroups!['album']!.updatedAt = Date.now() - 3000;
  const bridge = f.bridgeFor(state);
  await bridge.notify();
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0]!.images!.match(/!\[Telegram image/g)!.length, 2);
  assert.equal(state.messages['1']!.key, 'pdfkit.app#42');
  assert.equal(state.messages['2']!.key, 'pdfkit.app#42');
  await bridge.notify();
  assert.equal(f.created.length, 1);
  // A delayed extra photo in the same album attaches to the established issue.
  await bridge.receive(f.update(3, undefined, undefined, 'album'));
  assert.equal(f.created.length, 1);
  assert.equal(f.comments.size, 1);
});

test('authorization, routing, size and stale-question checks happen before any downloads or uploads', async () => {
  const f = fixture();
  const unauthorized = f.update(1, '/new pdfkit Wrong user'); unauthorized.message!.from!.id = 999;
  await f.bridge.receive(unauthorized);
  await f.bridge.receive(f.update(2));
  await f.bridge.receive(f.update(3, '/new unavailable Fix'));
  const tooLarge = f.update(4, '/new pdfkit Fix'); tooLarge.message!.photo![0]!.file_size = MAX_IMAGE_BYTES + 1;
  await f.bridge.receive(tooLarge);
  f.state.messages['90'] = { key: 'pdfkit.app#42', session: 'old', question: true };
  await f.bridge.receive(f.update(5, 'Answer', 90));
  assert.equal(f.downloads.length, 0);
  assert.equal(f.stored.size, 0);
  assert.equal(f.created.length, 0);
  assert.match(f.sent.at(-1)!, /earlier run/);
  assert.equal(f.state.offset, 6);
});

test('an interrupted upload retries preparation, while a lost acknowledgment does not recreate the issue', async () => {
  const f = fixture();
  f.uploadFailure(true);
  await assert.rejects(f.bridge.receive(f.update(1, '/new pdfkit Fix')));
  assert.equal(f.state.offset, 0);
  assert.equal(f.created.length, 0);
  f.uploadFailure(false);
  f.sendFailure(true);
  await assert.rejects(f.bridgeFor(f.restored()).receive(f.update(1, '/new pdfkit Fix')));
  assert.equal(f.created.length, 1);
  f.sendFailure(false);
  await f.bridgeFor(f.restored()).receive(f.update(1, '/new pdfkit Fix'));
  assert.equal(f.created.length, 1);
  assert.equal(f.stored.size, 1);
});

test('image replies to running tasks are deferred and paused questions resume through the existing flow', async () => {
  const f = fixture();
  const state = { issue_number: 42, session_id: 'session', status: 'agent-running', last_seen_comment_id: 0 } as RunState;
  f.tasks.push({ key: 'pdfkit.app#42', state, lastMessage: '' });
  f.state.messages['99'] = { key: 'pdfkit.app#42', session: 'session', question: false };
  await f.bridge.receive(f.update(1, 'Please match this screenshot', 99));
  assert.equal(f.comments.size, 1);
  assert.ok(f.state.pending['pdfkit.app#42']);
  assert.equal(f.resumes.length, 0);
  state.status = 'paused'; state.pause_reason = 'needs-info';
  f.state.messages['98'] = { key: 'pdfkit.app#42', session: 'session', question: true };
  await f.bridge.receive(f.update(2, 'This is the target design', 98));
  assert.equal(f.comments.size, 2);
  assert.deepEqual(f.resumes, ['pdfkit.app#42']);
});


test('image documents preserve originals and unsupported documents produce a useful response', async () => {
  const f = fixture();
  const image = f.update(1, '/new pdfkit Fix screenshot');
  delete image.message!.photo;
  image.message!.document = { file_id: 'document', file_unique_id: 'original', mime_type: 'image/png' };
  await f.bridge.receive(image);
  assert.deepEqual(f.downloads, ['document']);
  assert.equal(f.created.length, 1);
  const unsupported = f.update(2, '/new pdfkit Fix video');
  delete unsupported.message!.photo;
  unsupported.message!.document = { file_id: 'video', file_unique_id: 'video', mime_type: 'video/mp4' };
  await f.bridge.receive(unsupported);
  assert.match(f.sent.at(-1)!, /not supported/);
  assert.deepEqual(f.downloads, ['document']);
  assert.equal(f.created.length, 1);
});
