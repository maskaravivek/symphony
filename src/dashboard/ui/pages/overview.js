// Overview: what needs me, what is running, how each repo is doing.

import { h, timeEl, elapsedEl, disclosure } from '../lib/dom.js';
import {
  section, asyncBody, attentionList, dataTable, repoChip, taskLink, levelGlyph, flagChips, num,
  meter, searchControl, selectControl, field, chip, emptyBlock,
} from '../lib/components.js';
import {
  matchesQuery, attentionLabel, agentLabel, tokenSummary, tokenTitle, taskRef, LEVEL_RANK,
  isPollStale, absTime, plural,
} from '../lib/format.js';
import { repoHref } from '../lib/router.js';
import { isAbort } from '../lib/api.js';

export function filterOverview(data, { q = '', repo = '' } = {}) {
  const repoOk = (id) => !repo || id === repo;
  const attention = data.attention.filter((a) =>
    (a.repo_id == null || repoOk(a.repo_id)) &&
    matchesQuery([a.repo_id, a.issue_number, a.title, a.detail, attentionLabel(a.reason), a.reason, a.pr_number], q));
  const running = data.running.filter((r) =>
    repoOk(r.repo_id) &&
    matchesQuery([r.repo_id, r.issue_number, r.issue_identifier, r.loop_id, r.title, r.agent_provider, r.agent_mode, r.kind], q));
  const touched = new Set([...attention.map((a) => a.repo_id), ...running.map((r) => r.repo_id)]);
  const repos = data.repos.filter((r) =>
    repoOk(r.repo_id) &&
    (!q.trim() || touched.has(r.repo_id) || matchesQuery([r.repo_id, r.owner, r.repo, r.owner && r.repo ? `${r.owner}/${r.repo}` : null], q)));
  const epics = data.epics.filter((e) => repoOk(e.repo_id) && matchesQuery([e.repo_id, e.issue_number, e.issue_identifier, e.title], q));
  return { attention, running, repos, epics };
}

export function createOverviewPage(ctx) {
  ctx.setTitle('Overview');

  async function refresh() {
    try {
      await ctx.loadOverview();
    } catch (error) {
      if (isAbort(error)) return;
    }
    render();
  }

  function state() {
    return { data: ctx.overview, error: ctx.overviewError };
  }

  function filters(data) {
    const q = ctx.query.q ?? '';
    const repo = ctx.query.repo ?? '';
    const repoOptions = [{ value: '', label: 'All repositories' }, ...(data?.repos ?? []).map((r) => ({ value: r.repo_id, label: r.repo_id }))];
    const active = q || repo;
    return h(
      'div.filter-bar',
      { role: 'search', 'aria-label': 'Filter overview' },
      field('Search', searchControl({ id: 'overview-search', value: q, placeholder: 'Repo, #issue, title, provider…  ( / )', label: 'Search attention, running work and repositories', onInput: (v) => ctx.setQuery({ q: v }) }), { className: 'grow' }),
      field('Repository', selectControl({ id: 'overview-repo', value: repo, options: repoOptions, label: 'Repository filter', onChange: (v) => ctx.setQuery({ repo: v }) })),
      active ? h('button.quiet-button', { type: 'button', on: { click: () => ctx.setQuery({ q: '', repo: '' }) } }, 'Clear filters') : null,
    );
  }

  function render() {
    const st = state();
    const data = st.data;
    const view = data ? filterOverview(data, { q: ctx.query.q ?? '', repo: ctx.query.repo ?? '' }) : null;
    const pollMs = data?.orchestrator.polling_interval_ms;
    const sub = (fn) => asyncBody({ data: view, error: st.error }, fn, { onRetry: refresh });

    ctx.draw(
      h('h1.sr-only', 'Overview'),
      filters(data),
      h(
        'div.overview-top',
        section(
          { key: 'attention', title: 'Needs attention', count: view ? view.attention.length : null },
          sub((v) => attentionList(v.attention, { key: 'ov-att' })),
        ),
        h(
          'div.stack',
          section(
            { key: 'running', title: 'Running now', count: view ? view.running.length : null },
            sub((v) => runningList(v.running, data.generated_at)),
          ),
          view && data.epics.length
            ? section(
                { key: 'epics', title: 'Epics', className: 'section-compact' },
                disclosure('ov-epics', { summary: `${plural(view.epics.length, 'coordinating epic')}` }, () => epicRows(view.epics)),
              )
            : null,
        ),
      ),
      section(
        { key: 'repos', title: 'Repositories', count: view ? view.repos.length : null, description: data ? summaryLine(data) : null },
        sub((v) => repoTable(v.repos, pollMs, ctx.navigate)),
      ),
    );
  }

  return { refresh, render, onOverview: render };
}

function summaryLine(data) {
  const t = data.totals;
  return `${t.running} running · ${t.queued} queued · ${t.retrying} retrying · updated ${absTime(data.generated_at)}`;
}

function runningList(rows, generatedAt) {
  if (!rows.length) return emptyBlock('No agents running');
  return h(
    'ul.run-list',
    rows.map((r) => {
      const start = r.started_at ?? (r.elapsed_ms != null ? new Date(Date.parse(generatedAt) - r.elapsed_ms).toISOString() : null);
      return h(
        'li.run-row',
        { key: r.task_key },
        h('span.run-repo', repoChip(r.repo_id)),
        h('span.run-ref', taskLink(r.task_key, taskRef(r), { className: 'ref' })),
        h('span.run-title', taskLink(r.task_key, r.title ?? r.issue_identifier, { className: 'plain-link', title: r.title ?? r.issue_identifier })),
        h(
          'span.run-stats',
          h('span', { title: 'Agent provider and mode' }, agentLabel(r.agent_provider, r.agent_mode)),
          h('span', { title: 'Attempt' }, `att ${r.attempt}`),
          start ? elapsedEl(start) : null,
          h('span.num', { title: tokenTitle(r.usage) }, tokenSummary(r.usage)),
        ),
        h(
          'span.run-activity',
          r.last_activity
            ? [h('span.mono', { title: r.last_activity }, r.last_activity), r.last_activity_at ? timeEl(r.last_activity_at, { className: 'small' }) : null]
            : h('span.mono.muted', 'No activity recorded yet'),
        ),
      );
    }),
  );
}

function poolCell(pool) {
  const title = `${pool.slots_in_use} in use, ${pool.slots_protected} protected, ${pool.slots_idle} idle, ${pool.slots_total} total${pool.slots_max != null ? ` (max ${pool.slots_max})` : ''}`;
  return h(
    'span.pool',
    { title },
    h('span.num', `${pool.slots_in_use}/${pool.slots_total}`),
    pool.slots_protected ? h('span.pool-prot', { 'aria-label': `${pool.slots_protected} protected` }, ` ◈${pool.slots_protected}`) : null,
  );
}

function repoTable(repos, pollMs, navigate) {
  return dataTable({
    key: 'ov-repos',
    label: 'Repositories',
    rows: repos,
    rowKey: (r) => r.repo_id,
    rowHref: (r) => repoHref(r.repo_id),
    navigate,
    empty: 'No repositories match the filter',
    rowClass: (r) => (r.enabled ? `lvl-${r.level}` : 'disabled'),
    columns: [
      { id: 'repo', label: 'Repository', sort: (r) => r.repo_id, cell: (r) => [h('a.row-main', { href: repoHref(r.repo_id) }, r.repo_id), r.enabled ? null : chip('disabled', { className: 'small' })] },
      { id: 'level', label: 'Health', sort: (r) => LEVEL_RANK[r.level] ?? 9, className: 'c', cell: (r) => levelGlyph(r.level) },
      { id: 'running', label: 'Running', sort: (r) => -r.capacity.running, className: 'r', cell: (r) => h('span.num', { title: `${r.capacity.running} running of ${r.capacity.max_concurrent_agents}` }, h('strong', { class: r.capacity.running ? null : 'zero' }, String(r.capacity.running)), h('span.muted', `/${r.capacity.max_concurrent_agents}`)) },
      { id: 'queued', label: 'Queued', className: 'r', cell: (r) => num(r.counts.queued) },
      { id: 'retrying', label: 'Retrying', className: 'r', cell: (r) => num(r.counts.retrying) },
      { id: 'needs', label: 'Needs info', className: 'r', optional: true, cell: (r) => num(r.counts.needs_info) },
      { id: 'waiting', label: 'Waiting', title: 'Waiting for a human', className: 'r', optional: true, cell: (r) => num(r.counts.waiting_human) },
      { id: 'failed', label: 'Failed', className: 'r', cell: (r) => num(r.counts.failed) },
      { id: 'pool', label: 'Pool', title: 'Workspace slots in use / total; ◈ protected', className: 'r', optional: true, cell: (r) => poolCell(r.pool) },
      {
        id: 'poll', label: 'Last poll', sort: (r) => r.poll_age_ms ?? Number.MAX_SAFE_INTEGER,
        cell: (r) => {
          const stale = isPollStale(r, pollMs);
          return h('span', { class: stale ? 'stale' : null }, stale ? h('span', { 'aria-hidden': 'true' }, '▲ ') : null, stale ? h('span.sr-only', 'Stale: ') : null, timeEl(r.last_poll_at));
        },
      },
      { id: 'flags', label: 'Flags', cell: (r) => flagChips(r.flags, 3) },
    ],
  });
}

export function epicRows(epics, { showRepo = true } = {}) {
  if (!epics.length) return emptyBlock('No coordinating epics');
  return h(
    'ul.epic-list',
    epics.map((e) =>
      h(
        'li.epic-row',
        { key: e.task_key },
        h('span.epic-title', taskLink(e.task_key, [h('span.ref', taskRef(e)), ' ', e.title])),
        showRepo ? repoChip(e.repo_id) : null,
        meter(e.terminal_children, e.total_children, { label: `${e.terminal_children} of ${e.total_children} children done` }),
        h('span.small.muted', `${e.open_children} open`),
      ),
    ),
  );
}
