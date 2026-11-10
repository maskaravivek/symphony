import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHash, matchRoute, buildHash, taskHref, splitTaskKey, taskApiPath, repoHref, sameRoute } from './router.js';

test('parseHash splits path and query', () => {
  assert.deepEqual(parseHash(''), { path: '/', query: {} });
  assert.deepEqual(parseHash('#/'), { path: '/', query: {} });
  assert.deepEqual(parseHash('#/?q=pdf&repo=mdedit'), { path: '/', query: { q: 'pdf', repo: 'mdedit' } });
  assert.deepEqual(parseHash('#/repo/mdedit/'), { path: '/repo/mdedit', query: {} });
});

test('matchRoute resolves every route', () => {
  assert.deepEqual(matchRoute('/'), { name: 'overview', params: {} });
  assert.deepEqual(matchRoute('/repo/mdedit'), { name: 'repo', params: { repoId: 'mdedit' } });
  assert.deepEqual(matchRoute('/task/mdedit/1144'), { name: 'task', params: { repoId: 'mdedit', issue: 1144 } });
  assert.deepEqual(matchRoute('/task/docs-site/loop/weekly-link-check'), { name: 'task-loop', params: { repoId: 'docs-site', loopId: 'weekly-link-check' } });
  assert.deepEqual(matchRoute('/history'), { name: 'history', params: {} });
  assert.deepEqual(matchRoute('/events'), { name: 'events', params: {} });
  assert.equal(matchRoute('/task/mdedit/abc').name, 'not-found');
  assert.equal(matchRoute('/nope').name, 'not-found');
  assert.deepEqual(matchRoute('/repo/a%20b'), { name: 'repo', params: { repoId: 'a b' } });
});

test('buildHash drops empty values', () => {
  assert.equal(buildHash('/', { q: 'pdf', repo: '' }), '#/?q=pdf');
  assert.equal(buildHash('/history', {}), '#/history');
  assert.equal(buildHash('/', { q: 'a b' }), '#/?q=a+b');
});

test('task keys map to hrefs and API paths', () => {
  assert.deepEqual(splitTaskKey('mdedit/1144'), { repoId: 'mdedit', loopId: null, issue: 1144 });
  assert.deepEqual(splitTaskKey('mdedit/loop/daily-steward'), { repoId: 'mdedit', loopId: 'daily-steward', issue: null });
  assert.equal(splitTaskKey('mdedit'), null);
  assert.equal(taskHref('mdedit/1144'), '#/task/mdedit/1144');
  assert.equal(taskHref('mdedit/loop/daily-steward'), '#/task/mdedit/loop/daily-steward');
  assert.equal(taskHref(null), null);
  assert.equal(taskApiPath({ repoId: 'mdedit', issue: 1144 }), '/api/tasks/mdedit/1144');
  assert.equal(taskApiPath({ repoId: 'mdedit', loopId: 'daily-steward' }), '/api/tasks/mdedit/loop/daily-steward');
  assert.equal(repoHref('atlas-api'), '#/repo/atlas-api');
  // round trip
  const { path } = parseHash(taskHref('docs-site/loop/weekly-link-check'));
  assert.equal(matchRoute(path).name, 'task-loop');
});

test('sameRoute ignores query', () => {
  assert.ok(sameRoute(matchRoute('/repo/a'), matchRoute('/repo/a')));
  assert.ok(!sameRoute(matchRoute('/repo/a'), matchRoute('/repo/b')));
  assert.ok(!sameRoute(matchRoute('/'), matchRoute('/history')));
});
