import assert from 'node:assert/strict';
import test from 'node:test';
import { TelegramBotApi } from './api.js';
import { imageExtension, messageImage, MAX_IMAGE_BYTES } from './media.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS6kAAAAASUVORK5CYII=', 'base64');

test('chooses the largest photo and accepts image documents only', () => {
  assert.equal(messageImage({ message_id: 1, chat: { id: 1, type: 'private' }, photo: [
    { file_id: 'large', file_unique_id: 'large', width: 1000, height: 1000 },
    { file_id: 'small', file_unique_id: 'small', width: 100, height: 100 },
  ] })!.file_id, 'large');
  assert.throws(() => messageImage({ message_id: 1, chat: { id: 1, type: 'private' }, document: { file_id: 'svg', file_unique_id: 'svg', mime_type: 'image/svg+xml' } }), /not supported/);
  assert.equal(imageExtension(png), 'png');
  assert.throws(() => imageExtension(Buffer.from('<script>bad</script>')), /not a supported image/);
});

test('downloads Telegram images without exposing token URLs; validates paths, bytes and actual size', async () => {
  const original = globalThis.fetch;
  let path = 'photos/test.png';
  let size = png.length;
  let content: Uint8Array = png;
  let fail = false;
  let downloads = 0;
  globalThis.fetch = async (input, options) => {
    if (String(input).endsWith('/getFile')) return Response.json({ ok: true, result: { file_path: path, file_size: size } });
    downloads++;
    assert.equal(options?.redirect, 'error');
    if (fail) throw new Error('https://api.telegram.org/file/bot123:private-secret/secret');
    return new Response(Uint8Array.from(content).buffer);
  };
  try {
    const api = new TelegramBotApi('123:private-secret', 1);
    assert.deepEqual(await api.downloadImage('image'), { bytes: png, extension: 'png' });
    path = '../../outside';
    await assert.rejects(api.downloadImage('bad'), /invalid file path/);
    assert.equal(downloads, 1);
    path = 'photos/test.png'; size = MAX_IMAGE_BYTES + 1;
    await assert.rejects(api.downloadImage('large'), /8 MiB/);
    assert.equal(downloads, 1);
    size = 1; content = new Uint8Array(MAX_IMAGE_BYTES + 1);
    await assert.rejects(api.downloadImage('misleading-size'), /8 MiB/);
    content = Buffer.from('not an image');
    await assert.rejects(api.downloadImage('wrong-mime'), /not a supported image/);
    fail = true;
    await assert.rejects(api.downloadImage('network'), (error: Error) => {
      assert.doesNotMatch(error.message, /private-secret|https:/); return true;
    });
  } finally { globalThis.fetch = original; }
});
