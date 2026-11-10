// Repo detail: health, slots, retry queue, loops, PRs, tasks, epics, events.

import { h, timeEl, disclosure } from '../lib/dom.js';
import {
  section, asyncBody, attentionList, dataTable, taskLink, levelTag, levelGlyph, slotTag, loopStatusTag, reasonView,
  lifecycleTag, extLink, chip, tag, emptyBlock, meter, timeline, searchControl, selectControl, field,
  errorBlock, num,
} from '../lib/components.js';
import {
  agentLabel, flagLabel, codeLabel, duration, matchesQuery, lifecycleMeta, LIFECYCLES, truncate, isPollStale,
  taskRef, plural,
} from '../lib/format.js';
import { taskHref } from '../lib/router.js';
import { isAbort } from '../lib/api.js';

export function createRepoPage(ctx) {
  const repoId = ctx.params.repoId;
  ctx.setTitle(repoId);
  const st = { data: null, error: null };
  const events = { older: [], nextBefore: undefined, loading: false, error: null };

  async function refresh(change) {
    if (change && change.repo_id && change.repo_id !== repoId) return;
    try {
      st.data = await ctx.api.get(`/api/repos/${encodeURIComponent(repoId)}`);
      st.error = null;
    } catch (error) {
      if (isAbort(error)) return;
      st.error = error;
    }
    render();
  }

  async function loadMoreEvents() {
    if (events.loading) return;
    const all = allEvents();
    const before = events.nextBefore ?? (all.length ? Math.min(...all.map((e) => e.sequence)) : null);
    events.loading = true;
    events.error = null;
    render();
    try {
      const page = await ctx.api.get('/api/events', { repo: repoId, before, limit: 50 });
      const seen = new Set(allEvents().map((e) => e.sequence));
      events.older.push(...page.events.filter((e) => !seen.has(e.sequence)));
      events.nextBefore = page.next_before;
    } catch (error) {
      if (isAbort(error)) return;
      events.error = error;
    } finally {
      events.loading = false;
      render();
    }
  }

  function allEvents() {
    const recent = st.data?.recent_events ?? [];
    const seen = new Set(recent.map((e) => e.sequence));
    return [...recent, ...events.older.filter((e) => !seen.has(e.sequence))].sort((a, b) => b.sequence - a.sequence);
  }

  function render() {
    const d = st.data;
    const ov = ctx.overview;
    const attention = ov ? ov.attention.filter((a) => a.repo_id === repoId) : null;
    const body = (fn, lines) => asyncBody(st, fn, { onRetry: () => refresh(null), lines });

    ctx.draw(
      header(d, st, ov),
      section(
        { key: 'repo-attention', title: 'Needs attention', count: attention ? attention.length : null },
        attention ? attentionList(attention, { key: `repo-att-${repoId}`, showRepo: false }) : ctx.overviewError ? errorBlock(ctx.overviewError) : asyncBody({ data: null }, () => null),
      ),
      section({ key: 'slots', title: 'Workspace slots', count: d ? d.slots.length : null, description: d ? poolLine(d.pool) : null }, body((x) => slotGrid(x.slots))),
      h(
        'div.cols-2',
        section({ key: 'retry', title: 'Retry queue', count: d ? d.retry_queue.length : null }, body((x) => retryTable(x.retry_queue, ctx.navigate))),
        section({ key: 'loops', title: 'Loops', count: d ? d.loops.length : null }, body((x) => loopTable(x.loops, ctx.navigate))),
      ),
      section({ key: 'prs', title: 'Pull requests', count: d ? d.pull_requests.length : null }, body((x) => prTable(x.pull_requests))),
      section({ key: 'tasks', title: 'Tasks', count: d ? d.tasks.filter((t) => t.lifecycle !== 'closed').length : null }, body((x) => tasksBlock(x.tasks), 6)),
      h(
        'div.cols-2',
        section({ key: 'repo-epics', title: 'Epics', count: d ? d.epics.length : null }, body((x) => epicList(x.epics))),
        section(
          { key: 'repo-events', title: 'Recent events', actions: h('a.small', { href: `#/events?repo=${encodeURIComponent(repoId)}` }, 'All events') },
          body(() => [
            timeline(allEvents(), { key: `repo-ev-${repoId}`, showTask: true }),
            events.error ? errorBlock(events.error, loadMoreEvents) : null,
            events.nextBefore === null
              ? h('p.small.muted.end-note', 'No older events')
              : allEvents().length
                ? h('button.quiet-button.load-more', { type: 'button', disabled: events.loading || null, on: { click: loadMoreEvents } }, events.loading ? 'Loading…' : 'Load more')
                : null,
          ]),
        ),
      ),
    );
  }

  function header(d, state, ov) {
    const summary = d ?? ov?.repos.find((r) => r.repo_id === repoId) ?? null;
    const pollMs = ov?.orchestrator.polling_interval_ms;
    return h(
      'header.page-head',
      { key: 'repo-head' },
      h(
        'div.page-head-main',
        h('p.crumbs', h('a', { href: '#/' }, 'Overview'), ' / ', 'Repository'),
        h('h1.page-title', repoId, summary ? levelTag(summary.level, null, { className: 'title-tag' }) : null),
        summary
          ? h(
              'div.page-meta',
              summary.owner && summary.repo ? extLink(`https://github.com/${summary.owner}/${summary.repo}`, `${summary.owner}/${summary.repo}`) : null,
              h('span', h('strong.num', `${summary.capacity.running}/${summary.capacity.max_concurrent_agents}`), ' running'),
              h('span', { class: isPollStale(summary, pollMs) ? 'stale' : null }, 'Polled ', timeEl(summary.last_poll_at)),
              summary.enabled ? null : chip('disabled'),
              h('span.mono.small.muted', { title: summary.workflow_path }, truncate(summary.workflow_path, 60)),
            )
          : state.error ? errorBlock(state.error, () => refresh(null)) : null,
      ),
      summary && summary.flags.length
        ? h(
            'ul.flag-detail',
            summary.flags.map((f) =>
              h(
                'li',
                { key: `${f.kind}-${f.message}` },
                levelTag(f.level, flagLabel(f.kind)),
                h('span', f.message),
                f.count != null ? h('span.small.muted', plural(f.count, 'occurrence')) : null,
                f.since ? h('span.small.muted', 'since ', timeEl(f.since)) : null,
              ),
            ),
          )
        : null,
    );
  }

  function tasksBlock(tasks) {
    const q = ctx.query.q ?? '';
    const lifecycle = ctx.query.lifecycle ?? '';
    const matches = (t) =>
      matchesQuery([t.issue_number, t.issue_identifier, t.title, t.labels, t.feature_labels, t.agent_provider, t.agent_mode, t.loop_id, lifecycleMeta(t.lifecycle).label], q);
    const open = tasks.filter((t) => t.lifecycle !== 'closed' && (!lifecycle || t.lifecycle === lifecycle) && matches(t));
    const closed = tasks.filter((t) => t.lifecycle === 'closed' && (!lifecycle || lifecycle === 'closed') && matches(t));
    const counts = new Map();
    for (const t of tasks) counts.set(t.lifecycle, (counts.get(t.lifecycle) ?? 0) + 1);
    const options = [{ value: '', label: 'All lifecycles' }, ...LIFECYCLES.filter((l) => counts.has(l)).map((l) => ({ value: l, label: `${lifecycleMeta(l).label} (${counts.get(l)})` }))];
    return [
      h(
        'div.filter-bar.inline',
        { role: 'search', 'aria-label': 'Filter tasks' },
        field('Search tasks', searchControl({ id: 'repo-search', value: q, placeholder: '#issue, title, label, provider…  ( / )', label: 'Search tasks', onInput: (v) => ctx.setQuery({ q: v }) }), { className: 'grow' }),
        field('Lifecycle', selectControl({ id: 'repo-lifecycle', value: lifecycle, options, label: 'Lifecycle filter', onChange: (v) => ctx.setQuery({ lifecycle: v }) })),
      ),
      lifecycle === 'closed' ? null : taskTable(`repo-tasks-${repoId}`, open, ctx.navigate, q || lifecycle ? 'No tasks match the filter' : 'No open tasks'),
      closed.length
        ? disclosure(`repo-closed-${repoId}`, { summary: `Closed tasks (${closed.length})`, open: lifecycle === 'closed' }, () => taskTable(`repo-closed-${repoId}`, closed, ctx.navigate, 'No closed tasks'))
        : null,
    ];
  }

  return { refresh, render, onOverview: render };
}

function poolLine(pool) {
  return `${pool.slots_in_use} in use · ${pool.slots_protected} protected · ${pool.slots_idle} idle · ${pool.slots_total}${pool.slots_max != null ? ` of ${pool.slots_max} max` : ''} slots`;
}

function slotGrid(slots) {
  if (!slots.length) return emptyBlock('No workspace slots yet');
  return h(
    'ul.slot-grid',
    slots.map((s) =>
      h(
        'li.slot',
        { key: s.name, class: `slot-${s.state}` },
        h('div.slot-head', { class: s.name.length > 22 ? 'stacked' : null }, h('code.slot-name', { title: `${s.name}\n${s.path}` }, s.name), slotTag(s.state)),
        h(
          'div.slot-task',
          { title: s.title ? `${s.issue_number != null ? `#${s.issue_number} ` : ''}${s.title}` : null },
          s.issue_number != null || s.title
            ? taskLink(s.task_key, [s.issue_number != null ? h('span.ref', `#${s.issue_number}`) : null, ' ', s.title ?? ''])
            : h('span.muted', s.kind === 'loop' ? 'Loop workspace' : 'No task'),
        ),
        s.agent_provider || s.updated_at
          ? h('div.slot-meta', s.agent_provider ? h('span', agentLabel(s.agent_provider, s.agent_mode)) : null, s.attempt != null ? h('span', `att ${s.attempt}`) : null, s.updated_at ? timeEl(s.updated_at) : null)
          : null,
        s.protected_reason ? h('p.slot-note.tone-text-bad', h('span', { 'aria-hidden': 'true' }, '◈ '), s.protected_reason) : null,
        s.last_error && !s.protected_reason ? h('p.slot-note.tone-text-bad', { title: s.last_error }, truncate(s.last_error, 120)) : null,
      ),
    ),
  );
}

function retryTable(rows, navigate) {
  return dataTable({
    key: 'retry',
    label: 'Retry queue',
    rows,
    rowKey: (r) => r.task_key,
    rowHref: (r) => taskHref(r.task_key),
    navigate,
    empty: 'Nothing waiting to retry',
    columns: [
      { id: 'issue', label: 'Issue', cell: (r) => taskLink(r.task_key, `#${r.issue_number}`) },
      { id: 'attempt', label: 'Attempt', className: 'r', cell: (r) => num(r.attempt, { zeroQuiet: false }) },
      { id: 'kind', label: 'Failed in', cell: (r) => (r.setup_failure ? tag('◆', 'Setup', 'warn', { title: 'Preparation (checkout/install) failed' }) : tag('▸', 'Agent', 'neutral')) },
      { id: 'reason', label: 'Reason', className: 'cell-clip', cell: (r) => reasonView(r.reason) },
      { id: 'next', label: 'Next run', sort: (r) => Date.parse(r.next_run_at), cell: (r) => timeEl(r.next_run_at) },
    ],
  });
}

function loopMarker(l) {
  if (!l.pause_reason) return null;
  if (/question|needs.?info|input/i.test(l.pause_reason)) return tag('?', 'Question', 'warn', { title: l.pause_reason });
  return tag('‖', 'Paused', 'warn', { title: l.pause_reason });
}

function loopTable(rows, navigate) {
  return dataTable({
    key: 'loops',
    label: 'Loops',
    rows,
    rowKey: (r) => r.task_key,
    rowHref: (r) => taskHref(r.task_key),
    navigate,
    empty: 'No loops configured',
    columns: [
      { id: 'loop', label: 'Loop', cell: (l) => [taskLink(l.task_key, l.loop_id), l.enabled ? null : chip('disabled', { className: 'small' })] },
      { id: 'status', label: 'Status', cell: (l) => [loopStatusTag(l), ' ', loopMarker(l)] },
      { id: 'outcome', label: 'Last outcome', optional: true, cell: (l) => (l.last_outcome ? h('span', { title: l.last_error ?? l.last_outcome }, codeLabel(l.last_outcome)) : h('span.muted', '—')) },
      { id: 'last', label: 'Last run', cell: (l) => timeEl(l.last_finished_at ?? l.last_started_at) },
      { id: 'next', label: 'Next due', cell: (l) => (l.enabled ? timeEl(l.next_due_at) : h('span.muted', '—')) },
      { id: 'every', label: 'Every', optional: true, className: 'r', cell: (l) => h('span.num', duration(l.interval_ms)) },
    ],
  });
}

function prTable(rows) {
  return dataTable({
    key: 'prs',
    label: 'Pull requests',
    rows,
    rowKey: (r) => String(r.number),
    empty: 'No open pull requests tracked',
    columns: [
      { id: 'pr', label: 'PR', sort: (r) => r.number, cell: (r) => extLink(r.url, `#${r.number}`) ?? `#${r.number}` },
      { id: 'title', label: 'Title', cell: (r) => h('span', { title: r.head_ref ? `Branch ${r.head_ref}` : null }, r.title ?? r.head_ref ?? '—') },
      { id: 'issue', label: 'Issue', cell: (r) => (r.issue_number != null ? taskLink(r.task_key, `#${r.issue_number}`) : h('span.muted', '—')) },
      { id: 'labels', label: 'Review', optional: true, cell: (r) => (r.review_labels.length ? h('span.flag-list', r.review_labels.map((l) => chip(l.replace(/^symphony-review:/, ''), { title: l }))) : h('span.muted', '—')) },
      { id: 'claim', label: 'Claim', optional: true, cell: (r) => (r.review_claim_status ? codeLabel(r.review_claim_status) : h('span.muted', '—')) },
      { id: 'round', label: 'Feedback', className: 'r', cell: (r) => (r.feedback_round != null ? h('span.num', `${r.feedback_round}/${r.max_feedback_rounds ?? '?'}`) : h('span.muted', '—')) },
      {
        id: 'blocked', label: 'Merge blocked',
        cell: (r) => (r.merge_blocked_reasons.length
          ? h('ul.reason-list', r.merge_blocked_reasons.map((reason) => h('li', levelGlyph('warn'), ' ', reasonView(reason))))
          : h('span.muted', '—')),
      },
      { id: 'assessed', label: 'Assessed', optional: true, cell: (r) => timeEl(r.last_merge_assessment_at) },
    ],
  });
}

export function taskTable(key, rows, navigate, empty) {
  return dataTable({
    key,
    label: 'Tasks',
    rows,
    rowKey: (t) => t.task_key,
    rowHref: (t) => taskHref(t.task_key),
    navigate,
    empty,
    columns: [
      { id: 'lifecycle', label: 'State', sort: (t) => LIFECYCLES.indexOf(t.lifecycle), cell: (t) => [lifecycleTag(t.lifecycle), t.stale ? [' ', tag('▲', 'Stale', 'warn', { title: 'No state change for longer than the stale threshold' })] : null] },
      { id: 'issue', label: 'Issue', sort: (t) => t.issue_number ?? -1, cell: (t) => taskLink(t.task_key, taskRef(t)) },
      {
        id: 'title', label: 'Title',
        cell: (t) => h(
          'span.task-title',
          h('span', t.title ?? t.issue_identifier),
          t.epic_progress ? chip(`epic ${t.epic_progress}`, { className: 'small' }) : null,
          t.last_error ? h('span.err-line', { title: t.last_error }, truncate(t.last_error, 100)) : null,
        ),
      },
      { id: 'agent', label: 'Agent', optional: true, cell: (t) => h('span.small', agentLabel(t.agent_provider, t.agent_mode)) },
      { id: 'attempt', label: 'Att', title: 'Attempt', className: 'r', optional: true, cell: (t) => num(t.attempt, { zeroQuiet: false }) },
      { id: 'pr', label: 'PR', cell: (t) => (t.pr_number != null ? extLink(t.pr_url, `#${t.pr_number}`) ?? `#${t.pr_number}` : h('span.muted', '—')) },
      { id: 'updated', label: 'Updated', sort: (t) => -Date.parse(t.updated_at), cell: (t) => timeEl(t.updated_at) },
    ],
  });
}

function epicList(epics) {
  if (!epics.length) return emptyBlock('No epics');
  return h(
    'ul.epic-list.detailed',
    epics.map((e) =>
      h(
        'li.epic-item',
        { key: e.task_key },
        disclosure(
          `repo-epic:${e.task_key}`,
          {
            summary: h(
              'span.epic-row',
              h('span.epic-title', h('span.ref', taskRef(e)), ' ', e.title),
              e.status === 'completed' ? tag('✓', 'Completed', 'good') : tag('▸', 'Coordinating', 'accent'),
              meter(e.terminal_children, e.total_children, { label: `${e.terminal_children} of ${e.total_children} children done` }),
            ),
          },
          () => [
            h('p.small', taskLink(e.task_key, 'Open epic'), ' · ', `${e.open_children} open · updated `, timeEl(e.updated_at)),
            epicChildren(e),
          ],
        ),
      ),
    ),
  );
}

export function epicChildren(epic) {
  if (!epic.children.length) return emptyBlock('No children recorded');
  return h(
    'ul.child-list',
    epic.children.map((c) =>
      h(
        'li.child',
        { key: c.issue_identifier },
        c.lifecycle ? lifecycleTag(c.lifecycle) : chip(codeLabel(c.state)),
        c.issue_number != null ? taskLink(`${epic.repo_id}/${c.issue_number}`, `#${c.issue_number}`, { className: 'ref' }) : h('span.ref', c.issue_identifier),
        h('span.child-title', c.title),
        c.queued ? chip('queued', { className: 'small' }) : null,
        c.skipped_reason ? h('span.small.muted', { title: c.skipped_reason }, `skipped: ${truncate(c.skipped_reason, 60)}`) : null,
        extLink(c.issue_url, 'GitHub', { className: 'small' }),
      ),
    ),
  );
}
