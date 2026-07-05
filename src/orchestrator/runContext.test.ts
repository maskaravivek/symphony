import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildRunContext } from './runContext.js';

test('includes new PR review comments in run context', async () => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-run-context-'));
  const result = await buildRunContext({
    workspacePath,
    comments: [],
    lastSeenCommentId: null,
    pullRequestReviewComments: [
      {
        id: 10,
        body: 'old review note',
        url: null,
        author: 'reviewer',
        created_at: '2026-07-05T12:00:00Z',
        updated_at: '2026-07-05T12:00:00Z',
      },
      {
        id: 11,
        body: 'Please handle retry comments.',
        url: null,
        author: 'reviewer',
        created_at: '2026-07-05T12:05:00Z',
        updated_at: '2026-07-05T12:05:00Z',
      },
    ],
    lastSeenPullRequestReviewCommentId: 10,
    lastMessagePath: null,
  });

  assert.equal(result.lastSeenPullRequestReviewCommentId, 11);
  assert.match(result.text, /New PR review comments:/);
  assert.match(result.text, /Please handle retry comments\./);
  assert.doesNotMatch(result.text, /old review note/);
});
