// Pure hash routing helpers. No DOM access; safe to import from node tests.

const ROUTES = [
  { name: 'overview', pattern: [] },
  { name: 'repo', pattern: ['repo', ':repoId'] },
  { name: 'task-loop', pattern: ['task', ':repoId', 'loop', ':loopId'] },
  { name: 'task', pattern: ['task', ':repoId', ':issue'] },
  { name: 'history', pattern: ['history'] },
  { name: 'events', pattern: ['events'] },
];

function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** "#/repo/x?q=a" → { path: "/repo/x", query: { q: "a" } } */
export function parseHash(hash) {
  let raw = String(hash ?? '');
  if (raw.startsWith('#')) raw = raw.slice(1);
  const qIndex = raw.indexOf('?');
  const pathPart = qIndex >= 0 ? raw.slice(0, qIndex) : raw;
  const queryPart = qIndex >= 0 ? raw.slice(qIndex + 1) : '';
  const path = `/${pathPart.replace(/^\/+/, '').replace(/\/+$/, '')}`;
  const query = {};
  for (const [k, v] of new URLSearchParams(queryPart)) query[k] = v;
  return { path, query };
}

export function matchRoute(path) {
  const segments = String(path ?? '/').split('/').filter(Boolean).map(safeDecode);
  for (const route of ROUTES) {
    if (route.pattern.length !== segments.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < route.pattern.length; i++) {
      const p = route.pattern[i];
      if (p.startsWith(':')) params[p.slice(1)] = segments[i];
      else if (p !== segments[i]) { ok = false; break; }
    }
    if (!ok) continue;
    if (route.name === 'task' && !/^\d+$/.test(params.issue)) continue;
    if (route.name === 'task') params.issue = Number(params.issue);
    return { name: route.name, params };
  }
  return { name: 'not-found', params: { path } };
}

/** Build "#/path?k=v", dropping empty values. */
export function buildHash(path, query = {}) {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v == null || v === '' || v === false) continue;
    search.set(k, String(v));
  }
  const qs = search.toString();
  const p = path.startsWith('/') ? path : `/${path}`;
  return `#${p}${qs ? `?${qs}` : ''}`;
}

const enc = encodeURIComponent;

export function repoHref(repoId) {
  return `#/repo/${enc(repoId)}`;
}

/** TaskKey is `${repo}/${issue}` or `${repo}/loop/${loopId}`. */
export function splitTaskKey(taskKey) {
  const key = String(taskKey ?? '');
  const loop = key.match(/^(.+?)\/loop\/(.+)$/);
  if (loop) return { repoId: loop[1], loopId: loop[2], issue: null };
  const idx = key.lastIndexOf('/');
  if (idx <= 0) return null;
  const issue = key.slice(idx + 1);
  if (!/^\d+$/.test(issue)) return null;
  return { repoId: key.slice(0, idx), loopId: null, issue: Number(issue) };
}

export function taskHref(taskKey) {
  const parts = splitTaskKey(taskKey);
  if (!parts) return null;
  if (parts.loopId != null) return `#/task/${enc(parts.repoId)}/loop/${enc(parts.loopId)}`;
  return `#/task/${enc(parts.repoId)}/${parts.issue}`;
}

export function taskApiPath(params) {
  if (params.loopId != null) return `/api/tasks/${enc(params.repoId)}/loop/${enc(params.loopId)}`;
  return `/api/tasks/${enc(params.repoId)}/${params.issue}`;
}

/** Same page (route + params) regardless of query. */
export function sameRoute(a, b) {
  if (!a || !b || a.name !== b.name) return false;
  const ka = Object.keys(a.params);
  if (ka.length !== Object.keys(b.params).length) return false;
  return ka.every((k) => a.params[k] === b.params[k]);
}
