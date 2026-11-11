// Symphony dashboard entry: shell header, hash router, live refresh and
// keyboard shortcuts. Pages live in ./pages/, shared code in ./lib/.

import { h, render, onRequestRender, startTicker, timeEl } from './lib/dom.js';
import { parseHash, matchRoute, buildHash, sameRoute } from './lib/router.js';
import { createScope, getJson, isAbort, isMockMode, errorMessage } from './lib/api.js';
import { startLive } from './lib/live.js';
import { levelGlyph } from './lib/components.js';
import { absTime, duration } from './lib/format.js';
import { createOverviewPage } from './pages/overview.js';
import { createRepoPage } from './pages/repo.js';
import { createTaskPage } from './pages/task.js';
import { createHistoryPage } from './pages/history.js';
import { createEventsPage } from './pages/events.js';
import { createNotFoundPage } from './pages/notFound.js';

const PAGES = {
  overview: createOverviewPage,
  repo: createRepoPage,
  task: createTaskPage,
  'task-loop': createTaskPage,
  history: createHistoryPage,
  events: createEventsPage,
  'not-found': createNotFoundPage,
};

const headerEl = document.getElementById('app-header');
const mainEl = document.getElementById('main');
const footerEl = document.getElementById('app-footer');

const shell = {
  overview: null,
  overviewError: null,
  overviewPromise: null,
  overviewController: null,
  githubRefreshing: false,
  liveState: 'connecting',
};

let current = null; // { route, query, page, scope }

// ---------------------------------------------------------------------------
// Overview store (shared by the header and every page)
// ---------------------------------------------------------------------------

function loadOverview({ github = false } = {}) {
  if (shell.overviewPromise && !github) return shell.overviewPromise;
  shell.overviewController?.abort();
  const controller = new AbortController();
  shell.overviewController = controller;
  const promise = getJson('/api/overview', github ? { github: 1 } : null, { signal: controller.signal })
    .then((data) => {
      shell.overview = data;
      shell.overviewError = null;
      return data;
    })
    .catch((error) => {
      if (!isAbort(error)) shell.overviewError = error;
      throw error;
    })
    .finally(() => {
      if (shell.overviewPromise === promise) shell.overviewPromise = null;
      renderHeader();
      current?.page.onOverview?.();
    });
  shell.overviewPromise = promise;
  return promise;
}

async function refreshGithub() {
  if (shell.githubRefreshing) return;
  shell.githubRefreshing = true;
  renderHeader();
  try {
    await loadOverview({ github: true });
  } catch {
    // shown in the header
  } finally {
    shell.githubRefreshing = false;
    renderHeader();
  }
  // The overview page renders straight from the shell's overview.
  if (current && current.route.name !== 'overview') current.page.refresh({ at: new Date().toISOString(), scope: 'github', repo_id: null });
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function shortPath(path) {
  if (!path) return '';
  const parts = path.split('/').filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path;
}

function orchestratorChip() {
  const o = shell.overview?.orchestrator;
  if (!o) {
    if (shell.overviewError) return h('span.metric.orch', { title: errorMessage(shell.overviewError) }, levelGlyph('unknown'), h('span', 'Status unknown'));
    return h('span.metric.orch.muted', 'Checking…');
  }
  const details = [
    o.message,
    o.pid != null ? `pid ${o.pid}` : null,
    o.started_at ? `started ${absTime(o.started_at)}` : null,
    o.last_heartbeat_at ? `last heartbeat ${absTime(o.last_heartbeat_at)}` : null,
    o.polling_interval_ms ? `polls every ${duration(o.polling_interval_ms)}` : null,
  ].filter(Boolean).join('\n');
  let level;
  let label;
  if (o.shutting_down) { level = 'warn'; label = 'Shutting down'; }
  else if (o.alive) { level = o.level === 'ok' ? 'ok' : o.level; label = 'Alive'; }
  else { level = 'bad'; label = o.last_heartbeat_at ? 'Down' : 'No heartbeat'; }
  return h(
    'span.metric.orch',
    { class: `orch-${level}`, title: details || null },
    levelGlyph(level, { label: null }),
    h('span.orch-label', 'Orchestrator ', h('strong', label)),
    o.last_heartbeat_at ? h('span.muted', ' · ', timeEl(o.last_heartbeat_at)) : null,
  );
}

function capacityChip() {
  const ov = shell.overview;
  if (!ov) return null;
  const running = ov.orchestrator.running_agents ?? ov.totals.running;
  const max = ov.orchestrator.max_concurrent_agents ?? ov.repos.reduce((n, r) => n + (r.capacity.max_concurrent_agents ?? 0), 0);
  return h('span.metric', { title: `${running} agents running of ${max} allowed · ${ov.totals.queued} queued · ${ov.totals.retrying} retrying` }, h('strong', `${running} / ${max}`), ' running');
}

const LIVE_META = {
  connecting: { glyph: '◌', label: 'Connecting', title: 'Connecting to the live stream' },
  live: { glyph: '●', label: 'Live', title: 'Receiving live updates from /api/stream' },
  polling: { glyph: '◌', label: 'Polling', title: 'Live stream unavailable; refreshing every 15s' },
  disconnected: { glyph: '✕', label: 'Disconnected', title: 'Cannot reach the dashboard server; will keep retrying' },
  mock: { glyph: '◇', label: 'Mock data', title: 'Showing fixtures from /ui/mock (mock=1)' },
};

function liveIndicator() {
  const meta = LIVE_META[shell.liveState] ?? LIVE_META.connecting;
  return h('span.live', { class: `live-${shell.liveState}`, title: meta.title, role: 'status' }, h('span.live-glyph', { 'aria-hidden': 'true' }, meta.glyph), meta.label);
}

function navLink(href, label, active) {
  return h('a.nav-link', { href, 'aria-current': active ? 'page' : null }, label);
}

function renderHeader() {
  const name = current?.route.name;
  const source = shell.overview?.source;
  render(
    headerEl,
    h(
      'div.header-inner',
      h('a.brand', { href: '#/' }, h('span.brand-mark', { 'aria-hidden': 'true' }, 'S'), h('span.brand-name', 'Symphony')),
      source ? h('span.source', { title: `${source.kind === 'config' ? 'Config' : 'Workflow'}: ${source.path}` }, shortPath(source.path)) : null,
      h(
        'nav.nav',
        { 'aria-label': 'Primary' },
        navLink('#/', 'Overview', name === 'overview'),
        navLink('#/history', 'History', name === 'history' || name === 'events'),
      ),
      h(
        'div.header-status',
        orchestratorChip(),
        capacityChip(),
        liveIndicator(),
        h(
          'button.quiet-button',
          {
            type: 'button',
            disabled: shell.githubRefreshing || null,
            title: 'Refresh dashboard state and GitHub issue and pull request details',
            on: { click: refreshGithub },
          },
          shell.githubRefreshing ? 'Refreshing…' : 'Refresh dashboard',
        ),
      ),
    ),
  );
}

function renderFooter() {
  render(
    footerEl,
    h(
      'p.shortcuts',
      h('span', h('kbd', '/'), ' search'),
      h('span', h('kbd', 'g'), ' ', h('kbd', 'o'), ' overview'),
      h('span', h('kbd', 'g'), ' ', h('kbd', 'h'), ' history'),
      h('span', h('kbd', 'g'), ' ', h('kbd', 'e'), ' events'),
      h('span', h('kbd', 'Esc'), ' clear'),
      isMockMode() ? h('span.muted', 'Mock mode: data from /ui/mock') : null,
    ),
  );
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

function navigate(hash) {
  if (location.hash === hash) return;
  location.hash = hash;
}

function setQuery(patch) {
  if (!current) return;
  const query = { ...current.query, ...patch };
  for (const k of Object.keys(query)) if (query[k] == null || query[k] === '') delete query[k];
  current.query = query;
  const { path } = parseHash(location.hash);
  history.replaceState(history.state, '', `${location.pathname}${location.search}${buildHash(path, query)}`);
  current.page.onQuery?.();
  current.page.render();
}

function makeContext(route, scope) {
  return {
    params: route.params,
    get query() { return current?.query ?? {}; },
    setQuery,
    navigate,
    api: scope,
    loadOverview,
    get overview() { return shell.overview; },
    get overviewError() { return shell.overviewError; },
    draw(...children) { render(mainEl, ...children); },
    setTitle(title) { document.title = title ? `${title} · Symphony` : 'Symphony'; },
  };
}

function onRoute({ initial = false } = {}) {
  const { path, query } = parseHash(location.hash || '#/');
  const route = matchRoute(path);
  if (current && sameRoute(current.route, route)) {
    current.query = query;
    current.page.onQuery?.();
    current.page.render();
    return;
  }
  current?.scope.abort();
  current?.page.destroy?.();
  const scope = createScope();
  current = { route, query, scope, page: null };
  const page = PAGES[route.name](makeContext(route, scope));
  current.page = page;
  render(mainEl);
  page.render();
  renderHeader();
  if (!initial) {
    window.scrollTo(0, 0);
    mainEl.focus({ preventScroll: true });
  }
  if (route.name !== 'overview') loadOverview().catch(() => {});
  page.refresh(null);
}

function refreshAll(change) {
  loadOverview().catch(() => {});
  current?.page.refresh(change);
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

let gPending = false;
let gTimer = null;

function clearSearch(input) {
  if (!input || !input.value) return false;
  input.value = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

document.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target instanceof Element ? event.target : null;
  const typing = target?.closest('input, textarea, select, [contenteditable="true"]');
  if (event.key === 'Escape') {
    if (typing && target.matches('[data-page-search]')) {
      if (!clearSearch(target)) target.blur();
      event.preventDefault();
    } else if (!typing) {
      clearSearch(document.querySelector('[data-page-search]'));
    }
    gPending = false;
    return;
  }
  if (typing) return;
  if (event.key === '/') {
    const search = document.querySelector('[data-page-search]');
    if (search) {
      event.preventDefault();
      search.focus();
      search.select();
    }
    return;
  }
  if (gPending) {
    gPending = false;
    clearTimeout(gTimer);
    const dest = { o: '#/', h: '#/history', e: '#/events' }[event.key];
    if (dest) {
      event.preventDefault();
      navigate(dest);
    }
    return;
  }
  if (event.key === 'g') {
    gPending = true;
    clearTimeout(gTimer);
    gTimer = setTimeout(() => { gPending = false; }, 1200);
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

onRequestRender(() => {
  current?.page.render();
  renderHeader();
});
document.querySelector('.skip-link').addEventListener('click', (event) => {
  event.preventDefault();
  mainEl.focus();
});
window.addEventListener('hashchange', () => onRoute());
startTicker();
renderFooter();
startLive({
  onChange: refreshAll,
  onState(state) {
    shell.liveState = state;
    renderHeader();
  },
});
onRoute({ initial: true });
