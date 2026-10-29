import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CloudflareAttachmentStorage, loadAttachmentStorage } from './attachmentStorage.js';

const image = { bytes: Buffer.from([255, 216, 255]), extension: 'jpg' as const };
const key = 'a'.repeat(64);

test('shared Cloudflare uploads verify public content and recover a lost response without GitHub writes', async () => {
  const original = globalThis.fetch;
  let saved = false, fail = true, uploads = 0;
  globalThis.fetch = async (input, init) => {
    assert.match(String(input), /^https:\/\/attachments.test\/attachments\//);
    if (init?.method === 'POST') {
      uploads++;
      assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer private-upload-token');
      assert.equal(init.redirect, 'error');
      saved = true;
      if (fail) { fail = false; throw new Error('lost response with private-upload-token'); }
      return Response.json({ path: `telegram/${key}.jpg` });
    }
    assert.equal(new Headers(init?.headers).get('Authorization'), null, 'public verification never sends credentials');
    return new Response(saved ? Uint8Array.from(image.bytes).buffer : null, { status: saved ? 200 : 404 });
  };
  try {
    const storage = new CloudflareAttachmentStorage('https://attachments.test', 'private-upload-token');
    const url = await storage.store(key, image);
    assert.equal(url, `https://attachments.test/attachments/telegram/${key}.jpg`);
    assert.equal(await storage.store(key, image), url);
    assert.equal(uploads, 2, 'server safely accepts replay of the same object ID');
    globalThis.fetch = async () => { throw new Error('private-upload-token'); };
    await assert.rejects(storage.store(key, image), (error: Error) => { assert.doesNotMatch(error.message, /private-upload-token/); return true; });
  } finally { globalThis.fetch = original; }
});

test('attachment configuration keeps the upload token in an owner-only file and permits text-only operation', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-attachment-config-'));
  try {
    const config = path.join(dir, 'attachments.json'), token = path.join(dir, 'upload-token');
    assert.equal(await loadAttachmentStorage(config), null);
    await fs.writeFile(token, 'a'.repeat(48), { mode: 0o600 });
    await fs.writeFile(config, JSON.stringify({ url: 'https://attachments.test', tokenFile: 'upload-token' }));
    assert.ok(await loadAttachmentStorage(config));
    await fs.chmod(token, 0o644);
    await assert.rejects(loadAttachmentStorage(config), /owner-only/);
    await fs.chmod(token, 0o600);
    await fs.writeFile(config, JSON.stringify({ url: 'https://user:secret@attachments.test', tokenFile: 'upload-token' }));
    await assert.rejects(loadAttachmentStorage(config), /HTTPS origin/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
