import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mockCandidates, rebaseTimestamps, MOCK_ANCHOR } from './mock.js';

const mockDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mock');

test('API paths map to fixture candidates', () => {
  assert.deepEqual(mockCandidates('/api/overview'), ['/ui/mock/overview.json']);
  assert.deepEqual(mockCandidates('/api/overview?github=1'), ['/ui/mock/overview.json']);
  assert.deepEqual(mockCandidates('/api/repos/mdedit'), ['/ui/mock/repo-mdedit.json', '/ui/mock/repo.json']);
  assert.deepEqual(mockCandidates('/api/tasks/mdedit/1144'), ['/ui/mock/task-mdedit-1144.json', '/ui/mock/task.json']);
  assert.deepEqual(mockCandidates('/api/tasks/docs-site/loop/weekly-link-check'), ['/ui/mock/task-docs-site-loop-weekly-link-check.json', '/ui/mock/task-loop.json']);
  assert.deepEqual(mockCandidates('/api/history?days=7'), ['/ui/mock/history-7.json', '/ui/mock/history.json']);
  assert.deepEqual(mockCandidates('/api/events?repo=mdedit'), ['/ui/mock/events.json']);
  assert.deepEqual(mockCandidates('/api/events?before=9000'), ['/ui/mock/events-older.json']);
  assert.deepEqual(mockCandidates('/api/agent-log?path=/x/agent.jsonl'), ['/ui/mock/agent-log.json']);
  assert.deepEqual(mockCandidates('/api/agent-log?path=/x/agent.jsonl&after=100'), ['/ui/mock/agent-log-more.json']);
  assert.deepEqual(mockCandidates('/api/artifact?path=%2Fa%2Flast_message.md&offset=0'), ['/ui/mock/artifact-last_message.md.json', '/ui/mock/artifact.json']);
  assert.deepEqual(mockCandidates('/not-api'), []);
});

test('every route has a fallback fixture on disk', () => {
  for (const url of ['/api/overview', '/api/repos/any', '/api/tasks/any/1', '/api/tasks/any/loop/x', '/api/history', '/api/events', '/api/events?before=1', '/api/agent-log?path=a', '/api/agent-log?path=a&after=1', '/api/artifact?path=/z/unknown.txt']) {
    const found = mockCandidates(url, '').some((f) => fs.existsSync(path.join(mockDir, f)));
    assert.ok(found, url);
  }
});

test('fixtures are valid JSON with generated_at at the anchor where present', () => {
  for (const file of fs.readdirSync(mockDir).filter((f) => f.endsWith('.json'))) {
    const data = JSON.parse(fs.readFileSync(path.join(mockDir, file), 'utf8'));
    if (data.generated_at) assert.equal(data.generated_at, MOCK_ANCHOR, file);
  }
});

test('rebaseTimestamps shifts only ISO strings', () => {
  const input = { a: '2026-11-10T15:00:00.000Z', b: ['2026-11-10T14:00:00Z', 'not a date', 5], c: { d: null, e: '2026-11-10' } };
  const out = rebaseTimestamps(input, 60_000);
  assert.equal(out.a, '2026-11-10T15:01:00.000Z');
  assert.equal(out.b[0], '2026-11-10T14:01:00.000Z');
  assert.equal(out.b[1], 'not a date');
  assert.equal(out.b[2], 5);
  assert.equal(out.c.d, null);
  assert.equal(out.c.e, '2026-11-10');
  assert.equal(input.a, '2026-11-10T15:00:00.000Z');
});
