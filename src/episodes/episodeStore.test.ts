import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { EpisodeStore } from './episodeStore.js';

test('persists append-only episode events across store instances', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-episodes-'));
  const databasePath = path.join(root, 'episodes.sqlite');

  const first = new EpisodeStore(databasePath);
  first.append({
    repo_id: 'mdedit',
    episode_id: 'mdedit#42:attempt:1',
    event: 'run_started',
    payload: { issue_number: 42, attempt: 1 },
  });
  first.append({
    repo_id: 'mdedit',
    episode_id: 'mdedit#42:attempt:1',
    event: 'run_completed',
    payload: { issue_number: 42, exit_code: 0 },
  });
  first.close();

  const reopened = new EpisodeStore(databasePath);
  const events = reopened.list({ repo_id: 'mdedit', episode_id: 'mdedit#42:attempt:1' });
  const latest = reopened.latest({ repo_id: 'mdedit', episode_id: 'mdedit#42:attempt:1' });
  reopened.close();

  assert.equal(events.length, 2);
  assert.equal(events[0]?.event, 'run_started');
  assert.deepEqual(events[0]?.payload, { issue_number: 42, attempt: 1 });
  assert.match(events[0]?.created_at ?? '', /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(latest?.event, 'run_completed');
});

test('deduplicates terminal session events by durable idempotency key', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-event-once-'));
  const store = new EpisodeStore(path.join(root, 'episodes.sqlite'));
  const input = { repo_id: 'mdedit', episode_id: 'mdedit#42:attempt:1', event: 'workflow.completed', payload: { session_id: 'session-1' } };
  assert.ok(store.appendOnce(input, 'mdedit#42:attempt:1:session-1:workflow-terminal'));
  assert.equal(store.appendOnce(input, 'mdedit#42:attempt:1:session-1:workflow-terminal'), null);
  assert.equal(store.list({ repo_id: 'mdedit', episode_id: input.episode_id }).length, 1);
  store.close();
});

test('persists retry queue entries across store instances and removes them explicitly', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-retries-'));
  const databasePath = path.join(root, 'episodes.sqlite');
  const first = new EpisodeStore(databasePath);
  first.upsertRetry({
    repo_id: 'mdedit',
    issue_id: 'I_42',
    issue_number: 42,
    issue_identifier: 'mangoappstudio/mdedit#42',
    attempt: 2,
    reason: 'after_run_failed',
    next_run_at: '2026-07-11T12:00:00.000Z',
    workspace_path: '/tmp/workspace',
    mode: 'autonomous',
  });
  first.close();

  const reopened = new EpisodeStore(databasePath);
  assert.deepEqual(reopened.listRetries('mdedit'), [
    {
      repo_id: 'mdedit',
      issue_id: 'I_42',
      issue_number: 42,
      issue_identifier: 'mangoappstudio/mdedit#42',
      attempt: 2,
      reason: 'after_run_failed',
      next_run_at: '2026-07-11T12:00:00.000Z',
      workspace_path: '/tmp/workspace',
      mode: 'autonomous',
    },
  ]);
  reopened.deleteRetry('mdedit', 'I_42');
  assert.deepEqual(reopened.listRetries('mdedit'), []);
  reopened.close();
});

test('upserts review claims and merge assessments by durable identity', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-dedup-'));
  const store = new EpisodeStore(path.join(root, 'episodes.sqlite'));
  const reviewKey = '646:head:base:policy:workflow:security';
  assert.equal(store.claimReview('mdedit', reviewKey, 'running'), true);
  assert.equal(store.claimReview('mdedit', reviewKey, 'running'), false);
  store.completeReviewClaim('mdedit', reviewKey, 'block');
  assert.equal(store.getReviewClaim('mdedit', reviewKey)?.status, 'block');
  assert.equal(store.getReviewClaim('mdedit', reviewKey)?.attempts, 1);

  const retryKey = '646:head:base:policy:workflow:retry';
  assert.equal(store.claimReview('mdedit', retryKey, 'running'), true);
  store.completeReviewClaim('mdedit', retryKey, 'error');
  assert.equal(store.claimReview('mdedit', retryKey, 'running'), true);
  store.completeReviewClaim('mdedit', retryKey, 'unavailable');
  assert.equal(store.claimReview('mdedit', retryKey, 'running'), true);
  store.completeReviewClaim('mdedit', retryKey, 'error');
  assert.equal(store.claimReview('mdedit', retryKey, 'running'), false);
  assert.equal(store.getReviewClaim('mdedit', retryKey)?.attempts, 3);

  store.upsertMergeAssessment({
    repo_id: 'mdedit',
    pr_number: 650,
    input_fingerprint: 'input-1',
    decision_fingerprint: 'decision-1',
    next_check_at: '2026-07-11T12:05:00.000Z',
  });
  assert.equal(store.getMergeAssessment('mdedit', 650)?.decision_fingerprint, 'decision-1');
  store.upsertMergeAssessment({ repo_id: 'mdedit', pr_number: 651, input_fingerprint: 'input-2', decision_fingerprint: 'decision-2', next_check_at: '2026-07-11T12:05:00.000Z' });
  store.clearMergeAssessmentsExcept('mdedit', [651]);
  assert.equal(store.getMergeAssessment('mdedit', 650), null);
  assert.equal(store.getMergeAssessment('mdedit', 651)?.decision_fingerprint, 'decision-2');
  store.close();
});
