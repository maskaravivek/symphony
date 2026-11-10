import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ArtifactAccessError, readArtifactChunk, tailArtifact, type ArtifactAccess } from './artifacts.js';

async function setup(): Promise<{ root: string; outside: string; access: ArtifactAccess }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-artifacts-'));
  const root = path.join(base, 'workspaces');
  const outside = path.join(base, 'outside');
  await fs.mkdir(path.join(root, 'slot', '.symphony'), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  return { root, outside, access: { allowedRoots: [root] } };
}

async function rejectsWith(promise: Promise<unknown>, status: number): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ArtifactAccessError, `expected ArtifactAccessError, got ${String(error)}`);
    assert.equal(error.status, status);
    return true;
  });
}

test('readArtifactChunk reads bounded chunks with kind, mtime and truncation', async () => {
  const { root, access } = await setup();
  const file = path.join(root, 'slot', '.symphony', 'prompt.md');
  await fs.writeFile(file, 'abcdefghij');

  const first = await readArtifactChunk(access, file, { limit: 4 });
  assert.equal(first.content, 'abcd');
  assert.equal(first.offset, 0);
  assert.equal(first.next_offset, 4);
  assert.equal(first.size, 10);
  assert.equal(first.truncated, true);
  assert.equal(first.kind, 'markdown');
  assert.equal(first.path, file);
  assert.ok(first.mtime && !Number.isNaN(Date.parse(first.mtime)));

  const rest = await readArtifactChunk(access, file, { offset: first.next_offset });
  assert.equal(rest.content, 'efghij');
  assert.equal(rest.truncated, false);

  const past = await readArtifactChunk(access, file, { offset: 50 });
  assert.equal(past.content, '');
  assert.equal(past.truncated, false);

  for (const [name, kind] of [['a.jsonl', 'jsonl'], ['v.json', 'json'], ['x.log', 'text']] as const) {
    const p = path.join(root, name);
    await fs.writeFile(p, '{}');
    assert.equal((await readArtifactChunk(access, p, {})).kind, kind);
  }
});

test('readArtifactChunk caps the limit at 1 MiB and validates options', async () => {
  const { root, access } = await setup();
  const file = path.join(root, 'big.txt');
  await fs.writeFile(file, Buffer.alloc(1024 * 1024 + 10, 'a'));
  const chunk = await readArtifactChunk(access, file, { limit: 10 * 1024 * 1024 });
  assert.equal(chunk.next_offset, 1024 * 1024);
  assert.equal(chunk.truncated, true);
  const def = await readArtifactChunk(access, file, {});
  assert.equal(def.next_offset, 64 * 1024);
  await rejectsWith(readArtifactChunk(access, file, { offset: -1 }), 400);
  await rejectsWith(readArtifactChunk(access, file, { limit: 0 }), 400);
});

test('path safety: relative, outside root, symlink escape, missing, directory', async () => {
  const { root, outside, access } = await setup();
  const secret = path.join(outside, 'secret.txt');
  await fs.writeFile(secret, 'secret');
  const link = path.join(root, 'slot', 'escape.txt');
  await fs.symlink(secret, link);
  const insideTarget = path.join(root, 'slot', 'real.txt');
  await fs.writeFile(insideTarget, 'ok');
  const insideLink = path.join(root, 'slot', 'alias.txt');
  await fs.symlink(insideTarget, insideLink);

  await rejectsWith(readArtifactChunk(access, 'slot/real.txt', {}), 400);
  await rejectsWith(readArtifactChunk(access, secret, {}), 403);
  await rejectsWith(readArtifactChunk(access, link, {}), 403);
  await rejectsWith(readArtifactChunk(access, path.join(root, 'slot', '..', '..', 'outside', 'secret.txt'), {}), 403);
  // A sibling sharing the root's name as a prefix must not pass the prefix check.
  const sibling = `${root}-evil`;
  await fs.mkdir(sibling);
  await fs.writeFile(path.join(sibling, 'x.txt'), 'x');
  await rejectsWith(readArtifactChunk(access, path.join(sibling, 'x.txt'), {}), 403);
  await rejectsWith(readArtifactChunk(access, path.join(root, 'slot', 'missing.txt'), {}), 404);
  await rejectsWith(readArtifactChunk(access, path.join(outside, 'missing.txt'), {}), 403);
  await rejectsWith(readArtifactChunk(access, path.join(root, 'slot'), {}), 400);
  await rejectsWith(tailArtifact(access, link, {}), 403);

  assert.equal((await readArtifactChunk(access, insideLink, {})).content, 'ok');
  // Roots with a trailing separator behave the same.
  assert.equal((await readArtifactChunk({ allowedRoots: [`${root}${path.sep}`] }, insideTarget, {})).content, 'ok');
});

test('tailArtifact returns the last bytes of a small file', async () => {
  const { root, access } = await setup();
  const file = path.join(root, 'agent.stdout.log');
  await fs.writeFile(file, 'line one\nline two\nline three\n');

  const whole = await tailArtifact(access, file, {});
  assert.equal(whole.offset, 0);
  assert.equal(whole.content, 'line one\nline two\nline three\n');
  assert.equal(whole.truncated, false);

  const tail = await tailArtifact(access, file, { bytes: 11 });
  assert.equal(tail.content, 'line three\n');
  assert.equal(tail.offset, whole.size - 11);
  assert.equal(tail.next_offset, whole.size);
  assert.equal(tail.truncated, false);
});

test('multibyte characters are never split across chunk boundaries', async () => {
  const { root, access } = await setup();
  const file = path.join(root, 'accents.txt');
  const text = 'é'.repeat(50); // 100 bytes
  await fs.writeFile(file, text);

  let offset = 0;
  let assembled = '';
  for (let guard = 0; guard < 100 && offset < 100; guard += 1) {
    const chunk = await readArtifactChunk(access, file, { offset, limit: 7 });
    assert.ok(!chunk.content.includes('�'), `replacement character at offset ${offset}`);
    assert.equal(chunk.next_offset % 2, 0);
    assert.ok(chunk.next_offset > offset);
    assembled += chunk.content;
    offset = chunk.next_offset;
  }
  assert.equal(assembled, text);

  // A limit smaller than one character still makes progress.
  const tiny = await readArtifactChunk(access, file, { limit: 1 });
  assert.equal(tiny.content, 'é');
  assert.equal(tiny.next_offset, 2);

  // A tail that starts mid-character skips to the next character.
  const tail = await tailArtifact(access, file, { bytes: 5 });
  assert.equal(tail.content, 'éé');
  assert.equal(tail.offset, 96);
});
