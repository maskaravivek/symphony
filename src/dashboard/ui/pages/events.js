// Events: newest-first episode events across repos, with load-more.

import { h } from '../lib/dom.js';
import { asyncBody, timeline, selectControl, searchControl, field, errorBlock } from '../lib/components.js';
import { matchesQuery, humanize } from '../lib/format.js';
import { isAbort } from '../lib/api.js';
import { subNav, repoOptions } from './history.js';

const PAGE = 100;

export function createEventsPage(ctx) {
  ctx.setTitle('Events');
  const st = { data: null, error: null, repo: null, nextBefore: null, more: { loading: false, error: null } };

  function merge(fresh, existing) {
    const seen = new Set(fresh.map((e) => e.sequence));
    return [...fresh, ...existing.filter((e) => !seen.has(e.sequence))].sort((a, b) => b.sequence - a.sequence);
  }

  async function refresh(change) {
    const repo = ctx.query.repo ?? '';
    if (change && change.repo_id && repo && change.repo_id !== repo) return;
    if (st.repo !== repo) {
      st.data = null;
      st.nextBefore = null;
      st.repo = repo;
      render();
    }
    try {
      const page = await ctx.api.get('/api/events', { repo: repo || null, limit: PAGE });
      if (st.repo !== repo) return;
      const first = st.data == null;
      st.data = merge(page.events, st.data ?? []);
      if (first) st.nextBefore = page.next_before;
      st.error = null;
    } catch (error) {
      if (isAbort(error)) return;
      st.error = error;
    }
    render();
  }

  async function loadMore() {
    if (st.more.loading || st.nextBefore == null) return;
    st.more.loading = true;
    st.more.error = null;
    render();
    try {
      const page = await ctx.api.get('/api/events', { repo: st.repo || null, before: st.nextBefore, limit: PAGE });
      st.data = merge(st.data ?? [], page.events);
      st.nextBefore = page.next_before;
    } catch (error) {
      if (isAbort(error)) return;
      st.more.error = error;
    } finally {
      st.more.loading = false;
      render();
    }
  }

  function render() {
    const q = ctx.query.q ?? '';
    const level = ctx.query.level ?? '';
    const events = (st.data ?? []).filter((e) => (!level || e.level === level) && matchesQuery([e.event, e.summary, e.repo_id, e.issue_number, e.pr_number, e.episode_id, humanize(e.event)], q));
    ctx.draw(
      h('header.page-head', h('div.page-head-main', h('h1.page-title', 'History'), subNav('events'))),
      h(
        'div.filter-bar',
        { role: 'search', 'aria-label': 'Filter events' },
        field('Search', searchControl({ id: 'events-search', value: q, placeholder: 'Event, summary, #issue…  ( / )', label: 'Search loaded events', onInput: (v) => ctx.setQuery({ q: v }) }), { className: 'grow' }),
        field('Repository', selectControl({ id: 'events-repo', value: ctx.query.repo ?? '', label: 'Repository', options: repoOptions(ctx), onChange: (v) => ctx.setQuery({ repo: v }) })),
        field('Level', selectControl({ id: 'events-level', value: level, label: 'Level', options: [{ value: '', label: 'All levels' }, { value: 'bad', label: 'Needs action' }, { value: 'warn', label: 'Warnings' }, { value: 'ok', label: 'OK' }], onChange: (v) => ctx.setQuery({ level: v }) })),
      ),
      h(
        'section.section',
        { 'aria-label': 'Events' },
        asyncBody({ data: st.data, error: st.error }, () => [
          q || level ? h('p.small.muted', `${events.length} of ${st.data.length} loaded events match`) : null,
          timeline(events, { key: 'events', showRepo: true, empty: q || level ? 'No loaded events match the filter' : 'No events recorded' }),
          st.more.error ? errorBlock(st.more.error, loadMore) : null,
          st.nextBefore != null
            ? h('button.quiet-button.load-more', { type: 'button', disabled: st.more.loading || null, on: { click: loadMore } }, st.more.loading ? 'Loading…' : 'Load older events')
            : h('p.small.muted.end-note', 'No older events'),
        ], { lines: 8, onRetry: () => refresh(null) }),
      ),
    );
  }

  return {
    refresh,
    render,
    onOverview: render,
    onQuery() {
      if ((ctx.query.repo ?? '') !== st.repo) refresh(null);
    },
  };
}
