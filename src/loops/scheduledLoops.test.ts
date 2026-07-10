import assert from 'node:assert/strict';
import test from 'node:test';

import { dueScheduledLoops } from './scheduledLoops.js';

const loops = [
  { id: 'daily-quality', enabled: true, interval_ms: 86_400_000, prompt: 'Run quality loop.', provider: null },
  { id: 'weekly-evolve', enabled: false, interval_ms: 604_800_000, prompt: 'Run evolve loop.', provider: 'codex' },
];

test('runs enabled loops immediately when no durable trigger exists', () => {
  assert.deepEqual(dueScheduledLoops(loops, new Map(), Date.parse('2026-07-10T12:00:00Z')).map((loop) => loop.id), ['daily-quality']);
});

test('uses the last durable trigger to avoid duplicate runs after restart', () => {
  const now = Date.parse('2026-07-10T12:00:00Z');
  const recent = new Map([['daily-quality', new Date(now - 60_000).toISOString()]]);
  assert.deepEqual(dueScheduledLoops(loops, recent, now), []);

  const expired = new Map([['daily-quality', new Date(now - 86_400_001).toISOString()]]);
  assert.deepEqual(dueScheduledLoops(loops, expired, now).map((loop) => loop.id), ['daily-quality']);
});
