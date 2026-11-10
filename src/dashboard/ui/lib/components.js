// Shared view components. Every status is rendered as glyph + text (or glyph
// + screen-reader text with a title), never as color alone.

import { h, sr, ui, disclosure, timeEl, copyText, announce, requestRender } from './dom.js';
import {
  levelMeta, lifecycleMeta, slotMeta, runStatusMeta, attentionLabel, flagLabel, humanize,
  sortRows, prettyJson, LEVEL_RANK, truncate, splitReason, absTime,
} from './format.js';
import { repoHref, taskHref, splitTaskKey } from './router.js';
import { parseMarkdown } from './markdown.js';
import { errorMessage } from './api.js';

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

const LEVEL_TONE = { ok: 'good', warn: 'warn', bad: 'bad', unknown: 'neutral' };

/** Level glyph with screen-reader text; pass `label: null` when adjacent text already states the level. */
export function levelGlyph(level, { title, label } = {}) {
  const meta = levelMeta(level);
  const text = label === undefined ? meta.label : label;
  return h('span.glyph', { class: `tone-${LEVEL_TONE[level] ?? 'neutral'}`, title: title ?? text ?? meta.label }, h('span', { 'aria-hidden': 'true' }, meta.glyph), text ? sr(text) : null);
}

/** Glyph + visible text label. */
export function tag(glyph, label, tone, { title, className } = {}) {
  return h('span.tag', { class: [`tone-${tone}`, className], title }, h('span.tag-glyph', { 'aria-hidden': 'true' }, glyph), h('span.tag-label', label));
}

export function levelTag(level, label, opts = {}) {
  const meta = levelMeta(level);
  return tag(meta.glyph, label ?? meta.label, LEVEL_TONE[level] ?? 'neutral', opts);
}

export function lifecycleTag(lifecycle, opts) {
  const meta = lifecycleMeta(lifecycle);
  return tag(meta.glyph, meta.label, meta.tone, opts);
}

export function slotTag(state, opts) {
  const meta = slotMeta(state);
  return tag(meta.glyph, meta.label, meta.tone, opts);
}

export function runStatusTag(status, opts) {
  const meta = runStatusMeta(status);
  return tag(meta.glyph, meta.label, meta.tone, opts);
}

/**
 * Loop status that does not claim "Never run" when the loop object (or the
 * timeline) shows earlier runs.
 */
export function loopStatusTag(loop, { hasHistory = false } = {}) {
  if (loop.status !== 'never-run') return runStatusTag(loop.status);
  if (loop.last_started_at || loop.last_finished_at) {
    const known = ['completed', 'failed', 'cancelled', 'paused'];
    if (known.includes(loop.last_outcome)) return runStatusTag(loop.last_outcome, { title: 'Last outcome; no current run state' });
    return tag('○', 'Idle', 'neutral', { title: 'Has run before; no current run state' });
  }
  if (hasHistory) return tag('○', 'No run state', 'neutral', { title: 'Events exist for this loop but no run state was found' });
  return runStatusTag('never-run');
}

export function attentionTag(item) {
  return levelTag(item.level, attentionLabel(item.reason), { className: 'tag-reason' });
}

// ---------------------------------------------------------------------------
// Links and chips
// ---------------------------------------------------------------------------

export function repoChip(repoId, { link = true } = {}) {
  if (!repoId) return h('span.chip.chip-repo.muted', 'global');
  return link
    ? h('a.chip.chip-repo', { href: repoHref(repoId), title: `Open ${repoId}` }, repoId)
    : h('span.chip.chip-repo', repoId);
}

export function extLink(href, label, { title, className } = {}) {
  if (!href) return null;
  return h('a.ext', { href, target: '_blank', rel: 'noopener noreferrer', title: title ?? href, class: className }, label, h('span.ext-mark', { 'aria-hidden': 'true' }, '↗'), sr('(opens in a new tab)'));
}

export function taskLink(taskKey, label, { className, title } = {}) {
  const href = taskKey ? taskHref(taskKey) : null;
  if (!href) return h('span', { class: className, title }, label);
  return h('a.task-link', { href, class: className, title }, label);
}

export function chip(text, { title, className } = {}) {
  return h('span.chip', { title, class: className }, text);
}

export function flagChips(flags, max = 3) {
  const list = flags ?? [];
  if (!list.length) return h('span.muted', '—');
  const shown = list.slice(0, max);
  const rest = list.slice(max);
  return h(
    'span.flag-list',
    shown.map((f) => {
      const meta = levelMeta(f.level);
      const count = f.count != null && f.count > 1 ? ` ${f.count}` : '';
      return h('span.chip.flag', { class: `tone-${LEVEL_TONE[f.level] ?? 'neutral'}`, title: f.message }, h('span', { 'aria-hidden': 'true' }, meta.glyph), ` ${flagLabel(f.kind)}${count}`, sr(`: ${f.message}`));
    }),
    rest.length ? h('span.chip.flag', { title: rest.map((f) => `${flagLabel(f.kind)}: ${f.message}`).join('\n') }, `+${rest.length}`) : null,
  );
}

export function copyButton(text, { label = 'Copy', what = 'text' } = {}) {
  return h(
    'button.copy-button',
    {
      type: 'button',
      'aria-label': `Copy ${what}`,
      on: {
        async click(event) {
          const button = event.currentTarget;
          const ok = await copyText(text);
          button.textContent = ok ? 'Copied' : 'Copy failed';
          announce(ok ? `Copied ${what}` : `Could not copy ${what}`);
          setTimeout(() => { button.textContent = label; }, 1500);
        },
      },
    },
    label,
  );
}

/**
 * Server reason: humanize only a leading enum-like code; everything after the
 * first ":" (or any free text) is shown verbatim, in monospace when it follows a code.
 */
export function reasonView(value, { className } = {}) {
  if (value == null || value === '') return h('span.muted', '—');
  const { label, detail } = splitReason(value);
  return h(
    'span.reason',
    { class: className, title: String(value) },
    label ? h('span.reason-code', label) : null,
    label && detail ? ': ' : null,
    detail ? (label ? h('code.reason-detail', detail) : h('span.reason-free', detail)) : null,
  );
}

// ---------------------------------------------------------------------------
// Sections and states
// ---------------------------------------------------------------------------

export function section({ key, title, count, actions, level = 2, className, description }, ...body) {
  const headingId = `h-${String(key).replace(/[^A-Za-z0-9_-]/g, '-')}`;
  return h(
    'section.section',
    { key, class: className, 'aria-labelledby': headingId },
    h(
      'div.section-head',
      h(`h${level}.section-title`, { id: headingId }, title, count != null ? h('span.count', String(count)) : null),
      description ? h('span.section-desc', description) : null,
      actions ? h('div.section-actions', actions) : null,
    ),
    body,
  );
}

export function loadingBlock(lines = 3, label = 'Loading') {
  return h('div.loading', { role: 'status', 'aria-live': 'polite' }, sr(label), Array.from({ length: lines }, (_, i) => h('span.loading-bar', { style: { width: `${[92, 74, 58, 81][i % 4]}%` } })));
}

export function errorBlock(error, onRetry) {
  return h(
    'div.error-block',
    { role: 'alert' },
    levelGlyph('bad', { label: 'Error' }),
    h('span', errorMessage(error)),
    onRetry ? h('button.quiet-button.small', { type: 'button', on: { click: onRetry } }, 'Retry') : null,
  );
}

export function emptyBlock(text, { tone = 'quiet' } = {}) {
  return h('p.empty', { class: `empty-${tone}` }, text);
}

/**
 * Per-section async state: show loading while nothing is loaded, an error
 * when the first load fails, and keep stale data (with a note) on refresh errors.
 */
export function asyncBody(state, renderData, { lines = 3, onRetry } = {}) {
  if (state.error && state.data == null) return errorBlock(state.error, onRetry);
  if (state.data == null) return loadingBlock(lines);
  return [
    state.error ? h('p.stale-note', levelGlyph('warn'), ` Showing earlier data; refresh failed: ${errorMessage(state.error)}`) : null,
    renderData(state.data),
  ];
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/**
 * dataTable({ key, label, columns, rows, rowKey, rowHref, empty, rowClass })
 * column: { id, label, cell(row), sort?(row), className, optional, title }
 */
export function dataTable({ key, label, caption, columns, rows, rowKey, rowHref, empty = 'Nothing here', rowClass, navigate }) {
  const sort = ui.get(`sort:${key}`, null);
  let sorted = rows;
  if (sort) {
    const column = columns.find((c) => c.id === sort.id);
    if (column?.sort) sorted = sortRows(rows, column.sort, sort.dir);
  }
  const header = h(
    'tr',
    columns.map((column) => {
      const active = sort && sort.id === column.id;
      const ariaSort = active ? (sort.dir === 1 ? 'ascending' : 'descending') : column.sort ? 'none' : null;
      const content = column.sort
        ? h(
            'button.sort-button',
            {
              type: 'button',
              title: `Sort by ${column.label}`,
              on: {
                click() {
                  const current = ui.get(`sort:${key}`, null);
                  let next;
                  if (!current || current.id !== column.id) next = { id: column.id, dir: 1 };
                  else if (current.dir === 1) next = { id: column.id, dir: -1 };
                  else next = null;
                  ui.set(`sort:${key}`, next);
                  requestRender();
                },
              },
            },
            column.label,
            h('span.sort-mark', { 'aria-hidden': 'true' }, active ? (sort.dir === 1 ? '↑' : '↓') : '↕'),
          )
        : column.label;
      return h('th', { scope: 'col', class: [column.className, column.optional ? 'col-opt' : null], 'aria-sort': ariaSort, title: column.title }, content);
    }),
  );
  const body = sorted.length
    ? sorted.map((row) => {
        const href = rowHref ? rowHref(row) : null;
        return h(
          'tr',
          {
            key: rowKey(row),
            class: [href ? 'row-link' : null, rowClass ? rowClass(row) : null],
            on: href && navigate
              ? {
                  click(event) {
                    if (event.target.closest('a, button, summary, input, select, details')) return;
                    if (window.getSelection()?.toString()) return;
                    navigate(href);
                  },
                }
              : null,
          },
          columns.map((column, i) =>
            h(i === 0 ? 'th' : 'td', { scope: i === 0 ? 'row' : null, class: [column.className, column.optional ? 'col-opt' : null] }, column.cell(row)),
          ),
        );
      })
    : [h('tr', h('td.table-empty', { colspan: String(columns.length) }, empty))];
  return h(
    'div.table-wrap',
    { key: `tw-${key}` },
    h('table.data', { 'aria-label': caption ? null : label }, caption ? h('caption.sr-only', caption) : null, h('thead', header), h('tbody', body)),
  );
}

export function num(value, { zeroQuiet = true } = {}) {
  if (value == null) return h('span.num.muted', '—');
  return h('span.num', { class: zeroQuiet && value === 0 ? 'zero' : null }, String(value));
}

// ---------------------------------------------------------------------------
// Attention
// ---------------------------------------------------------------------------

const GROUPS = [
  { level: 'bad', label: 'Needs action' },
  { level: 'warn', label: 'Warnings' },
  { level: 'ok', label: 'Waiting on you' },
  { level: 'other', label: 'Other' },
];

export function attentionList(items, { key = 'attention', showRepo = true } = {}) {
  if (!items.length) return emptyBlock('Nothing needs you', { tone: 'calm' });
  const grouped = new Map(GROUPS.map((g) => [g.level, []]));
  for (const item of items) {
    const g = item.level === 'bad' || item.level === 'warn' || item.level === 'ok' ? item.level : 'other';
    grouped.get(g).push(item);
  }
  return h(
    'div.attention',
    GROUPS.filter((g) => grouped.get(g.level).length).map((g) =>
      h(
        'div.att-group',
        { key: `${key}-${g.level}` },
        h('h3.group-title', g.level === 'other' ? null : levelGlyph(g.level, { label: null }), ` ${g.label}`, h('span.count', String(grouped.get(g.level).length))),
        h('ul.att-list', grouped.get(g.level).map((item) => attentionRow(item, { key, showRepo }))),
      ),
    ),
  );
}

function attentionRow(item, { key, showRepo }) {
  const titleText = item.title || attentionLabel(item.reason);
  // Some producers already prefix the title with the issue ref; do not repeat it.
  const ref = item.issue_number != null && !titleText.startsWith(`#${item.issue_number}`) ? `#${item.issue_number}` : null;
  const expandKey = `expand:${key}:${item.id}`;
  const expanded = ui.get(expandKey, false);
  const detailId = `att-detail-${String(item.id).replace(/[^A-Za-z0-9_-]/g, '-')}`;
  const canExpand = Boolean(item.detail && (item.detail.length > 48 || item.workspace_path));
  return h(
    'li.att-row',
    { key: item.id, class: [`lvl-${item.level}`, expanded ? 'expanded' : null] },
    h('span.att-reason', attentionTag(item)),
    showRepo ? h('span.att-repo', repoChip(item.repo_id)) : null,
    h(
      'span.att-main',
      h(
        'span.att-title',
        { title: titleText },
        item.task_key ? taskLink(item.task_key, [ref ? [h('span.ref', ref), ' '] : null, titleText]) : [ref ? [h('span.ref', ref), ' '] : null, titleText],
      ),
      item.detail && !expanded ? h('span.att-detail', { title: item.detail }, item.detail) : null,
    ),
    h(
      'span.att-meta',
      extLink(item.issue_url, item.issue_number != null ? `#${item.issue_number}` : 'Issue', { className: 'meta-link', title: `Issue ${item.issue_url ?? ''}` }),
      extLink(item.pr_url, item.pr_number != null ? `PR #${item.pr_number}` : 'PR', { className: 'meta-link', title: `Pull request ${item.pr_url ?? ''}` }),
      item.since ? timeEl(item.since, { className: 'since' }) : null,
      canExpand
        ? h(
            'button.link-button',
            {
              type: 'button',
              'aria-expanded': expanded ? 'true' : 'false',
              'aria-controls': detailId,
              'aria-label': `${expanded ? 'Hide' : 'Show'} details for ${titleText}`,
              on: { click() { ui.set(expandKey, !expanded); requestRender(); } },
            },
            expanded ? 'less' : 'more',
          )
        : null,
    ),
    expanded
      ? h('div.att-full', { id: detailId }, h('p.detail-full', item.detail), item.workspace_path ? h('p.path-line', h('code', item.workspace_path), copyButton(item.workspace_path, { what: 'workspace path' })) : null)
      : null,
  );
}

// ---------------------------------------------------------------------------
// Timeline (TimelineEntry and EpisodeEventSummary)
// ---------------------------------------------------------------------------

export function timelineKey(entry, index, seen) {
  if (entry.sequence != null) return `seq-${entry.sequence}`;
  const base = `${entry.at ?? entry.created_at}|${entry.event}`;
  const n = (seen.get(base) ?? 0) + 1;
  seen.set(base, n);
  return n > 1 ? `${base}|${n}` : base;
}

/** "×N" marker for collapsed repeats (TimelineEntry and EpisodeEventSummary). */
export function repeatTag(entry) {
  const n = entry.repeat_count;
  if (!n || n <= 1) return null;
  const since = absTime(entry.first_at);
  return h('span.chip.repeat', { title: `Repeated ${n} times${since ? ` since ${since}` : ''}` }, `×${n}`, h('span.sr-only', ` (repeated ${n} times)`));
}

function taskKeyLabel(entry) {
  if (entry.issue_number != null) return `#${entry.issue_number}`;
  const parts = splitTaskKey(entry.task_key);
  return parts?.loopId ? `loop ${parts.loopId}` : 'task';
}

export function timeline(entries, { key = 'timeline', showRepo = false, showTask = showRepo, empty = 'No events recorded yet' } = {}) {
  if (!entries.length) return emptyBlock(empty);
  const seen = new Map();
  return h(
    'ol.timeline',
    entries.map((entry, index) => {
      const id = timelineKey(entry, index, seen);
      const at = entry.at ?? entry.created_at;
      const payload = entry.payload ?? {};
      const hasPayload = Object.keys(payload).length > 0;
      return h(
        'li.tl-item',
        { key: id, class: `lvl-${entry.level}` },
        h('span.tl-glyph', levelGlyph(entry.level)),
        h(
          'div.tl-body',
          h(
            'div.tl-line',
            h('span.tl-summary', entry.summary || humanize(entry.event)),
            repeatTag(entry),
            showRepo ? repoChip(entry.repo_id) : null,
            showTask && entry.task_key ? taskLink(entry.task_key, taskKeyLabel(entry), { className: 'small' }) : null,
            showTask && entry.pr_number != null ? h('span.small.muted', `PR #${entry.pr_number}`) : null,
          ),
          h(
            'div.tl-meta',
            h('code.tl-event', entry.event),
            timeEl(at, { className: 'small muted' }),
            hasPayload ? disclosure(`${key}:payload:${id}`, { summary: 'payload', className: 'payload' }, () => h('pre.code', prettyJson(payload))) : null,
          ),
        ),
      );
    }),
  );
}

// ---------------------------------------------------------------------------
// Small visuals
// ---------------------------------------------------------------------------

export function meter(value, max, { label } = {}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return h(
    'span.meter-wrap',
    h('span.meter', { role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': String(max), 'aria-valuenow': String(value), 'aria-label': label ?? `${value} of ${max}` }, h('span.meter-fill', { style: { width: `${pct}%` } })),
    h('span.num.small', `${value}/${max}`),
  );
}

const SVG = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
  for (const c of children.flat()) if (c) el.appendChild(c);
  return el;
}

/** Tiny line of values (e.g. merged per week). Purely informational. */
export function sparkline(values, { label, width = 96, height = 24 } = {}) {
  const n = values.length;
  if (!n) return null;
  const max = Math.max(1, ...values);
  const step = n > 1 ? (width - 4) / (n - 1) : 0;
  const pts = values.map((v, i) => [2 + i * step, height - 3 - (v / max) * (height - 6)]);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  return svg(
    'svg',
    { class: 'spark', width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': label ?? values.join(', ') },
    svg('title', {}, document.createTextNode(label ?? values.join(', '))),
    svg('line', { x1: 2, x2: width - 2, y1: height - 3, y2: height - 3, class: 'spark-base' }),
    svg('path', { d, class: 'spark-line' }),
    ...pts.map(([x, y]) => svg('circle', { cx: x.toFixed(1), cy: y.toFixed(1), r: 1.8, class: 'spark-dot' })),
  );
}

// ---------------------------------------------------------------------------
// Markdown and preformatted text
// ---------------------------------------------------------------------------

function inlineNodes(nodes) {
  return nodes.map((n) => {
    if (n.type === 'text') return n.text;
    if (n.type === 'code') return h('code', n.text);
    if (n.type === 'strong') return h('strong', inlineNodes(n.children));
    if (n.type === 'em') return h('em', inlineNodes(n.children));
    if (n.type === 'link') return h('a', { href: n.href, target: '_blank', rel: 'noopener noreferrer' }, inlineNodes(n.children));
    return '';
  });
}

export function markdownView(text, { className } = {}) {
  const blocks = parseMarkdown(text);
  if (!blocks.length) return emptyBlock('Empty');
  return h(
    'div.md',
    { class: className },
    blocks.map((b) => {
      switch (b.type) {
        case 'heading': return h(`h${Math.min(6, b.level + 2)}`, { class: `md-h${b.level}` }, inlineNodes(b.inline));
        case 'paragraph': return h('p', inlineNodes(b.inline));
        case 'quote': return h('blockquote', inlineNodes(b.inline));
        case 'rule': return h('hr');
        case 'code': return h('pre.code', { 'data-lang': b.lang }, h('code', b.text));
        case 'list': return h(b.ordered ? 'ol' : 'ul', { start: b.ordered && b.start !== 1 ? String(b.start) : null }, b.items.map((item) => h('li', { class: item.depth ? `depth-${item.depth}` : null }, inlineNodes(item.inline))));
        default: return null;
      }
    }),
  );
}

/** Preformatted text, collapsed behind a disclosure when long. */
export function longPre(key, text, { className = 'code', maxLines = 12, summary = 'Show full text' } = {}) {
  const s = String(text ?? '');
  const lines = s.split('\n');
  if (lines.length <= maxLines && s.length <= 900) return h('pre', { class: className }, s);
  const preview = truncate(lines.slice(0, Math.min(maxLines, 6)).join('\n'), 600);
  const open = ui.get(`open:${key}`, false);
  return h(
    'div.long-pre',
    { key },
    open ? null : h('pre', { class: className }, preview),
    disclosure(key, { summary: open ? 'Show less' : `${summary} (${lines.length} lines)` }, () => h('pre', { class: className }, s)),
  );
}

// ---------------------------------------------------------------------------
// Tabs (ARIA tablist with arrow-key support)
// ---------------------------------------------------------------------------

export function tabList({ key, label, tabs, selected, onSelect }) {
  return h(
    'div.tabs',
    { role: 'tablist', 'aria-label': label, key },
    tabs.map((t) =>
      h(
        'button.tab',
        {
          type: 'button',
          role: 'tab',
          id: `tab-${key}-${t.id}`,
          'aria-selected': t.id === selected ? 'true' : 'false',
          'aria-controls': `panel-${key}`,
          tabindex: t.id === selected ? '0' : '-1',
          disabled: t.disabled || null,
          title: t.title,
          on: {
            click() { onSelect(t.id); },
            keydown(event) {
              const enabled = tabs.filter((x) => !x.disabled);
              const i = enabled.findIndex((x) => x.id === t.id);
              let next = null;
              if (event.key === 'ArrowRight') next = enabled[(i + 1) % enabled.length];
              else if (event.key === 'ArrowLeft') next = enabled[(i - 1 + enabled.length) % enabled.length];
              else if (event.key === 'Home') next = enabled[0];
              else if (event.key === 'End') next = enabled[enabled.length - 1];
              if (!next) return;
              event.preventDefault();
              onSelect(next.id);
              requestAnimationFrame(() => document.getElementById(`tab-${key}-${next.id}`)?.focus());
            },
          },
        },
        t.label,
        t.count != null ? h('span.count', String(t.count)) : null,
      ),
    ),
  );
}

export function tabPanel(key, selected, ...children) {
  return h('div.tab-panel', { role: 'tabpanel', id: `panel-${key}`, 'aria-labelledby': `tab-${key}-${selected}`, tabindex: '0' }, children);
}

// ---------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------

export function field(label, control, { className } = {}) {
  return h('label.field', { class: className }, h('span.field-label', label), control);
}

export function selectControl({ value, options, onChange, label, id }) {
  return h(
    'select.control',
    { id, 'aria-label': label, value, on: { change(event) { onChange(event.currentTarget.value); } } },
    options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(value) }, o.label)),
  );
}

export function searchControl({ value, placeholder, onInput, label, id }) {
  return h('input.control.search', {
    id,
    type: 'search',
    value: value ?? '',
    placeholder,
    'aria-label': label,
    autocomplete: 'off',
    spellcheck: 'false',
    'data-page-search': '',
    on: { input(event) { onInput(event.currentTarget.value); } },
  });
}

export { LEVEL_RANK, LEVEL_TONE };
