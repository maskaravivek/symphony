// Pure formatting helpers. No DOM access; safe to import from node tests.

export const LEVEL_RANK = { bad: 0, warn: 1, unknown: 2, ok: 3 };

const LEVEL_META = {
  ok: { glyph: '✓', label: 'OK' },
  warn: { glyph: '▲', label: 'Warning' },
  bad: { glyph: '✕', label: 'Needs action' },
  unknown: { glyph: '?', label: 'Unknown' },
};

export function levelMeta(level) {
  return LEVEL_META[level] ?? LEVEL_META.unknown;
}

/** Anything before 2000-01-01 (e.g. a zeroed epoch) is treated as unknown. */
export const MIN_VALID_TIME = Date.UTC(2000, 0, 1);

export function parseTime(value) {
  if (value == null || value === '') return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) && ms >= MIN_VALID_TIME ? ms : null;
}

export function isValidTime(value) {
  return parseTime(value) != null;
}

/** Humanized duration: 45s, 3m 12s, 2h 14m, 3d 4h. */
export function duration(ms, { precise = false } = {}) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const negative = ms < 0;
  let s = Math.floor(Math.abs(ms) / 1000);
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  let out;
  if (d > 0) out = h ? `${d}d ${h}h` : `${d}d`;
  else if (h > 0) out = m ? `${h}h ${m}m` : `${h}h`;
  else if (m > 0) out = precise || m < 10 ? (s ? `${m}m ${s}s` : `${m}m`) : `${m}m`;
  else out = `${s}s`;
  return negative ? `-${out}` : out;
}

/** Relative time: "just now", "3m ago", "in 4m", "2d ago". */
export function relTime(value, now = Date.now()) {
  const t = parseTime(value);
  if (t == null) return '—';
  const diff = now - t;
  const abs = Math.abs(diff);
  if (abs < 5000) return 'just now';
  const text = duration(abs).split(' ')[0];
  return diff >= 0 ? `${text} ago` : `in ${text}`;
}

const pad = (n) => String(n).padStart(2, '0');

/** Absolute local time for title attributes: 2026-11-10 14:03:22 (local). */
export function absTime(value) {
  const t = parseTime(value);
  if (t == null) return '';
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Short date for week labels: "Nov 3". */
export function shortDate(value) {
  const t = parseTime(value);
  if (t == null) return '—';
  const d = new Date(t);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** 259312 → 259k, 1834 → 1.8k, 2300000 → 2.3M, 950 → 950. */
export function compactNumber(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const fmt = (v, suffix) => {
    const rounded = v >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
    return `${n < 0 ? '-' : ''}${String(rounded).replace(/\.0$/, '')}${suffix}`;
  };
  if (abs >= 1e9) return fmt(abs / 1e9, 'B');
  if (abs >= 1e6) return fmt(abs / 1e6, 'M');
  if (abs >= 1e3) {
    const k = abs / 1e3;
    if (k >= 999.5) return fmt(abs / 1e6, 'M');
    return fmt(k, 'k');
  }
  return String(Math.round(n));
}

export function tokenSummary(usage) {
  if (!usage) return '—';
  return `${compactNumber(usage.input_tokens)} in · ${compactNumber(usage.output_tokens)} out`;
}

export function tokenTitle(usage) {
  if (!usage) return 'No token usage recorded';
  const nf = (v) => Number(v ?? 0).toLocaleString('en-US');
  const share = usage.input_tokens > 0 ? Math.round((usage.cached_input_tokens / usage.input_tokens) * 100) : 0;
  return `${nf(usage.input_tokens)} input tokens (${share}% cached, ${nf(usage.cached_input_tokens)}) · ${nf(usage.output_tokens)} output tokens · ${nf(usage.turns)} turn${usage.turns === 1 ? '' : 's'}`;
}

/** snake_case / kebab-case / dotted → "Sentence case". */
export function humanize(value) {
  if (value == null) return '';
  const text = String(value).replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Enum-like codes (`runner_error`, `merge.blocked`, `retry-wait`) may be humanized.
// Anything else is server-provided free text and must be shown verbatim.
const CODE_RE = /^[a-z][a-z0-9]*(?:[_.-][a-z0-9]+)*$/;

export function isCode(value) {
  return value != null && CODE_RE.test(String(value));
}

/** Humanize only enum-like codes; return free text unchanged. */
export function codeLabel(value) {
  if (value == null) return '';
  const s = String(value);
  return CODE_RE.test(s) ? humanize(s) : s;
}

/**
 * Split "code: free text" reasons. Only the leading code is humanized:
 * "runner_error: Command failed: git merge-base" →
 * { label: "Runner error", detail: "Command failed: git merge-base" }.
 * Free text without a code prefix → { label: null, detail: text }.
 */
export function splitReason(value) {
  const s = String(value ?? '');
  const idx = s.indexOf(':');
  if (idx > 0 && CODE_RE.test(s.slice(0, idx))) {
    const detail = s.slice(idx + 1).trim();
    return { label: humanize(s.slice(0, idx)), detail: detail || null };
  }
  if (CODE_RE.test(s)) return { label: humanize(s), detail: null };
  return { label: null, detail: s || null };
}

/** One-line plain-text version of splitReason (for titles, lists, search). */
export function reasonText(value) {
  const { label, detail } = splitReason(value);
  return [label, detail].filter(Boolean).join(': ');
}

export const ATTENTION_LABELS = {
  orchestrator_down: 'Orchestrator down',
  needs_info: 'Needs your answer',
  loop_question: 'Loop has a question',
  waiting_human: 'Waiting for you',
  ready_for_review: 'Waiting for review',
  review_blocked: 'Review blocked',
  review_error: 'Review errored',
  retry_exhausted: 'Retries exhausted',
  failed: 'Failed',
  loop_failed: 'Loop failed',
  protected_workspace: 'Protected workspace',
  dispatch_deferred: 'Dispatch deferred',
  pool_exhausted: 'Pool exhausted',
  merge_blocked: 'Merge blocked',
  provider_backoff: 'Provider backoff',
  github_backoff: 'GitHub backoff',
  storage_blocked: 'Storage blocked',
  stale_run: 'Stale run',
};

export function attentionLabel(reason) {
  return ATTENTION_LABELS[reason] ?? codeLabel(reason);
}

export const FLAG_LABELS = {
  dispatch_deferred: 'Deferred',
  protected_workspaces: 'Protected',
  provider_backoff: 'Provider backoff',
  github_backoff: 'GitHub backoff',
  storage_blocked: 'Storage',
  tick_error: 'Tick error',
  stale_poll: 'Stale poll',
  no_heartbeat: 'No heartbeat',
  retry_exhausted: 'Retries exhausted',
  loop_failed: 'Loop failed',
  pool_exhausted: 'Pool full',
};

export function flagLabel(kind) {
  return FLAG_LABELS[kind] ?? codeLabel(kind);
}

const LIFECYCLE_META = {
  queued: { glyph: '○', label: 'Queued', tone: 'neutral' },
  running: { glyph: '▸', label: 'Running', tone: 'accent' },
  retrying: { glyph: '↻', label: 'Retrying', tone: 'warn' },
  'needs-info': { glyph: '?', label: 'Needs info', tone: 'warn' },
  blocked: { glyph: '⊘', label: 'Blocked', tone: 'bad' },
  'review-blocked': { glyph: '⊘', label: 'Review blocked', tone: 'review' },
  'review-error': { glyph: '!', label: 'Review error', tone: 'bad' },
  'ready-for-review': { glyph: '◇', label: 'Ready for review', tone: 'review' },
  'waiting-human': { glyph: '◷', label: 'Waiting for human', tone: 'good' },
  failed: { glyph: '✕', label: 'Failed', tone: 'bad' },
  cancelled: { glyph: '–', label: 'Cancelled', tone: 'neutral' },
  closed: { glyph: '✓', label: 'Closed', tone: 'neutral' },
};

export const LIFECYCLES = Object.keys(LIFECYCLE_META);

export function lifecycleMeta(lifecycle) {
  return LIFECYCLE_META[lifecycle] ?? { glyph: '?', label: codeLabel(lifecycle) || 'Unknown', tone: 'neutral' };
}

const SLOT_META = {
  running: { glyph: '▸', label: 'Running', tone: 'accent' },
  preparing: { glyph: '◌', label: 'Preparing', tone: 'accent' },
  reserved: { glyph: '◇', label: 'Reserved', tone: 'neutral' },
  paused: { glyph: '‖', label: 'Paused', tone: 'warn' },
  'retry-wait': { glyph: '↻', label: 'Retry wait', tone: 'warn' },
  protected: { glyph: '◈', label: 'Protected', tone: 'bad' },
  idle: { glyph: '○', label: 'Idle', tone: 'neutral' },
  completed: { glyph: '✓', label: 'Completed', tone: 'good' },
  failed: { glyph: '✕', label: 'Failed', tone: 'bad' },
  unknown: { glyph: '?', label: 'Unknown', tone: 'neutral' },
};

export function slotMeta(state) {
  return SLOT_META[state] ?? SLOT_META.unknown;
}

const RUN_STATUS_META = {
  preparing: { glyph: '◌', label: 'Preparing', tone: 'accent' },
  'agent-running': { glyph: '▸', label: 'Running', tone: 'accent' },
  finalizing: { glyph: '◌', label: 'Finalizing', tone: 'accent' },
  'retry-wait': { glyph: '↻', label: 'Retry wait', tone: 'warn' },
  completed: { glyph: '✓', label: 'Completed', tone: 'good' },
  failed: { glyph: '✕', label: 'Failed', tone: 'bad' },
  cancelled: { glyph: '–', label: 'Cancelled', tone: 'neutral' },
  paused: { glyph: '‖', label: 'Paused', tone: 'warn' },
  'never-run': { glyph: '○', label: 'Never run', tone: 'neutral' },
};

export function runStatusMeta(status) {
  return RUN_STATUS_META[status] ?? { glyph: '?', label: codeLabel(status) || 'Unknown', tone: 'neutral' };
}

const MODE_LABELS = {
  autonomous: 'autonomous',
  grooming: 'grooming',
  'interactive-handoff': 'handoff',
  planning: 'planning',
  'resolve-conflicts': 'conflicts',
  'pr-review': 'PR review',
};

export function modeLabel(mode) {
  if (!mode) return null;
  return MODE_LABELS[mode] ?? String(mode);
}

export function agentLabel(provider, mode) {
  return [provider, modeLabel(mode)].filter(Boolean).join(' · ') || '—';
}

export function truncate(text, max) {
  if (text == null) return '';
  const s = String(text);
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
}

/** "#1144" for issues, "loop daily-steward" for loops. */
export function taskRef(task) {
  if (!task) return '';
  if (task.loop_id) return `loop ${task.loop_id}`;
  if (task.issue_number != null) return `#${task.issue_number}`;
  return task.issue_identifier ?? task.task_key ?? '';
}

/**
 * Whitespace-separated tokens; every token must appear in at least one field.
 * "#123" and "123" both match issue number 123.
 */
export function matchesQuery(fields, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return true;
  const hay = fields
    .flat()
    .filter((v) => v != null && v !== '')
    .map((v) => String(v).toLowerCase())
    .join('\n');
  return q.split(/\s+/).every((token) => {
    const t = token.replace(/^#(?=\d)/, '');
    return hay.includes(t) || hay.includes(token);
  });
}

/** Stable sort by a key function. dir: 1 asc, -1 desc. Nulls last. */
export function sortRows(rows, keyFn, dir = 1) {
  return rows
    .map((row, i) => ({ row, i, k: keyFn(row) }))
    .sort((a, b) => {
      const an = a.k == null;
      const bn = b.k == null;
      if (an || bn) return an === bn ? a.i - b.i : an ? 1 : -1;
      if (a.k < b.k) return -dir;
      if (a.k > b.k) return dir;
      return a.i - b.i;
    })
    .map((x) => x.row);
}

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

export function prettyJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Whether a repo's last poll should be styled as stale. */
export function isPollStale(repo, pollingIntervalMs) {
  if (!repo || repo.enabled === false) return false;
  if ((repo.flags ?? []).some((f) => f.kind === 'stale_poll' || f.kind === 'no_heartbeat')) return true;
  if (repo.poll_age_ms == null) return repo.last_poll_at == null;
  const limit = Math.max(2 * (pollingIntervalMs ?? 30000), 120000);
  return repo.poll_age_ms > limit;
}
