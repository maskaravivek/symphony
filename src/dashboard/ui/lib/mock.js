// Mock-mode helpers: map API URLs to fixture files and shift fixture
// timestamps so mocks always look current. Pure; safe for node tests.

/** Every fixture is written relative to this instant. */
export const MOCK_ANCHOR = '2026-11-10T15:00:00.000Z';

const slug = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '_');

/**
 * Candidate fixture URLs for an API path (first that exists wins).
 * `apiUrl` is a path with an optional query string, e.g. `/api/events?before=10`.
 */
export function mockCandidates(apiUrl, base = '/ui/mock/') {
  const url = new URL(apiUrl, 'http://mock.local');
  const parts = url.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
  const q = url.searchParams;
  const files = [];
  if (parts[0] !== 'api') return [];
  const route = parts[1];
  if (route === 'overview') files.push('overview.json');
  else if (route === 'repos' && parts[2]) files.push(`repo-${slug(parts[2])}.json`, 'repo.json');
  else if (route === 'tasks' && parts[3] === 'loop' && parts[4]) files.push(`task-${slug(parts[2])}-loop-${slug(parts[4])}.json`, 'task-loop.json');
  else if (route === 'tasks' && parts[3]) files.push(`task-${slug(parts[2])}-${slug(parts[3])}.json`, 'task.json');
  else if (route === 'history') files.push(`history-${q.get('days') ?? '28'}.json`, 'history.json');
  else if (route === 'events') files.push(q.get('before') ? 'events-older.json' : 'events.json');
  else if (route === 'agent-log') files.push(Number(q.get('after') ?? 0) > 0 ? 'agent-log-more.json' : 'agent-log.json');
  else if (route === 'artifact') {
    const path = q.get('path') ?? '';
    const fileName = path.split('/').pop();
    if (fileName) files.push(`artifact-${slug(fileName)}.json`);
    files.push('artifact.json');
  } else if (route === 'board') files.push('board.json');
  return files.map((f) => `${base}${f}`);
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Return a deep copy with every ISO timestamp string shifted by deltaMs. */
export function rebaseTimestamps(value, deltaMs) {
  if (typeof value === 'string') {
    if (!ISO_RE.test(value)) return value;
    const t = Date.parse(value);
    return Number.isFinite(t) ? new Date(t + deltaMs).toISOString() : value;
  }
  if (Array.isArray(value)) return value.map((v) => rebaseTimestamps(v, deltaMs));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = rebaseTimestamps(v, deltaMs);
    return out;
  }
  return value;
}
