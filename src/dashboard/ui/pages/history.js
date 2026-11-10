// History: weekly outcomes per repo with top reasons.

import { h } from '../lib/dom.js';
import { section, asyncBody, dataTable, selectControl, field, sparkline, emptyBlock, num, repoChip } from '../lib/components.js';
import { duration, shortDate, reasonText, absTime } from '../lib/format.js';
import { isAbort } from '../lib/api.js';

export const WINDOWS = [7, 28, 90];

export function subNav(active) {
  return h(
    'nav.subnav',
    { 'aria-label': 'History views' },
    h('a.subnav-link', { href: '#/history', 'aria-current': active === 'history' ? 'page' : null }, 'Weekly outcomes'),
    h('a.subnav-link', { href: '#/events', 'aria-current': active === 'events' ? 'page' : null }, 'Events'),
  );
}

export function repoOptions(ctx, extra = []) {
  const ids = new Set([...(ctx.overview?.repos ?? []).map((r) => r.repo_id), ...extra]);
  return [{ value: '', label: 'All repositories' }, ...[...ids].map((id) => ({ value: id, label: id }))];
}

export function createHistoryPage(ctx) {
  ctx.setTitle('History');
  const st = { data: null, error: null, key: null };

  function days() {
    const n = Number(ctx.query.days);
    return WINDOWS.includes(n) ? n : 28;
  }

  async function refresh(change) {
    // History moves slowly; ignore per-repo churn from the live stream.
    if (change && st.data) return;
    const key = `${days()}|${ctx.query.repo ?? ''}`;
    if (st.key !== key) st.data = null;
    st.key = key;
    render();
    try {
      const data = await ctx.api.get('/api/history', { days: days(), repo: ctx.query.repo || null });
      if (st.key !== key) return;
      st.data = data;
      st.error = null;
    } catch (error) {
      if (isAbort(error)) return;
      st.error = error;
    }
    render();
  }

  function render() {
    const d = st.data;
    ctx.draw(
      h('header.page-head', h('div.page-head-main', h('h1.page-title', 'History'), subNav('history'))),
      h(
        'div.filter-bar',
        field('Window', selectControl({ id: 'history-days', value: String(days()), label: 'Time window', options: WINDOWS.map((n) => ({ value: String(n), label: `Last ${n} days` })), onChange: (v) => ctx.setQuery({ days: v === '28' ? null : v }) })),
        field('Repository', selectControl({ id: 'history-repo', value: ctx.query.repo ?? '', label: 'Repository', options: repoOptions(ctx, (d?.repos ?? []).map((r) => r.repo_id)), onChange: (v) => ctx.setQuery({ repo: v }) })),
        d ? h('p.small.muted.filter-note', `${shortDate(d.window.from)} – ${shortDate(d.window.to)}`, h('span.sr-only', ` (${absTime(d.window.from)} to ${absTime(d.window.to)})`)) : null,
      ),
      asyncBody(st, (x) => (x.repos.length ? x.repos.map((r) => repoHistory(r)) : emptyBlock('No history in this window')), { lines: 6, onRetry: () => refresh(null) }),
    );
  }

  return {
    refresh,
    render,
    onOverview: render,
    onQuery() {
      refresh(null);
    },
  };
}

function totals(weeks) {
  const t = { merged: 0, completed: 0, failed: 0, retries: 0 };
  for (const w of weeks) {
    t.merged += w.merged;
    t.completed += w.completed;
    t.failed += w.failed;
    t.retries += w.retries;
  }
  return t;
}

function reasonList(title, items) {
  return h(
    'div.reason-block',
    h('h3.mini-title', title),
    items.length
      ? h('ol.reason-counts', items.slice(0, 5).map((r) => h('li', { key: r.reason }, h('span.reason-text', { title: r.reason }, reasonText(r.reason)), h('span.num', String(r.count)))))
      : h('p.small.muted', 'None'),
  );
}

function repoHistory(r) {
  const t = totals(r.weeks);
  const merged = r.weeks.map((w) => w.merged);
  return section(
    {
      key: `hist-${r.repo_id}`,
      title: r.repo_id,
      level: 2,
      description: `${t.merged} merged · ${t.completed} completed · ${t.failed} failed · ${t.retries} retries`,
      actions: [sparkline(merged, { label: `Merged per week, oldest to newest: ${merged.join(', ')}` }), h('span.small.muted', 'merged/wk'), repoChip(r.repo_id)],
    },
    h(
      'div.history-body',
      dataTable({
        key: `hist-table-${r.repo_id}`,
        label: `Weekly outcomes for ${r.repo_id}`,
        rows: r.weeks,
        rowKey: (w) => w.week_start,
        empty: 'No weeks in window',
        columns: [
          { id: 'week', label: 'Week of', cell: (w) => h('time', { datetime: w.week_start, title: absTime(w.week_start) }, shortDate(w.week_start)) },
          { id: 'merged', label: 'Merged', className: 'r', cell: (w) => num(w.merged) },
          { id: 'completed', label: 'Completed', className: 'r', cell: (w) => num(w.completed) },
          { id: 'failed', label: 'Failed', className: 'r', cell: (w) => num(w.failed) },
          { id: 'paused', label: 'Paused', className: 'r', optional: true, cell: (w) => num(w.paused) },
          { id: 'retries', label: 'Retries', className: 'r', cell: (w) => num(w.retries) },
          { id: 'loops_ok', label: 'Loops ok', className: 'r', optional: true, cell: (w) => num(w.loops_completed) },
          { id: 'loops_failed', label: 'Loops failed', className: 'r', optional: true, cell: (w) => num(w.loops_failed) },
          { id: 'median', label: 'Claim→merge', title: 'Median time from claim to merge', className: 'r', cell: (w) => h('span.num', { class: w.median_claim_to_merge_ms == null ? 'muted' : null }, duration(w.median_claim_to_merge_ms)) },
        ],
      }),
      h(
        'div.reasons',
        reasonList('Top retry reasons', r.top_retry_reasons),
        reasonList('Top failure reasons', r.top_failure_reasons),
        reasonList('Top merge blocks', r.top_merge_block_reasons),
      ),
    ),
  );
}
