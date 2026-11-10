// Live updates: EventSource on /api/stream with a debounced refresh, falling
// back to 15s polling. Polling pauses while the tab is hidden.

import { isMockMode, onFetchOutcome } from './api.js';

const DEBOUNCE_MS = 500;
const POLL_MS = 15000;
const LIVE_REFRESH_MS = 5 * 60_000;
const RECONNECT_MS = 60000;

/**
 * startLive({ onChange(changeEvent|null), onState(state) })
 * state: 'connecting' | 'live' | 'polling' | 'disconnected' | 'mock'
 */
export function startLive({ onChange, onState }) {
  let state = 'connecting';
  let source = null;
  let pollTimer = null;
  let reconnectTimer = null;
  let debounceTimer = null;
  let pending = null;
  let lastFetchOk = true;
  let hiddenChange = false;

  const setState = (next) => {
    if (next === state) return;
    state = next;
    onState(state);
  };
  const effectiveState = () => {
    if (isMockMode()) return 'mock';
    if (!lastFetchOk) return 'disconnected';
    return source && source.readyState === 1 ? 'live' : pollTimer ? 'polling' : 'connecting';
  };

  onFetchOutcome(({ ok }) => {
    lastFetchOk = ok;
    setState(effectiveState());
  });

  const fire = (event) => {
    // Coalesce bursts; remember whether any event was repo-wide.
    if (pending === null) pending = event;
    else if (pending && event && pending.repo_id !== event.repo_id) pending = { ...event, repo_id: null };
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const evt = pending;
      pending = null;
      if (!document.hidden) onChange(evt);
      else hiddenChange = true;
    }, DEBOUNCE_MS);
  };

  const startPolling = () => {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      if (!document.hidden) onChange(null);
    }, POLL_MS);
    setState(effectiveState());
  };
  const stopPolling = () => {
    clearInterval(pollTimer);
    pollTimer = null;
  };

  const connect = () => {
    if (typeof EventSource === 'undefined') {
      startPolling();
      return;
    }
    try {
      source = new EventSource('/api/stream');
    } catch {
      source = null;
      startPolling();
      return;
    }
    source.addEventListener('open', () => {
      stopPolling();
      clearTimeout(reconnectTimer);
      setState(effectiveState());
    });
    source.addEventListener('change', (message) => {
      let data = null;
      try {
        data = JSON.parse(message.data);
      } catch {
        data = null;
      }
      fire(data);
    });
    source.addEventListener('error', () => {
      // Stop the browser's own fast retry loop; poll and try SSE again later.
      source?.close();
      source = null;
      startPolling();
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, RECONNECT_MS);
      setState(effectiveState());
    });
  };

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && (hiddenChange || pollTimer || !source)) {
      hiddenChange = false;
      onChange(null);
    }
  });

  if (isMockMode()) {
    setState('mock');
    onState('mock');
  } else {
    onState(state);
    connect();
    setInterval(() => {
      if (!pollTimer && !document.hidden) onChange(null);
    }, LIVE_REFRESH_MS);
  }

  return {
    get state() {
      return state;
    },
  };
}
