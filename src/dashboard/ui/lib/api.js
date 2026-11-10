// Fetch wrapper with JSON error handling, per-navigation abort scopes and a
// mock mode (`?mock=1`) that reads fixtures from /ui/mock/.

import { mockCandidates, rebaseTimestamps, MOCK_ANCHOR } from './mock.js';

export class ApiError extends Error {
  constructor(message, status, url) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.url = url;
  }
}

export function isMockMode() {
  try {
    return new URLSearchParams(location.search).get('mock') === '1';
  } catch {
    return false;
  }
}

export function isAbort(error) {
  return error?.name === 'AbortError';
}

const listeners = new Set();
/** Subscribe to fetch outcomes: fn({ ok, status, url }). */
export function onFetchOutcome(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function report(outcome) {
  for (const fn of listeners) {
    try { fn(outcome); } catch { /* ignore */ }
  }
}

export function buildUrl(path, params) {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v == null || v === '' || v === false) continue;
    search.set(k, String(v));
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

async function readError(response) {
  try {
    const body = await response.json();
    if (body && typeof body.error === 'string') return body.error;
  } catch {
    // not JSON
  }
  return `${response.status} ${response.statusText || 'Request failed'}`.trim();
}

async function fetchMock(url, signal) {
  const candidates = mockCandidates(url);
  if (!candidates.length) throw new ApiError(`No mock fixture for ${url}`, 404, url);
  for (const candidate of candidates) {
    const response = await fetch(candidate, { signal, cache: 'no-store' });
    if (response.status === 404) continue;
    if (!response.ok) throw new ApiError(await readError(response), response.status, url);
    const data = await response.json();
    // Small delay so loading states are visible while developing.
    await new Promise((resolve) => setTimeout(resolve, 120));
    return rebaseTimestamps(data, Date.now() - Date.parse(MOCK_ANCHOR));
  }
  throw new ApiError(`No mock fixture for ${url} (tried ${candidates.join(', ')})`, 404, url);
}

export async function getJson(path, params, { signal } = {}) {
  const url = buildUrl(path, params);
  try {
    let data;
    if (isMockMode()) {
      data = await fetchMock(url, signal);
    } else {
      const response = await fetch(url, { signal, cache: 'no-store', headers: { accept: 'application/json' } });
      if (!response.ok) throw new ApiError(await readError(response), response.status, url);
      data = await response.json();
    }
    report({ ok: true, url });
    return data;
  } catch (error) {
    if (isAbort(error)) throw error;
    const apiError = error instanceof ApiError ? error : new ApiError(error?.message || 'Network error', 0, url);
    // 4xx means the server answered; only network/5xx count as disconnected.
    report({ ok: apiError.status >= 400 && apiError.status < 500, status: apiError.status, url });
    throw apiError;
  }
}

/** One scope per page navigation; abort() cancels all in-flight requests. */
export function createScope() {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    get(path, params) {
      return getJson(path, params, { signal: controller.signal });
    },
    abort() {
      controller.abort();
    },
    get aborted() {
      return controller.signal.aborted;
    },
  };
}

export function errorMessage(error) {
  if (!error) return '';
  if (error.status === 404) return `Not found: ${error.message}`;
  if (error.status === 0) return `Cannot reach the dashboard server (${error.message})`;
  return error.message || String(error);
}
