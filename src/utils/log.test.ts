import assert from 'node:assert/strict';
import test from 'node:test';

import { formatPrettyLogLine } from './log.js';

test('formats issue logs as compact text', () => {
  const line = formatPrettyLogLine(
    'warn',
    'pr_conflict_queued',
    {
      repo_id: 'mdedit',
      tracker_kind: 'github',
      owner: 'mangoappstudio',
      repo: 'mdedit',
      event: 'pr_conflict_queued',
      issue_id: 'I_123',
      issue_number: 347,
      issue_identifier: 'mangoappstudio/mdedit#347',
      issue_url: 'https://github.test/mangoappstudio/mdedit/issues/347',
      pr_number: 358,
      head_ref: 'symphony-347-branch',
      merge_state_status: 'dirty',
    },
    false,
  );

  assert.match(line, /^\d{2}:\d{2}:\d{2} WARN  pr conflict queued /);
  assert.match(line, /repo=mdedit/);
  assert.match(line, /issue=mangoappstudio\/mdedit#347/);
  assert.match(line, /pr=#358/);
  assert.match(line, /merge=dirty/);
  assert.match(line, /head_ref=symphony-347-branch/);
  assert.doesNotMatch(line, /"message"/);
  assert.doesNotMatch(line, /tracker_kind/);
  assert.doesNotMatch(line, /issue_url/);
  assert.doesNotMatch(line, /event=/);
});

test('formats arrays and errors in preferred order', () => {
  const line = formatPrettyLogLine(
    'error',
    'conflict_resolution_dispatch_failed',
    {
      error: 'Hook exited with code 1',
      unmerged_files: ['packages/a.ts', 'packages/b.ts'],
      pr_number: 357,
    },
    false,
  );

  assert.match(
    line,
    /ERROR conflict resolution dispatch failed pr=#357 error=Hook exited with code 1 unmerged=packages\/a.ts,packages\/b.ts$/,
  );
});
