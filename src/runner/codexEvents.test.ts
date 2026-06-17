import assert from 'node:assert/strict';
import test from 'node:test';

import { extractCodexThreadId } from './codexEvents.js';

test('extracts thread id from thread.started JSONL events', () => {
  const line = JSON.stringify({ type: 'thread.started', thread_id: 'thread-123' });

  assert.equal(extractCodexThreadId(line), 'thread-123');
});

test('extracts nested thread.started JSONL events', () => {
  const line = JSON.stringify({ msg: { event: 'thread.started', id: 'thread-nested' } });

  assert.equal(extractCodexThreadId(line), 'thread-nested');
});

test('ignores malformed JSONL lines', () => {
  assert.equal(extractCodexThreadId('not json'), null);
});
