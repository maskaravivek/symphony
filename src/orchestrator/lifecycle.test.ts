import assert from 'node:assert/strict';
import test from 'node:test';

import { hasNonQueueableLifecycleLabel } from './lifecycle.js';

test('paused and human-owned lifecycle labels are never queueable', () => {
  for (const label of ['needs-info', 'interactive', 'ready-for-human', 'blocked', 'symphony-failed']) {
    assert.equal(hasNonQueueableLifecycleLabel(['ready-for-agent', label]), true, label);
  }
  assert.equal(hasNonQueueableLifecycleLabel(['ready-for-agent', 'priority:p1']), false);
});
