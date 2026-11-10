import test from 'node:test';
import assert from 'node:assert/strict';
import {
  duration, relTime, compactNumber, tokenSummary, tokenTitle, humanize, attentionLabel, matchesQuery,
  sortRows, lifecycleMeta, levelMeta, isPollStale, taskRef, truncate, flagLabel,
} from './format.js';

test('duration humanizes milliseconds', () => {
  assert.equal(duration(0), '0s');
  assert.equal(duration(45_000), '45s');
  assert.equal(duration(3 * 60_000 + 12_000), '3m 12s');
  assert.equal(duration(12 * 60_000 + 30_000), '12m');
  assert.equal(duration((2 * 60 + 14) * 60_000), '2h 14m');
  assert.equal(duration(3 * 86_400_000 + 4 * 3_600_000), '3d 4h');
  assert.equal(duration(null), '—');
});

test('relTime handles past, future and now', () => {
  const now = Date.parse('2026-11-10T15:00:00Z');
  assert.equal(relTime('2026-11-10T14:57:00Z', now), '3m ago');
  assert.equal(relTime('2026-11-10T15:04:00Z', now), 'in 4m');
  assert.equal(relTime('2026-11-10T14:59:58Z', now), 'just now');
  assert.equal(relTime('2026-11-08T15:00:00Z', now), '2d ago');
  assert.equal(relTime(null, now), '—');
  assert.equal(relTime('garbage', now), '—');
});

test('compactNumber and token summaries', () => {
  assert.equal(compactNumber(950), '950');
  assert.equal(compactNumber(1834), '1.8k');
  assert.equal(compactNumber(259_312), '259k');
  assert.equal(compactNumber(999_999), '1M');
  assert.equal(compactNumber(2_300_000), '2.3M');
  assert.equal(tokenSummary({ input_tokens: 259_312, cached_input_tokens: 218_400, output_tokens: 1834, turns: 7 }), '259k in · 1.8k out');
  assert.match(tokenTitle({ input_tokens: 1000, cached_input_tokens: 840, output_tokens: 10, turns: 1 }), /84% cached/);
  assert.equal(tokenSummary(null), '—');
});

test('humanize and reason labels', () => {
  assert.equal(humanize('workspace_preparation_failed'), 'Workspace preparation failed');
  assert.equal(humanize('merge.blocked'), 'Merge blocked');
  assert.equal(attentionLabel('needs_info'), 'Needs your answer');
  assert.equal(attentionLabel('retry_exhausted'), 'Retries exhausted');
  assert.equal(attentionLabel('brand_new_reason'), 'Brand new reason');
  assert.equal(flagLabel('pool_exhausted'), 'Pool full');
});

test('matchesQuery matches tokens across fields, with #issue support', () => {
  const fields = ['mdedit', 1144, 'Export to PDF drops images', ['symphony', 'area:export'], 'codex'];
  assert.ok(matchesQuery(fields, ''));
  assert.ok(matchesQuery(fields, '#1144'));
  assert.ok(matchesQuery(fields, '1144 codex'));
  assert.ok(matchesQuery(fields, 'area:export'));
  assert.ok(matchesQuery(fields, 'PDF'));
  assert.ok(!matchesQuery(fields, 'claude'));
  assert.ok(!matchesQuery(fields, 'pdf claude'));
});

test('sortRows is stable and puts nulls last', () => {
  const rows = [{ k: 2, id: 'a' }, { k: null, id: 'b' }, { k: 1, id: 'c' }, { k: 2, id: 'd' }];
  assert.deepEqual(sortRows(rows, (r) => r.k, 1).map((r) => r.id), ['c', 'a', 'd', 'b']);
  assert.deepEqual(sortRows(rows, (r) => r.k, -1).map((r) => r.id), ['a', 'd', 'c', 'b']);
});

test('status metadata always carries a glyph and a label', () => {
  for (const l of ['queued', 'running', 'retrying', 'needs-info', 'blocked', 'review-blocked', 'review-error', 'ready-for-review', 'waiting-human', 'failed', 'cancelled', 'closed', 'mystery']) {
    const meta = lifecycleMeta(l);
    assert.ok(meta.glyph && meta.label, l);
  }
  for (const l of ['ok', 'warn', 'bad', 'unknown', 'x']) assert.ok(levelMeta(l).glyph);
  assert.notEqual(levelMeta('ok').glyph, levelMeta('bad').glyph);
  assert.notEqual(levelMeta('warn').glyph, levelMeta('bad').glyph);
});

test('isPollStale uses flags, age and interval', () => {
  assert.equal(isPollStale({ flags: [], poll_age_ms: 10_000, last_poll_at: 'x' }, 30_000), false);
  assert.equal(isPollStale({ flags: [], poll_age_ms: 1_400_000, last_poll_at: 'x' }, 30_000), true);
  assert.equal(isPollStale({ flags: [{ kind: 'stale_poll' }], poll_age_ms: 1000, last_poll_at: 'x' }, 30_000), true);
  assert.equal(isPollStale({ flags: [], poll_age_ms: null, last_poll_at: null }, 30_000), true);
  assert.equal(isPollStale({ enabled: false, flags: [{ kind: 'no_heartbeat' }], poll_age_ms: null, last_poll_at: null }, 30_000), false);
});

test('taskRef and truncate', () => {
  assert.equal(taskRef({ issue_number: 12, loop_id: null }), '#12');
  assert.equal(taskRef({ issue_number: null, loop_id: 'daily' }), 'loop daily');
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate('abc', 4), 'abc');
});

import { splitReason, codeLabel, reasonText, isCode, parseTime, absTime } from './format.js';

test('splitReason humanizes only the leading code', () => {
  assert.deepEqual(splitReason('runner_error: Command failed: git merge-base --is-ancestor eaefe93c... HEAD'), {
    label: 'Runner error',
    detail: 'Command failed: git merge-base --is-ancestor eaefe93c... HEAD',
  });
  assert.deepEqual(splitReason('verification_failed'), { label: 'Verification failed', detail: null });
  assert.deepEqual(splitReason('Pull request is not mergeable'), { label: null, detail: 'Pull request is not mergeable' });
  assert.deepEqual(splitReason('Workspace pool limit (4) reached; resume'), { label: null, detail: 'Workspace pool limit (4) reached; resume' });
  assert.equal(reasonText('preparation_error: Workspace pool limit (4) reached'), 'Preparation error: Workspace pool limit (4) reached');
});

test('codeLabel leaves free text untouched', () => {
  assert.equal(codeLabel('retry-scheduled'), 'Retry scheduled');
  assert.equal(codeLabel('merge.blocked'), 'Merge blocked');
  assert.equal(codeLabel('Command failed: git merge-base --is-ancestor'), 'Command failed: git merge-base --is-ancestor');
  assert.equal(codeLabel('needs-info: question posted'), 'needs-info: question posted');
  assert.ok(isCode('runner_error'));
  assert.ok(!isCode('Runner error'));
});

test('dates before 2000 or invalid render as unknown', () => {
  const now = Date.parse('2026-11-10T15:00:00Z');
  assert.equal(parseTime('1970-01-01T00:00:00.000Z'), null);
  assert.equal(parseTime(0), null);
  assert.equal(relTime('1970-01-01T00:00:00.000Z', now), '—');
  assert.equal(absTime('1970-01-01T00:00:00.000Z'), '');
  assert.equal(relTime('not-a-date', now), '—');
  assert.ok(parseTime('2026-11-10T15:00:00Z') > 0);
});
