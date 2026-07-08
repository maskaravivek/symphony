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
      issue_title: 'Fix checkout hook output flooding the terminal',
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
  assert.match(line, /title=Fix checkout hook output flooding the terminal/);
  assert.match(line, /pr=#358/);
  assert.match(line, /merge=dirty/);
  assert.match(line, /head_ref=symphony-347-branch/);
  assert.doesNotMatch(line, /"message"/);
  assert.doesNotMatch(line, /tracker_kind/);
  assert.doesNotMatch(line, /issue_number/);
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

test('omits owner and repo when repo id is already displayed', () => {
  const line = formatPrettyLogLine(
    'warn',
    'pr_conflict_queued',
    {
      repo_id: 'mdedit',
      owner: 'mangoappstudio',
      repo: 'mdedit',
      issue_number: 347,
      pr_number: 358,
    },
    false,
  );

  assert.match(line, /repo=mdedit/);
  assert.match(line, /issue=347/);
  assert.doesNotMatch(line, /owner=mangoappstudio/);
  assert.doesNotMatch(line, / repo=mdedit .* repo=mdedit/);
});

test('truncates long issue titles and labels hook logs clearly', () => {
  const line = formatPrettyLogLine(
    'info',
    'workspace_before_run_hook_started',
    {
      issue_identifier: 'mangoappstudio/mdedit#554',
      issue_title: 'A very long issue title that would otherwise make every terminal log line hard to scan during long-running Symphony sessions',
      hook_log_path: '/Users/example/workspace/.symphony/hooks/2026-07-08T12-00-00-000Z-before_run.log',
    },
    false,
  );

  assert.match(line, /issue=mangoappstudio\/mdedit#554/);
  assert.match(line, /title=A very long issue title that would otherwise make every terminal log \.\.\./);
  assert.match(line, /hook_log=\/Users\/example\/workspace\/\.symphony\/hooks\/2026-07-08T12-00-00-000Z-before_run\.log/);
});
