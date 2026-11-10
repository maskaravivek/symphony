// Task detail: header, commands, timeline, sessions and the artifact viewer.

import { h, timeEl, disclosure, ui, requestRender } from '../lib/dom.js';
import {
  section, asyncBody, dataTable, repoChip, taskLink, lifecycleTag, runStatusTag, loopStatusTag, reasonView, extLink, chip, tag,
  emptyBlock, timeline, copyButton, markdownView, longPre, tabList, tabPanel, errorBlock, loadingBlock,
  levelTag,
} from '../lib/components.js';
import {
  agentLabel, codeLabel, duration, tokenSummary, tokenTitle, taskRef, prettyJson, parseTime,
} from '../lib/format.js';
import { taskApiPath, repoHref } from '../lib/router.js';
import { isAbort } from '../lib/api.js';
import { epicChildren } from './repo.js';

const CHUNK_LIMIT = 256 * 1024;
const TAIL_BYTES = 64 * 1024;
const FOLLOW_MS = 3000;

export function formatBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 102.4) / 10} KB`;
  return `${Math.round(n / (1024 * 104.8576)) / 10} MB`;
}

const TABS = [
  { id: 'message', label: 'Last message', path: 'last_message' },
  { id: 'prompt', label: 'Prompt', path: 'prompt' },
  { id: 'log', label: 'Agent log', path: 'agent_log' },
  { id: 'stderr', label: 'Stderr', path: 'agent_stderr' },
  { id: 'verification', label: 'Verification', path: 'verification' },
  { id: 'grooming', label: 'Grooming', path: null },
];

export function createTaskPage(ctx) {
  const params = ctx.params;
  const label = params.loopId != null ? `loop ${params.loopId}` : `#${params.issue}`;
  const taskKey = params.loopId != null ? `${params.repoId}/loop/${params.loopId}` : `${params.repoId}/${params.issue}`;
  ctx.setTitle(`${params.repoId} ${label}`);

  const st = { data: null, error: null };
  const chunks = new Map(); // `${mode}:${path}` → { data, error, loading }
  const logs = new Map(); // path → { items, next_offset, size, usage, loading, error, loaded }
  let followTimer = null;
  let lastLogCount = 0;

  async function refresh(change) {
    if (change && change.repo_id && change.repo_id !== params.repoId) return;
    try {
      st.data = await ctx.api.get(taskApiPath(params));
      st.error = null;
      ctx.setTitle(`${params.repoId} ${label}${st.data.task.title ? ` ${st.data.task.title}` : ''}`);
    } catch (error) {
      if (isAbort(error)) return;
      st.error = error;
    }
    render();
  }

  // -- selection ------------------------------------------------------------

  function sessions() {
    return st.data?.sessions ?? [];
  }

  function latestSession() {
    let best = null;
    for (const s of sessions()) {
      if (!best || (parseTime(s.created_at) ?? 0) >= (parseTime(best.created_at) ?? 0)) best = s;
    }
    return best;
  }

  function selectedSession() {
    const id = ctx.query.session;
    return sessions().find((s) => s.session_id === id) ?? latestSession();
  }

  function currentPaths() {
    return selectedSession()?.artifacts ?? st.data?.artifacts ?? null;
  }

  function isRunning() {
    return st.data?.task.lifecycle === 'running';
  }

  function availableTabs() {
    const paths = currentPaths();
    const d = st.data;
    return TABS.filter((t) => t.id !== 'grooming' || d?.grooming).map((t) => {
      const path = t.path ? paths?.[t.path] ?? null : null;
      const has = t.id === 'grooming' ? Boolean(d?.grooming) : t.id === 'verification' ? Boolean(path || d?.verification) : Boolean(path);
      return { ...t, disabled: !has, title: has ? path ?? undefined : 'Not recorded for this session' };
    });
  }

  function currentTab() {
    const tabs = availableTabs();
    const wanted = ctx.query.tab;
    const found = tabs.find((t) => t.id === wanted && !t.disabled);
    if (found) return found;
    const preferred = isRunning() ? ['log', 'message'] : ['message', 'log', 'grooming', 'prompt'];
    for (const id of preferred) {
      const t = tabs.find((x) => x.id === id && !x.disabled);
      if (t) return t;
    }
    return tabs.find((t) => !t.disabled) ?? tabs[0];
  }

  // -- artifact loading -----------------------------------------------------

  async function loadChunk(mode, path, { append = false } = {}) {
    const key = `${mode}:${path}`;
    const entry = chunks.get(key) ?? { data: null, error: null, loading: false };
    if (entry.loading) return;
    entry.loading = true;
    chunks.set(key, entry);
    requestRender();
    try {
      const query = mode === 'tail' ? { path, tail: TAIL_BYTES } : { path, offset: append && entry.data ? entry.data.next_offset : 0, limit: CHUNK_LIMIT };
      const chunk = await ctx.api.get('/api/artifact', query);
      entry.data = append && entry.data ? { ...chunk, content: entry.data.content + chunk.content, offset: entry.data.offset } : chunk;
      entry.error = null;
    } catch (error) {
      if (isAbort(error)) return;
      entry.error = error;
    } finally {
      entry.loading = false;
      requestRender();
    }
  }

  async function loadLog(path, { more = false } = {}) {
    const entry = logs.get(path) ?? { items: [], next_offset: 0, size: 0, usage: null, loading: false, error: null, loaded: false, format: null };
    if (entry.loading) return;
    entry.loading = true;
    logs.set(path, entry);
    if (!more) requestRender();
    try {
      const page = await ctx.api.get('/api/agent-log', { path, after: more ? entry.next_offset : null });
      const lastIndex = entry.items.length ? entry.items[entry.items.length - 1].index : -1;
      const fresh = more ? page.items.filter((i) => i.index > lastIndex) : page.items;
      entry.items = more ? entry.items.concat(fresh) : fresh;
      entry.next_offset = Math.max(page.next_offset, more ? entry.next_offset : 0);
      entry.size = page.size;
      entry.usage = page.usage ?? entry.usage;
      entry.format = page.provider_format;
      entry.error = null;
      entry.loaded = true;
    } catch (error) {
      if (isAbort(error)) return;
      entry.error = error;
    } finally {
      entry.loading = false;
      requestRender();
    }
  }

  function ensureArtifact() {
    if (!st.data) return;
    const t = currentTab();
    const paths = currentPaths();
    if (!t || t.disabled || !t.path) return;
    const path = paths?.[t.path];
    if (!path) return;
    if (t.id === 'log') {
      if (!logs.has(path)) loadLog(path);
    } else {
      const mode = t.id === 'stderr' || t.id === 'verification' ? 'tail' : 'chunk';
      if (!chunks.has(`${mode}:${path}`)) loadChunk(mode, path);
    }
  }

  function followKey() {
    return `follow:${taskKey}`;
  }

  function updateFollow() {
    const t = currentTab();
    const path = currentPaths()?.agent_log;
    const want = st.data && isRunning() && t?.id === 'log' && path && ui.get(followKey(), true);
    if (want && !followTimer) {
      followTimer = setInterval(() => {
        if (document.hidden) return;
        const p = currentPaths()?.agent_log;
        if (p && logs.get(p)?.loaded) loadLog(p, { more: true });
      }, FOLLOW_MS);
    } else if (!want && followTimer) {
      clearInterval(followTimer);
      followTimer = null;
    }
  }

  function afterRender() {
    const scroller = document.getElementById('agent-log-scroll');
    const path = currentPaths()?.agent_log;
    const count = path ? logs.get(path)?.items.length ?? 0 : 0;
    if (scroller && ui.get(followKey(), true) && isRunning() && count !== lastLogCount) {
      scroller.scrollTop = scroller.scrollHeight;
    }
    lastLogCount = count;
  }

  // -- render ---------------------------------------------------------------

  function render() {
    const d = st.data;
    ctx.draw(
      header(d),
      d ? factsRow(d) : null,
      h(
        'div.task-grid',
        section({ key: 'timeline', title: 'Timeline', className: 'area-timeline', count: d ? d.timeline.length : null, actions: d && d.timeline.length > 1 ? orderToggle() : null }, asyncBody(st, (x) => timeline(orderedTimeline(x.timeline), { key: `task-tl-${taskKey}` }), { lines: 6, onRetry: () => refresh(null) })),
        section({ key: 'sessions', title: 'Sessions', className: 'area-sessions', count: d ? d.sessions.length : null }, asyncBody(st, (x) => sessionsTable(x.sessions), { lines: 2 })),
        section({ key: 'artifacts', title: 'Artifacts', className: 'area-artifacts', description: d ? artifactsCaption() : null }, asyncBody(st, () => artifactViewer(), { lines: 5 })),
      ),
      d && isEpic(d) ? section({ key: 'epic-children', title: 'Epic children', count: d.epic.children.length }, epicChildren(d.epic)) : null,
      d?.run_state ? section({ key: 'run-state', title: 'Run state', className: 'section-quiet' }, disclosure(`runstate:${taskKey}`, { summary: 'run.json' }, () => h('pre.code', prettyJson(d.run_state)))) : null,
    );
    ensureArtifact();
    updateFollow();
    requestAnimationFrame(afterRender);
  }

  function isEpic(d) {
    return Boolean(d.epic && (d.task.kind === 'epic' || d.epic.task_key === d.task.task_key));
  }

  function orderToggle() {
    const newest = ui.get(`tl-newest:${taskKey}`, true);
    return h('button.quiet-button.small', { type: 'button', 'aria-pressed': newest ? 'true' : 'false', on: { click: () => { ui.set(`tl-newest:${taskKey}`, !newest); requestRender(); } } }, newest ? 'Newest first' : 'Oldest first');
  }

  function orderedTimeline(entries) {
    const newest = ui.get(`tl-newest:${taskKey}`, true);
    return entries
      .map((e, i) => ({ e, i, t: parseTime(e.at) ?? 0 }))
      .sort((a, b) => (newest ? b.t - a.t || b.i - a.i : a.t - b.t || a.i - b.i))
      .map((x) => x.e);
  }

  function header(d) {
    const t = d?.task;
    const childOfEpic = d?.epic && !isEpic(d) ? d.epic : null;
    return h(
      'header.page-head',
      { key: 'task-head' },
      h(
        'div.page-head-main',
        h('p.crumbs', h('a', { href: '#/' }, 'Overview'), ' / ', h('a', { href: repoHref(params.repoId) }, params.repoId), ' / ', label),
        h(
          'h1.page-title',
          t ? lifecycleTag(t.lifecycle, { className: 'title-tag' }) : null,
          d?.loop && !d.loop.enabled ? tag('⊘', 'Disabled', 'neutral', { className: 'title-tag', title: 'Loop is disabled in the workflow' }) : null,
          h('span.ref', t ? taskRef(t) : label),
          ' ',
          h('span', t?.title ?? (st.error ? 'Task unavailable' : 'Loading…')),
        ),
        t
          ? h(
              'div.page-meta',
              repoChip(t.repo_id),
              extLink(t.issue_url, t.issue_number != null ? `Issue #${t.issue_number}` : 'Issue'),
              extLink(t.pr_url, t.pr_number != null ? `PR #${t.pr_number}` : 'PR'),
              childOfEpic ? taskLink(childOfEpic.task_key, `Epic ${taskRef(childOfEpic)}`, { title: childOfEpic.title }) : null,
              t.agent_provider || t.agent_mode ? h('span', agentLabel(t.agent_provider, t.agent_mode)) : null,
              t.attempt != null ? h('span', `attempt ${t.attempt}`) : null,
              parseTime(t.updated_at) != null ? h('span', 'updated ', timeEl(t.updated_at)) : null,
              t.stale ? tag('▲', 'Stale', 'warn', { title: 'No state change for longer than the stale threshold' }) : null,
              t.epic_progress ? chip(`epic ${t.epic_progress}`) : null,
            )
          : st.error ? errorBlock(st.error, () => refresh(null)) : null,
        t && t.labels.length ? h('div.label-row', t.labels.map((l) => chip(l, { className: 'label' }))) : null,
      ),
      t && (t.retry_reason || t.pause_reason) ? h('p.task-note', t.retry_reason ? [tag('↻', 'Retry', 'warn'), ' ', reasonView(t.retry_reason), t.retry_not_before ? [' · next ', timeEl(t.retry_not_before)] : null] : null, t.pause_reason ? [tag('‖', 'Paused', 'warn'), ' ', reasonView(t.pause_reason)] : null) : null,
      t?.last_error ? h('div.last-error', h('h2.mini-title', levelTag('bad', 'Last error')), longPre(`lasterr:${taskKey}`, t.last_error, { className: 'code error-text' })) : null,
      d ? commandsRow(d.commands, t) : null,
    );
  }

  function commandsRow(commands, t) {
    const rows = [
      ['cd', commands.cd],
      ['resume', commands.resume],
      ['exec', commands.exec],
    ].filter(([, v]) => v);
    if (!rows.length && !commands.editor_url && !t?.workspace_path) return null;
    return h(
      'div.commands',
      { role: 'group', 'aria-label': 'Commands' },
      rows.map(([name, value]) => h('div.cmd', { key: name }, h('span.cmd-label', name), h('code.cmd-text', { title: value }, value), copyButton(value, { what: `${name} command` }))),
      commands.editor_url ? h('a.quiet-button.small.editor-link', { href: commands.editor_url, title: commands.editor_url }, 'Open in editor') : null,
    );
  }

  function factsRow(d) {
    const blocks = [];
    if (d.loop) blocks.push(section({ key: 'loop', title: 'Loop', level: 2 }, loopFacts(d.loop, d.timeline.length > 0)));
    if (d.pull_request) blocks.push(section({ key: 'pr', title: 'Pull request', level: 2 }, prFacts(d.pull_request)));
    if (!blocks.length) return null;
    return h('div.cols-2', { key: 'facts' }, blocks);
  }

  function sessionsTable(rows) {
    const selected = selectedSession()?.session_id;
    const select = (id) => ctx.setQuery({ session: id === latestSession()?.session_id ? null : id });
    return dataTable({
      key: `sessions-${taskKey}`,
      label: 'Agent sessions',
      rows,
      rowKey: (s) => s.session_id,
      rowHref: (s) => s.session_id,
      navigate: select,
      rowClass: (s) => (s.session_id === selected ? 'selected' : null),
      empty: 'No sessions recorded',
      columns: [
        { id: 'attempt', label: 'Att', title: 'Attempt', className: 'r', sort: (s) => s.attempt ?? -1, cell: (s) => h('span.num', s.attempt ?? '—') },
        { id: 'mode', label: 'Mode', cell: (s) => h('span', s.mode ? codeLabel(s.mode) : '—') },
        { id: 'provider', label: 'Provider', optional: true, cell: (s) => s.provider ?? '—' },
        { id: 'created', label: 'Started', sort: (s) => parseTime(s.created_at), cell: (s) => timeEl(s.created_at) },
        { id: 'finished', label: 'Finished', optional: true, cell: (s) => (s.finished_at ? timeEl(s.finished_at) : h('span.muted', s.phase ? codeLabel(s.phase) : '—')) },
        { id: 'outcome', label: 'Outcome', cell: (s) => outcomeCell(s) },
        { id: 'usage', label: 'Tokens', optional: true, cell: (s) => h('span.num.small', { title: tokenTitle(s.usage) }, tokenSummary(s.usage)) },
        {
          id: 'view', label: h('span.sr-only', 'View'),
          cell: (s) => h('button.quiet-button.small', { type: 'button', 'aria-pressed': s.session_id === selected ? 'true' : 'false', 'aria-label': `View artifacts for attempt ${s.attempt ?? ''} session ${s.session_id}`, on: { click: () => select(s.session_id) } }, s.session_id === selected ? 'Viewing' : 'View'),
        },
      ],
    });
  }

  function outcomeCell(s) {
    const outcome = s.workflow_outcome ?? s.agent_outcome;
    if (!outcome) return s.finished_at ? h('span.muted', '—') : runStatusTag('agent-running');
    const map = { completed: 'completed', failed: 'failed', cancelled: 'cancelled', paused: 'paused', 'retry-scheduled': 'retry-wait' };
    return h('span', { title: `agent: ${s.agent_outcome ?? '—'} · workflow: ${s.workflow_outcome ?? '—'}` }, runStatusTag(map[outcome] ?? outcome));
  }

  function artifactsCaption() {
    const s = selectedSession();
    if (!s) return 'Task artifacts';
    return `Attempt ${s.attempt ?? '?'} · ${s.session_id}`;
  }

  function artifactViewer() {
    const tabs = availableTabs();
    const t = currentTab();
    const key = `art-${taskKey}`;
    return [
      tabList({ key, label: 'Artifacts', tabs, selected: t?.id, onSelect: (id) => ctx.setQuery({ tab: id }) }),
      tabPanel(key, t?.id, t ? artifactPanel(t) : emptyBlock('No artifacts')),
    ];
  }

  function artifactPanel(t) {
    const d = st.data;
    const paths = currentPaths();
    if (t.id === 'grooming') return groomingPanel(d.grooming);
    const path = t.path ? paths?.[t.path] : null;
    if (t.id === 'verification' && !path && d.verification) return h('pre.code', prettyJson(d.verification));
    if (!path) return emptyBlock('Not recorded for this session');
    const pathLine = h('p.path-line', h('code', { title: path }, path), copyButton(path, { what: 'path' }));
    if (t.id === 'log') return [pathLine, agentLogPanel(path)];
    const mode = t.id === 'stderr' || t.id === 'verification' ? 'tail' : 'chunk';
    const entry = chunks.get(`${mode}:${path}`) ?? { data: null, error: null };
    if (entry.error?.status === 404 && !entry.data) return [pathLine, notWritten(() => { chunks.delete(`${mode}:${path}`); loadChunk(mode, path); })];
    return [
      pathLine,
      asyncBody(entry, (chunk) => chunkView(t, mode, path, chunk, entry), { lines: 4, onRetry: () => { chunks.delete(`${mode}:${path}`); loadChunk(mode, path); } }),
    ];
  }

  function chunkView(t, mode, path, chunk, entry) {
    const content = chunk.content ?? '';
    const reload = h('button.quiet-button.small', { type: 'button', disabled: entry.loading || null, on: { click: () => loadChunk(mode, path) } }, entry.loading ? 'Loading…' : 'Reload');
    const meta = h('p.chunk-meta', `${formatBytes(chunk.size)}`, chunk.mtime ? [' · modified ', timeEl(chunk.mtime)] : null, ' ', reload);
    let body;
    if (!content.trim()) body = emptyBlock('Empty file');
    else if (t.id === 'message' || t.id === 'prompt') body = markdownView(content, { className: 'artifact-md' });
    else if (t.id === 'verification') {
      let pretty = content;
      try { pretty = prettyJson(JSON.parse(content)); } catch { /* raw */ }
      body = h('pre.code.artifact-raw', pretty);
    } else body = h('pre.code.artifact-raw', content);
    const more = mode === 'chunk' && chunk.next_offset < chunk.size
      ? h('button.quiet-button.load-more', { type: 'button', disabled: entry.loading || null, on: { click: () => loadChunk(mode, path, { append: true }) } }, `Load more (${formatBytes(chunk.size - chunk.next_offset)} left)`)
      : null;
    const tailNote = mode === 'tail' && chunk.offset > 0 ? h('p.small.muted', `Showing the last ${formatBytes(chunk.size - chunk.offset)} of ${formatBytes(chunk.size)}.`) : null;
    return [meta, tailNote, body, more];
  }

  function agentLogPanel(path) {
    const entry = logs.get(path);
    if (!entry || (!entry.loaded && !entry.error)) return loadingBlock(5, 'Loading agent log');
    if (entry.error?.status === 404 && !entry.loaded) return notWritten(() => { logs.delete(path); loadLog(path); });
    if (entry.error && !entry.loaded) return errorBlock(entry.error, () => { logs.delete(path); loadLog(path); });
    const following = ui.get(followKey(), true);
    const running = isRunning();
    return [
      h(
        'div.log-toolbar',
        h('span.small.muted', `${entry.items.length} items · ${formatBytes(entry.next_offset)} of ${formatBytes(entry.size)}`, entry.format ? ` · ${entry.format}` : ''),
        entry.usage ? h('span.small.num', { title: tokenTitle(entry.usage) }, tokenSummary(entry.usage)) : null,
        running
          ? h('label.check', h('input', { type: 'checkbox', checked: following, on: { change: (e) => { ui.set(followKey(), e.currentTarget.checked); requestRender(); } } }), ' Follow', following ? h('span.small.muted', ' (every 3s)') : null)
          : h('span.small.muted', 'Task not running; follow off'),
      ),
      entry.items.length
        ? h('div.agent-log', { id: 'agent-log-scroll', tabindex: '0', 'aria-label': 'Agent log' }, entry.items.map((item) => logItem(item)))
        : emptyBlock('No log items yet'),
      entry.error ? errorBlock(entry.error) : null,
      entry.next_offset < entry.size
        ? h('button.quiet-button.load-more', { type: 'button', disabled: entry.loading || null, on: { click: () => loadLog(path, { more: true }) } }, entry.loading ? 'Loading…' : `Load more (${formatBytes(entry.size - entry.next_offset)} left)`)
        : null,
    ];
  }

  function logItem(item) {
    const key = `log-${item.index}`;
    const when = item.at ? timeEl(item.at, { className: 'small muted' }) : null;
    const text = item.body ?? item.title;
    switch (item.kind) {
      case 'message':
        return h('div.log-item.log-message', { key }, h('div.log-head', h('span.log-kind', 'Agent'), when), markdownView(text));
      case 'reasoning':
        return h('div.log-item.log-reasoning', { key }, h('div.log-head', h('span.log-kind', 'Reasoning'), when), h('p.reasoning', text));
      case 'command':
      case 'tool': {
        const lines = item.body ? item.body.split('\n').length : 0;
        return h(
          'div.log-item.log-command',
          { key, class: item.status === 'failed' || (item.exit_code != null && item.exit_code !== 0) ? 'failed' : null },
          h('div.log-head', h('span.log-kind', item.kind === 'command' ? 'Command' : 'Tool'), exitTag(item), when),
          h('pre.cmd-line', item.kind === 'command' ? `$ ${item.title}` : item.title),
          item.body ? disclosure(`${key}:${taskKey}:out`, { summary: `Output (${lines} line${lines === 1 ? '' : 's'})`, className: 'log-output' }, () => h('pre.code', item.body)) : null,
        );
      }
      case 'error':
        return h('div.log-item.log-error', { key }, h('div.log-head', levelTag('bad', 'Error'), when), h('p', item.title), item.body && item.body !== item.title ? h('pre.code', item.body) : null);
      case 'thread':
      case 'turn':
        return h('div.log-sep', { key }, h('span', item.title), when);
      default:
        return h('div.log-item.log-raw', { key }, h('div.log-head', h('span.log-kind', 'Event'), when), h('span.mono.small', item.title), item.body ? disclosure(`${key}:${taskKey}:raw`, { summary: 'Details', className: 'log-output' }, () => h('pre.code', item.body)) : null);
    }
  }

  function exitTag(item) {
    if (item.exit_code != null) return item.exit_code === 0 ? tag('✓', 'exit 0', 'good') : tag('✕', `exit ${item.exit_code}`, 'bad');
    if (item.status === 'in_progress') return tag('◌', 'running', 'accent');
    if (item.status === 'failed') return tag('✕', 'failed', 'bad');
    if (item.status === 'completed') return tag('✓', 'done', 'good');
    return null;
  }

  return {
    refresh,
    render,
    destroy() {
      clearInterval(followTimer);
      followTimer = null;
    },
  };
}

function notWritten(onRetry) {
  return h('p.empty', 'This file has not been written yet. ', h('button.link-button', { type: 'button', on: { click: onRetry } }, 'Check again'));
}

function facts(rows) {
  return h('dl.facts', rows.filter(([, v]) => v != null && v !== false).map(([k, v]) => [h('dt', k), h('dd', v)]));
}

function loopFacts(l, hasHistory) {
  return facts([
    ['Status', [loopStatusTag(l, { hasHistory }), l.enabled ? null : [' ', tag('⊘', 'Disabled', 'neutral')]]],
    ['Every', l.interval_ms != null ? duration(l.interval_ms) : null],
    ['Last started', l.last_started_at ? timeEl(l.last_started_at) : null],
    ['Last finished', l.last_finished_at ? timeEl(l.last_finished_at) : null],
    ['Next due', l.next_due_at ? timeEl(l.next_due_at) : null],
    ['Last outcome', l.last_outcome ? codeLabel(l.last_outcome) : null],
    ['Attempt', l.attempt],
    ['Paused', l.pause_reason ? reasonView(l.pause_reason) : null],
    ['Last error', l.last_error ? h('span.error-text', l.last_error) : null],
  ]);
}

function prFacts(pr) {
  return facts([
    ['PR', extLink(pr.url, `#${pr.number}${pr.title ? ` ${pr.title}` : ''}`) ?? `#${pr.number}`],
    ['Branch', pr.head_ref ? h('code', pr.head_ref) : null],
    ['Review', pr.review_labels.length ? h('span.flag-list', pr.review_labels.map((l) => chip(l.replace(/^symphony-review:/, ''), { title: l }))) : null],
    ['Claim', pr.review_claim_status ? codeLabel(pr.review_claim_status) : null],
    ['Feedback', pr.feedback_round != null ? `round ${pr.feedback_round} of ${pr.max_feedback_rounds ?? '?'}` : null],
    ['Merge', pr.merge_blocked_reasons.length ? h('ul.reason-list', pr.merge_blocked_reasons.map((r) => h('li', h('span.glyph.tone-warn', { 'aria-hidden': 'true' }, '▲'), ' ', reasonView(r)))) : null],
    ['Assessed', pr.last_merge_assessment_at ? timeEl(pr.last_merge_assessment_at) : null],
  ]);
}

function groomingPanel(g) {
  if (!g) return emptyBlock('No grooming result');
  return [
    facts([
      ['Outcome', g.outcome ? tag('◇', codeLabel(g.outcome), 'review') : null],
      ['Scope', g.scope ? codeLabel(g.scope) : null],
    ]),
    g.summary ? markdownView(g.summary) : null,
    disclosure('grooming-raw', { summary: 'Raw result' }, () => h('pre.code', prettyJson(g.raw))),
  ];
}
